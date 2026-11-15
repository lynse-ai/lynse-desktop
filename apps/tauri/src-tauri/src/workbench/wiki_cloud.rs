//! Cross-device wiki organize state sync (per-user cloud index).
//!
//! Push is diff-driven: the local payload hash of every published topic is
//! compared with the cloud manifest and the last acknowledged push, so
//! compile commits, external Markdown edits and deletions all reconcile
//! without dedicated call sites. Adoption checks the content contract and
//! identical per-source input keys, so an adopted topic passes the local
//! staleness gate without any model work. Payloads stay slim: no history,
//! candidate revisions, usage receipts or collection-link citation copies.

use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const TOPIC_SCHEMA: &str = "wiki-topic-v2";
const SOURCE_SCHEMA: &str = "wiki-source-v1";
const ADOPT_BUDGET: usize = 8;
const FLUSH_BUDGET: usize = 8;
const SOURCE_LOOKUP_BUDGET: usize = 10;
const SOURCE_LOOKUP_BATCH: usize = 20;
const DEFER_SECONDS: u64 = 300;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct QueuedWork {
    payload: Value,
    hash: String,
    delete: bool,
    attempts: u32,
    next_attempt: u64,
    error: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct SyncOutbox {
    pending: BTreeMap<String, QueuedWork>,
    sources: BTreeMap<String, QueuedWork>,
    delivered: BTreeMap<String, String>,
    merge_bases: BTreeMap<String, MergeBase>,
    published_grants: BTreeMap<String, Value>,
    delivered_sources: BTreeMap<String, String>,
    remote: BTreeMap<String, String>,
    remote_tombstones: BTreeSet<String>,
    deferred_adoptions: BTreeMap<String, u64>,
    adopted_sources: BTreeSet<String>,
    grant_version: Value,
    range_version: Value,
}

#[derive(Deserialize, Serialize)]
struct MergeBase {
    hash: String,
    markdown: String,
}

fn remember_base(outbox: &mut SyncOutbox, id: &str, payload: &Value) {
    if let Some((hash, markdown)) = payload["content_hash"]
        .as_str()
        .zip(payload["page"]["markdown"].as_str())
    {
        outbox.merge_bases.insert(
            id.into(),
            MergeBase {
                hash: hash.into(),
                markdown: markdown.into(),
            },
        );
    }
}

fn outbox_path(app: &AppHandle, session: &Session) -> CommandResult<std::path::PathBuf> {
    Ok(super::super::state_path(app, session)?.with_file_name("wiki-sync-outbox.json"))
}

fn read_outbox(path: &std::path::Path) -> CommandResult<SyncOutbox> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Wiki sync outbox is unreadable; original preserved".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SyncOutbox::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_outbox(path: &std::path::Path, outbox: &SyncOutbox) -> CommandResult<()> {
    write_json(path, outbox)
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn sync_allowed(manifest: &Manifest, capability: &Value) -> bool {
    manifest.enabled
        && manifest.wiki_automation.is_some()
        && capability["features"]["wiki_topic_conditional_write"] == true
        && manifest.knowledge_policy.as_ref().is_some_and(|policy| {
            policy["memory_consent"] == true && policy["local_text_consent"] == true
        })
}

async fn cloud_request(
    app: &AppHandle,
    session: &Session,
    path: &str,
    body: Option<Value>,
    operation: Option<&str>,
) -> CommandResult<Value> {
    knowledge_cloud::request(app, session, path, body, operation).await
}

/// Slim topic head: drop device-local processing state and collection-link
/// citation copies (member pages carry their own citations).
fn topic_head_value(topic: &Topic) -> CommandResult<Value> {
    let mut head = serde_json::to_value(topic).map_err(|error| error.to_string())?;
    let object = head
        .as_object_mut()
        .ok_or("Invalid Wiki topic serialization")?;
    for field in [
        "candidate",
        "history",
        "lastAttemptFingerprint",
        "forceRefresh",
        "error",
        "failure",
        "partialCompilation",
        "published",
        "lastFingerprint",
    ] {
        object.remove(field);
    }
    if let Some(links) = head
        .get_mut("collection")
        .and_then(|collection| collection.get_mut("links"))
        .and_then(Value::as_array_mut)
    {
        for link in links {
            if let Some(fields) = link.as_object_mut() {
                fields.remove("citations");
                fields.remove("events");
            }
        }
    }
    Ok(head)
}

fn payload_hash(head: &Value, page: &Value) -> String {
    let mut stable = content_cache::canonical(page);
    if let Some(fields) = stable.as_object_mut() {
        fields.remove("fingerprint");
    }
    store::digest(json!([head, stable]).to_string())
}

fn source_slice_hash(slice: &Value) -> String {
    store::digest(slice.to_string())
}

fn operation_id(kind: &str, hash: &str) -> String {
    format!("wiki-{kind}-{}", &hash[..hash.len().min(40)])
}

fn queue_topic(outbox: &mut SyncOutbox, id: &str, mut payload: Value, now: u64) {
    let hash = payload["content_hash"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if outbox.remote_tombstones.contains(id)
        || outbox
            .pending
            .get(id)
            .is_some_and(|work| work.delete || work.hash == hash)
    {
        return;
    }
    let base = outbox.delivered.get(id).cloned().unwrap_or_default();
    payload["base_content_hash"] = json!(base);
    payload["grant_version"] = outbox.grant_version.clone();
    payload["range_version"] = outbox.range_version.clone();
    outbox.pending.insert(
        id.into(),
        QueuedWork {
            hash,
            payload,
            next_attempt: now,
            ..Default::default()
        },
    );
}

/// Build the cloud payload for one published topic, or None when the topic
/// has nothing worth syncing (no published page, or sources unavailable so
/// another device could never validate the payload).
fn topic_payload(
    topic: &Topic,
    docs: &BTreeMap<String, Document>,
    config: &Models,
) -> CommandResult<Option<Value>> {
    let Some(page) = &topic.published else {
        return Ok(None);
    };
    if topic.excluded
        || page.partial
        || !matches!(page.review.as_str(), "approved" | "auto_validated")
        || page.content_hash != store::digest(&page.markdown)
    {
        return Ok(None);
    }
    let head = topic_head_value(topic)?;
    let mut source_ids: BTreeSet<_> = topic.source_ids.iter().cloned().collect();
    for reference in &page.citations {
        source_ids.insert(reference.id.clone());
    }
    let mut source_inputs = BTreeMap::new();
    for id in &source_ids {
        let Some(doc) = docs.get(id) else {
            return Ok(None);
        };
        source_inputs.insert(id.clone(), json!(automation::input_key(doc, config)));
    }
    if topic.collection.is_none() {
        let selected = topic
            .source_ids
            .iter()
            .filter_map(|id| {
                source_inputs
                    .get(id)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        if selected.is_empty()
            || page.cache_key
                != automation::page_version_keys(topic, selected, &config.text_revision)
        {
            return Ok(None);
        }
    }
    let page = serde_json::to_value(page).map_err(|error| error.to_string())?;
    let hash = payload_hash(&head, &page);
    Ok(Some(json!({
        "schema": TOPIC_SCHEMA,
        "topic_id": topic.id,
        "content_hash": hash,
        "text_revision": config.text_revision,
        "updated_at": crate::now(),
        "head": head,
        "page": page,
        "source_inputs": source_inputs,
    })))
}

fn validate_topic_payload(
    root: &Path,
    payload: &Value,
    docs: &BTreeMap<String, Document>,
    config: &Models,
    manifest: &Manifest,
) -> CommandResult<Option<(Topic, Revision)>> {
    if payload["schema"] != TOPIC_SCHEMA || payload["text_revision"] != config.text_revision {
        return Ok(None);
    }
    let inputs = payload["source_inputs"]
        .as_object()
        .ok_or("Invalid synced topic inputs")?;
    for (id, key) in inputs {
        let Some(expected) = key.as_str() else {
            return Ok(None);
        };
        let Some(doc) = docs.get(id) else {
            // Source not synchronized on this device yet; retry after sync.
            return Ok(None);
        };
        if automation::input_key(doc, config) != expected {
            // Same id but different content: keep the local organize instead.
            return Ok(None);
        }
    }
    let mut head: Topic =
        serde_json::from_value(payload["head"].clone()).map_err(|_| "Invalid synced topic head")?;
    let mut page: Revision =
        serde_json::from_value(payload["page"].clone()).map_err(|_| "Invalid synced topic page")?;
    if payload["content_hash"].as_str() != Some(&payload_hash(&payload["head"], &payload["page"])) {
        return Err("Synced topic payload hash mismatch".into());
    }
    if payload["topic_id"] != head.id || topic_store::deleted(root)?.contains(&head.id) {
        return Ok(None);
    }
    if page.content_hash != store::digest(&page.markdown)
        || !matches!(page.review.as_str(), "approved" | "auto_validated")
    {
        return Ok(None);
    }
    let selected = head
        .source_ids
        .iter()
        .filter_map(|id| docs.get(id).filter(|_| inputs.contains_key(id)))
        .cloned()
        .collect::<Vec<_>>();
    if selected.len() != head.source_ids.len() || inputs.is_empty() {
        return Ok(None);
    }
    let evidence = inputs
        .keys()
        .filter_map(|id| docs.get(id).cloned())
        .collect::<Vec<_>>();
    let Ok(rebound) = content_cache::rebind(payload["page"].clone(), &evidence, manifest) else {
        return Ok(None);
    };
    page = serde_json::from_value(rebound).map_err(|_| "Invalid synced evidence")?;
    if page.citations.is_empty() {
        return Ok(None);
    }
    if head.collection.is_none() {
        if selected.is_empty() {
            return Ok(None);
        }
        automation::adopt_page_identity(&mut head, &mut page, &selected, manifest, config)?;
    } else {
        page.fingerprint = page_fingerprint(&head, manifest, config, &page.citations);
    }
    Ok(Some((head, page)))
}

/// Adopt only after validating inputs and current authority on this device.
fn apply_topic_payload(
    root: &Path,
    payload: &Value,
    docs: &BTreeMap<String, Document>,
    config: &Models,
    manifest: &Manifest,
) -> CommandResult<bool> {
    let Some((mut head, page)) = validate_topic_payload(root, payload, docs, config, manifest)?
    else {
        return Ok(false);
    };
    let mut values = topics(root)?;
    match values
        .iter()
        .position(|topic| topic_store::matches_id(topic, &head.id))
    {
        Some(index) => {
            let current = &mut values[index];
            if current.id != head.id
                || current.force_refresh
                || current.candidate.is_some()
                || current
                    .published
                    .as_ref()
                    .is_some_and(|old| old.content_hash != store::digest(&old.markdown))
            {
                return Ok(false);
            }
            head.history = std::mem::take(&mut current.history);
            if let Some(previous) = current
                .published
                .take()
                .filter(|previous| previous.id != page.id)
            {
                head.history.push(previous);
            }
            head.published = Some(page.clone());
            *current = head.clone();
        }
        None => {
            head.published = Some(page.clone());
            values.push(head.clone());
        }
    }
    save_page(root, &head, &page, false)?;
    save_topics(root, &values)?;
    Ok(true)
}

async fn adopt_topics(
    app: &AppHandle,
    session: &Session,
    root: &Path,
    manifest: &Value,
    outbox: &mut SyncOutbox,
    config: &Models,
    docs: &BTreeMap<String, Document>,
) -> CommandResult<()> {
    let state = app.state::<WorkbenchState>();
    let now = now_seconds();
    let remote_tombstones: BTreeSet<String> = manifest["tombstones"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let cloud: BTreeMap<String, String> = manifest["topics"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some((
                row["id"].as_str()?.to_owned(),
                row["content_hash"].as_str().unwrap_or_default().to_owned(),
            ))
        })
        .collect();

    // Deletions propagate both ways: remote tombstones delete locally, local
    // tombstones queue a cloud delete.
    let local_deleted = topic_store::deleted(root)?;
    for id in remote_tombstones
        .iter()
        .filter(|id| !local_deleted.contains(*id))
    {
        {
            let _guard = state.serial.lock().await;
            require_current(&state, session)?;
            let mut values = topics(root)?;
            if values
                .iter()
                .any(|topic| topic_store::matches_id(topic, id))
            {
                topic_store::delete(root, &mut values, &json!({"id": id}))?;
                outbox.delivered.remove(id);
                outbox.remote.insert(id.clone(), String::new());
            }
        }
    }
    for id in local_deleted.difference(&remote_tombstones) {
        if outbox.remote_tombstones.contains(id)
            || outbox.pending.get(id).is_some_and(|queued| queued.delete)
        {
            continue;
        }
        outbox.pending.insert(
            id.clone(),
            QueuedWork {
                delete: true,
                next_attempt: now,
                ..Default::default()
            },
        );
    }
    outbox.remote_tombstones = remote_tombstones;

    // Adopt changed topics; queue pushes for topics that changed locally.
    let mut work_done = 0usize;
    for (id, cloud_hash) in &cloud {
        if outbox.remote_tombstones.contains(id) || local_deleted.contains(id) {
            continue;
        }
        let local_payload = {
            let _guard = state.serial.lock().await;
            require_current(&state, session)?;
            let values = topics(root)?;
            match values.iter().find(|topic| topic.id == *id) {
                Some(topic) => topic_payload(topic, docs, config)?,
                None => None,
            }
        };
        let local_hash = local_payload
            .as_ref()
            .and_then(|payload| payload["content_hash"].as_str())
            .unwrap_or_default();
        if !local_hash.is_empty() && local_hash == *cloud_hash {
            if let Some(payload) = &local_payload {
                remember_base(outbox, id, payload);
            }
            outbox.remote.insert(id.clone(), cloud_hash.clone());
            outbox.delivered.insert(id.clone(), local_hash.into());
            outbox
                .published_grants
                .insert(id.clone(), outbox.grant_version.clone());
            outbox.deferred_adoptions.remove(id);
            continue;
        }
        if !local_hash.is_empty()
            && outbox.delivered.get(id).map(String::as_str) != Some(local_hash)
        {
            // Local edits win until they are acknowledged; keep the push lane.
            {
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                let values = topics(root)?;
                if let Some(topic) = values.iter().find(|topic| topic.id == *id) {
                    if let Some(payload) = topic_payload(topic, docs, config)? {
                        queue_topic(outbox, id, payload, now);
                    }
                }
            }
            continue;
        }
        if outbox
            .deferred_adoptions
            .get(id)
            .is_some_and(|until| *until > now)
        {
            continue;
        }
        if work_done >= ADOPT_BUDGET {
            continue;
        }
        let payload =
            match cloud_request(app, session, &format!("/wiki-topics/{id}"), None, None).await {
                Ok(value) => value["topic"].clone(),
                Err(error) => {
                    if knowledge_cloud::stops_dispatch(&error) {
                        return Err(error);
                    }
                    outbox
                        .deferred_adoptions
                        .insert(id.clone(), now + DEFER_SECONDS);
                    continue;
                }
            };
        if payload.is_null() {
            // Deleted in between; the next manifest reports the tombstone.
            continue;
        }
        {
            let _guard = state.serial.lock().await;
            require_current(&state, session)?;
            let current_manifest = load_state(app, session)?;
            let current_docs = automation::documents(&roots(app, session)?.0, &current_manifest)
                .into_iter()
                .filter(|doc| !crate::inspiration_private::source_is_protected(app, &doc.id))
                .map(|doc| (doc.id.clone(), doc))
                .collect();
            let current_hash = topics(root)?
                .iter()
                .find(|topic| topic.id == *id)
                .map(|topic| topic_payload(topic, &current_docs, config))
                .transpose()?
                .flatten()
                .and_then(|body| body["content_hash"].as_str().map(str::to_owned))
                .unwrap_or_default();
            if current_hash != local_hash {
                continue;
            }
            match apply_topic_payload(root, &payload, &current_docs, config, &current_manifest) {
                Ok(true) => {
                    remember_base(outbox, id, &payload);
                    let hash = payload["content_hash"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned();
                    outbox.remote.insert(id.clone(), hash.clone());
                    outbox.delivered.insert(id.clone(), hash);
                    outbox
                        .published_grants
                        .insert(id.clone(), outbox.grant_version.clone());
                    outbox.pending.remove(id);
                    outbox.deferred_adoptions.remove(id);
                    work_done += 1;
                }
                Ok(false) => {
                    outbox
                        .deferred_adoptions
                        .insert(id.clone(), now + DEFER_SECONDS);
                }
                Err(error) => {
                    log::warn!("Wiki topic {id} adoption failed: {error}");
                    outbox
                        .deferred_adoptions
                        .insert(id.clone(), now + DEFER_SECONDS);
                }
            }
        }
    }
    Ok(())
}

async fn adopt_sources(
    app: &AppHandle,
    session: &Session,
    root: &Path,
    outbox: &mut SyncOutbox,
    needed: &[String],
) -> CommandResult<()> {
    let mut pending: std::collections::VecDeque<String> = needed.iter().cloned().collect();
    let mut requests = 0usize;
    while !pending.is_empty() && requests < SOURCE_LOOKUP_BUDGET {
        let batch: Vec<String> = pending
            .drain(..pending.len().min(SOURCE_LOOKUP_BATCH))
            .collect();
        requests += 1;
        let value = match cloud_request(
            app,
            session,
            "/wiki-sources/lookup",
            Some(json!({"source_ids": batch})),
            None,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                if knowledge_cloud::stops_dispatch(&error) {
                    return Err(error);
                }
                continue;
            }
        };
        for (id, slice) in value["sources"].as_object().into_iter().flatten() {
            {
                let state = app.state::<WorkbenchState>();
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                match automation::merge_catalog_state(root, &slice["chunks"], &slice["identities"])
                {
                    Ok(_) => {
                        outbox.adopted_sources.insert(id.clone());
                        outbox
                            .delivered_sources
                            .insert(id.clone(), source_slice_hash(slice));
                    }
                    Err(error) => log::warn!("Wiki source {id} adoption failed: {error}"),
                }
            }
        }
    }
    Ok(())
}

async fn flush_pending(
    app: &AppHandle,
    session: &Session,
    path: &std::path::Path,
) -> CommandResult<bool> {
    let now = now_seconds();
    let work: Vec<(String, QueuedWork)> = {
        let outbox = read_outbox(path)?;
        outbox
            .pending
            .iter()
            .filter(|(_, queued)| queued.next_attempt <= now)
            .take(FLUSH_BUDGET * 2)
            .map(|(id, queued)| (id.clone(), queued.clone()))
            .collect()
    };
    for (id, queued) in work {
        let hash = queued.hash.clone();
        let result = if queued.delete {
            cloud_request(
                app,
                session,
                &format!("/wiki-topics/{id}/delete"),
                Some(json!({})),
                Some(&operation_id("delete", &id)),
            )
            .await
        } else {
            cloud_request(
                app,
                session,
                &format!("/wiki-topics/{id}"),
                Some(queued.payload.clone()),
                Some(&operation_id(
                    "topic",
                    &store::digest(
                        json!([
                            id,
                            hash,
                            queued.payload["base_content_hash"],
                            queued.payload["grant_version"],
                            queued.payload["range_version"]
                        ])
                        .to_string(),
                    ),
                )),
            )
            .await
        };
        let conflicted = result
            .as_ref()
            .is_err_and(|error| error == "Wiki topic has conflicting edits");
        match result {
            Ok(_) => {
                let state = app.state::<WorkbenchState>();
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                let mut outbox = read_outbox(path)?;
                if queued.delete {
                    outbox.delivered.remove(&id);
                    outbox.merge_bases.remove(&id);
                    outbox.published_grants.remove(&id);
                } else {
                    remember_base(&mut outbox, &id, &queued.payload);
                    outbox.delivered.insert(id.clone(), hash.clone());
                    outbox.remote.insert(id.clone(), hash.clone());
                    outbox
                        .published_grants
                        .insert(id.clone(), queued.payload["grant_version"].clone());
                }
                if outbox
                    .pending
                    .get(&id)
                    .is_some_and(|item| item.hash == hash)
                {
                    outbox.pending.remove(&id);
                }
                write_outbox(path, &outbox)?;
            }
            Err(error) => {
                let stop = knowledge_cloud::stops_dispatch(&error);
                let state = app.state::<WorkbenchState>();
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                let mut outbox = read_outbox(path)?;
                if let Some(item) = outbox.pending.get_mut(&id).filter(|item| item.hash == hash) {
                    item.attempts = item.attempts.saturating_add(1);
                    item.next_attempt = if conflicted {
                        // A concurrent edit requires resolution against the saved base.
                        u64::MAX
                    } else {
                        now_seconds() + 30 * (1_u64 << item.attempts.min(5))
                    };
                    item.error = error.clone();
                }
                write_outbox(path, &outbox)?;
                if conflicted {
                    let manifest = load_state(app, session)?;
                    persist(app, session, &manifest)?;
                }
                drop(_guard);
                if stop {
                    return Err(error);
                }
            }
        }
    }
    let now = now_seconds();
    Ok(read_outbox(path)?
        .pending
        .values()
        .any(|queued| queued.next_attempt <= now))
}

pub(in crate::workbench) fn conflicts(
    app: &AppHandle,
    session: &Session,
) -> CommandResult<Vec<String>> {
    Ok(read_outbox(&outbox_path(app, session)?)?
        .pending
        .into_iter()
        .filter_map(|(id, work)| (work.next_attempt == u64::MAX).then_some(id))
        .collect())
}

fn changed_lines<'a>(base: &[&str], branch: &[&'a str]) -> (std::ops::Range<usize>, Vec<&'a str>) {
    let start = base.iter().zip(branch).take_while(|(a, b)| a == b).count();
    let tail = base[start..]
        .iter()
        .rev()
        .zip(branch[start..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    (
        start..base.len() - tail,
        branch[start..branch.len() - tail].to_vec(),
    )
}

fn suggest_merge(base: &str, local: &str, cloud: &str) -> Option<String> {
    if local == cloud || cloud == base {
        return Some(local.into());
    }
    if local == base {
        return Some(cloud.into());
    }
    let mut lines: Vec<_> = base.split('\n').collect();
    let local: Vec<_> = local.split('\n').collect();
    let cloud: Vec<_> = cloud.split('\n').collect();
    let (first, second) = {
        let a = changed_lines(&lines, &local);
        let b = changed_lines(&lines, &cloud);
        if a.0.start < b.0.start {
            (a, b)
        } else {
            (b, a)
        }
    };
    if first.0.start == second.0.start || first.0.end > second.0.start {
        return None;
    }
    lines.splice(second.0, second.1);
    lines.splice(first.0, first.1);
    Some(lines.join("\n"))
}

fn merge_topic_pages(
    local: &Topic,
    cloud: &Topic,
    cloud_page: &Revision,
    markdown: &str,
    take_cloud_details: bool,
    docs: &BTreeMap<String, Document>,
    manifest: &Manifest,
    config: &Models,
) -> CommandResult<(Topic, Revision)> {
    let local_page = local.published.as_ref().ok_or("The local page changed")?;
    let mut topic = if take_cloud_details {
        cloud.clone()
    } else {
        local.clone()
    };
    let ids: BTreeSet<_> = local
        .source_ids
        .iter()
        .chain(&cloud.source_ids)
        .cloned()
        .collect();
    topic.source_ids = ids.into_iter().collect();
    let selected: Vec<_> = topic
        .source_ids
        .iter()
        .filter_map(|id| docs.get(id))
        .cloned()
        .collect();
    if selected.len() != topic.source_ids.len() || selected.is_empty() {
        return Err("Sync all authorized sources before merging this topic".into());
    }
    let mut citations = Vec::new();
    let mut keys = BTreeSet::new();
    for reference in local_page.citations.iter().chain(&cloud_page.citations) {
        if keys.insert((&reference.id, &reference.kind, &reference.quote)) {
            citations.push(reference.clone());
        }
    }
    let (preferred, alternate) = if take_cloud_details {
        (cloud_page, local_page)
    } else {
        (local_page, cloud_page)
    };
    let mut sections = Vec::new();
    for doc in &selected {
        let key = automation::section_source_key(&topic, doc, config);
        let primary: Vec<_> = preferred
            .sections
            .iter()
            .filter(|section| section.source_key == key)
            .cloned()
            .collect();
        if primary.is_empty() {
            sections.extend(
                alternate
                    .sections
                    .iter()
                    .filter(|section| section.source_key == key)
                    .cloned(),
            );
        } else {
            sections.extend(primary);
        }
    }
    let mut change_ids = BTreeSet::new();
    let changes: Vec<_> = preferred
        .changes
        .iter()
        .chain(&alternate.changes)
        .filter(|change| change_ids.insert(&change.id))
        .cloned()
        .collect();
    let cache_key = automation::page_version_keys(
        &topic,
        selected
            .iter()
            .map(|doc| automation::input_key(doc, config))
            .collect(),
        &config.text_revision,
    );
    // Keep valid source work separate from the user's merged Markdown.
    let page = Revision {
        id: uuid::Uuid::new_v4().to_string(),
        markdown: markdown.to_owned(),
        content_hash: store::digest(markdown),
        overview: preferred.overview.clone(),
        citations,
        changes,
        sections,
        cache_key,
        review: "approved".into(),
        created_at: crate::now(),
        reviewed_at: crate::now(),
        ..Default::default()
    };
    let evidence = docs.values().cloned().collect::<Vec<_>>();
    let rebound = content_cache::rebind(json!(page), &evidence, manifest)?;
    let mut page: Revision =
        serde_json::from_value(rebound).map_err(|_| "Invalid merged evidence")?;
    automation::adopt_page_identity(&mut topic, &mut page, &selected, manifest, config)?;
    Ok((topic, page))
}

/// Read both heads against the latest policy. A resolution freezes both
/// hashes and queues a conditional write against the cloud head shown here.
pub(super) async fn conflict_action(
    app: &AppHandle,
    session: &Session,
    request: &Value,
) -> CommandResult<Value> {
    let id = request["id"].as_str().ok_or("A topic is required")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid Wiki topic ID")?;
    let state = app.state::<WorkbenchState>();
    let _flight = state.wiki_cloud_run.lock().await;
    let capability = knowledge_cloud::refresh_capabilities(app, session).await?;
    let payload = cloud_request(app, session, &format!("/wiki-topics/{id}"), None, None).await?;
    let payload = &payload["topic"];
    let remote_hash = payload["content_hash"]
        .as_str()
        .ok_or("The cloud topic is no longer available")?;
    let root = wiki_root(app, session)?;
    let local_root = roots(app, session)?.0;
    let mut input_ids = BTreeSet::new();
    if let Some(inputs) = payload["source_inputs"].as_object() {
        input_ids.extend(inputs.keys().cloned());
    }
    if let Some(local) = topics(&root)?.into_iter().find(|topic| topic.id == id) {
        input_ids.extend(local.source_ids);
        if let Some(page) = local.published {
            input_ids.extend(page.citations.into_iter().map(|reference| reference.id));
        }
    }
    let snapshot = load_state(app, session)?;
    let shared: Vec<_> = automation::documents(&local_root, &snapshot)
        .into_iter()
        .filter(|doc| input_ids.contains(&doc.id) && cloud_meeting(doc))
        .collect();
    for batch in shared.chunks(200) {
        knowledge_cloud::authorize(app, session, batch, "wiki_compile").await?;
    }
    let checked: BTreeMap<_, _> = shared
        .into_iter()
        .map(|doc| (doc.id, doc.revision))
        .collect();

    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    let manifest = load_state(app, session)?;
    ready(&manifest)?;
    if !sync_allowed(&manifest, &capability) {
        return Err("Wiki sync authorization is unavailable".into());
    }
    let config = models(app, session)?;
    let docs: BTreeMap<_, _> = automation::documents(&local_root, &manifest)
        .into_iter()
        .filter(|doc| !crate::inspiration_private::source_is_protected(app, &doc.id))
        .filter(|doc| !cloud_meeting(doc) || checked.get(&doc.id) == Some(&doc.revision))
        .map(|doc| (doc.id.clone(), doc))
        .collect();
    let (cloud, cloud_page) = validate_topic_payload(&root, payload, &docs, &config, &manifest)?
        .ok_or("Sync the current authorized sources to compare the cloud topic")?;

    let path = outbox_path(app, session)?;
    let mut outbox = read_outbox(&path)?;
    let queued = outbox
        .pending
        .get(id)
        .filter(|work| work.next_attempt == u64::MAX && !work.delete)
        .ok_or("This topic has no unresolved sync conflict")?;
    let mut values = topics(&root)?;
    let current = values
        .iter_mut()
        .find(|topic| topic.id == id)
        .ok_or("The local topic is no longer available")?;
    let local_payload = topic_payload(current, &docs, &config)?
        .ok_or("The local topic must have a current, authorized published revision")?;
    let local_hash = local_payload["content_hash"]
        .as_str()
        .ok_or("The local page changed")?;
    let (_, local_page) = validate_topic_payload(&root, &local_payload, &docs, &config, &manifest)?
        .ok_or("The local page contains unavailable evidence")?;

    if request["action"] == "sync_conflict_preview" {
        let suggestion = outbox
            .merge_bases
            .get(id)
            .filter(|base| queued.payload["base_content_hash"] == base.hash)
            .and_then(|base| {
                suggest_merge(&base.markdown, &local_page.markdown, &cloud_page.markdown)
            });
        return Ok(json!({"syncConflict": {
            "localVersion": local_hash, "cloudVersion": remote_hash,
            "local": {"title": current.title, "purpose": current.purpose, "notes": current.notes, "markdown": local_page.markdown},
            "cloud": {"title": cloud.title, "purpose": cloud.purpose, "notes": cloud.notes, "markdown": cloud_page.markdown},
            "suggestedMarkdown": suggestion,
            "canMerge": current.collection.is_none() && cloud.collection.is_none()
        }}));
    }
    verify_conflict_versions(request, local_hash, remote_hash)?;
    let (mut resolved, page) = match request["choice"].as_str() {
        Some("local") => (current.clone(), local_page.clone()),
        Some("cloud") => (cloud, cloud_page.clone()),
        Some("merge") if current.collection.is_none() && cloud.collection.is_none() => {
            let markdown = request["markdown"]
                .as_str()
                .filter(|text| !text.trim().is_empty() && text.chars().count() <= 200_000)
                .ok_or("Enter the merged page text")?;
            merge_topic_pages(
                current,
                &cloud,
                &cloud_page,
                markdown,
                request["details"] == "cloud",
                &docs,
                &manifest,
                &config,
            )?
        }
        _ => return Err("Choose how to resolve the Wiki conflict".into()),
    };
    resolve_page_history(current, &mut resolved, &page, &cloud_page);
    save_page(&root, &resolved, &page, false)?;
    resolved.published = Some(page);
    *current = resolved;
    save_topics(&root, &values)?;

    outbox.pending.remove(id);
    outbox.deferred_adoptions.remove(id);
    outbox.remote.insert(id.into(), remote_hash.into());
    outbox.delivered.insert(id.into(), remote_hash.into());
    remember_base(&mut outbox, id, payload);
    write_outbox(&path, &outbox)?;
    state.cloud_wakeup.notify_one();
    persist(app, session, &manifest)?;
    Ok(json!({}))
}

fn cloud_meeting(doc: &Document) -> bool {
    matches!(doc.kind.as_str(), "meeting" | "meeting_summary") && !doc.id.starts_with("local:")
}

fn verify_conflict_versions(request: &Value, local: &str, cloud: &str) -> CommandResult<()> {
    if request["localVersion"] == local && request["cloudVersion"] == cloud {
        Ok(())
    } else {
        Err("A topic version changed; reopen the comparison".into())
    }
}

fn resolve_page_history(
    current: &Topic,
    resolved: &mut Topic,
    page: &Revision,
    cloud_page: &Revision,
) {
    resolved.history = current.history.clone();
    let archived_candidate = if resolved.candidate.is_none() {
        current.candidate.as_ref()
    } else {
        None
    };
    for branch in current
        .published
        .iter()
        .chain(std::iter::once(cloud_page))
        .chain(archived_candidate)
    {
        if branch.id != page.id && !resolved.history.iter().any(|old| old.id == branch.id) {
            resolved.history.push(branch.clone());
        }
    }
}

async fn flush_sources(
    app: &AppHandle,
    session: &Session,
    path: &std::path::Path,
) -> CommandResult<bool> {
    let now = now_seconds();
    let work: Vec<(String, QueuedWork)> = {
        let outbox = read_outbox(path)?;
        outbox
            .sources
            .iter()
            .filter(|(_, queued)| queued.next_attempt <= now)
            .take(FLUSH_BUDGET)
            .map(|(id, queued)| (id.clone(), queued.clone()))
            .collect()
    };
    for (id, queued) in work {
        let hash = queued.hash.clone();
        let result = cloud_request(
            app,
            session,
            &format!("/wiki-sources/{id}"),
            Some(queued.payload.clone()),
            Some(&operation_id(
                "source",
                &store::digest(
                    json!([
                        id,
                        hash,
                        queued.payload["grant_version"],
                        queued.payload["range_version"]
                    ])
                    .to_string(),
                ),
            )),
        )
        .await;
        match result {
            Ok(_) => {
                let state = app.state::<WorkbenchState>();
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                let mut outbox = read_outbox(path)?;
                outbox.delivered_sources.insert(id.clone(), hash.clone());
                if outbox
                    .sources
                    .get(&id)
                    .is_some_and(|item| item.hash == hash)
                {
                    outbox.sources.remove(&id);
                }
                write_outbox(path, &outbox)?;
            }
            Err(error) => {
                let stop = knowledge_cloud::stops_dispatch(&error);
                let state = app.state::<WorkbenchState>();
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                let mut outbox = read_outbox(path)?;
                if let Some(item) = outbox.sources.get_mut(&id) {
                    item.attempts = item.attempts.saturating_add(1);
                    item.next_attempt = now_seconds() + 30 * (1_u64 << item.attempts.min(5));
                    item.error = error.clone();
                }
                write_outbox(path, &outbox)?;
                drop(_guard);
                if stop {
                    return Err(error);
                }
            }
        }
    }
    let now = now_seconds();
    Ok(read_outbox(path)?
        .sources
        .values()
        .any(|queued| queued.next_attempt <= now))
}

/// One reconcile pass: adopt cloud state, then queue and flush local changes.
/// Returns true when more work remains (the caller retries sooner).
pub(in crate::workbench) async fn background(
    app: &AppHandle,
    session: &Session,
) -> CommandResult<bool> {
    let state = app.state::<WorkbenchState>();
    let _flight = state.wiki_cloud_run.lock().await;
    require_current(&state, session)?;
    let capability = knowledge_cloud::refresh_capabilities(app, session).await?;
    let (root, _) = roots(app, session)?;
    let wiki_root = crate::vault::vault_user_dir(app)?
        .map(|dir| dir.join("Memory").join(&session.scope).join("wiki"))
        .ok_or("No vault folder is configured")?;
    let path = outbox_path(app, session)?;
    let (config, docs_map) = {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let manifest = load_state(app, session)?;
        if !sync_allowed(&manifest, &capability) || ready(&manifest).is_err() {
            return Ok(false);
        }
        let config = models(app, session)?;
        let docs = automation::documents(&root, &manifest);
        let docs_map: BTreeMap<_, _> = docs
            .into_iter()
            .filter(|doc| !crate::inspiration_private::source_is_protected(app, &doc.id))
            .map(|doc| (doc.id.clone(), doc))
            .collect();
        (config, docs_map)
    };

    let cloud_manifest = cloud_request(app, session, "/wiki-topics", None, None).await?;
    {
        let mut outbox = read_outbox(&path)?;
        let grant = capability["policy"]["grant_version"].clone();
        let range = capability["policy"]["range_version"].clone();
        if outbox.grant_version != grant || outbox.range_version != range {
            outbox.grant_version = grant;
            outbox.range_version = range;
            outbox.delivered_sources.clear();
            outbox.adopted_sources.clear();
            outbox.sources.clear();
            outbox.pending.retain(|_, work| work.delete);
        }
        adopt_topics(
            app,
            session,
            &wiki_root,
            &cloud_manifest,
            &mut outbox,
            &config,
            &docs_map,
        )
        .await?;
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        write_outbox(&path, &outbox)?;
    }

    // Cache slices can also settle a source whose topic has not been published yet.
    let needed: Vec<String> = {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let outbox = read_outbox(&path)?;
        docs_map
            .keys()
            .filter(|id| {
                !outbox.adopted_sources.contains(*id) && !outbox.delivered_sources.contains_key(*id)
            })
            .cloned()
            .collect()
    };
    if !needed.is_empty() {
        let mut outbox = read_outbox(&path)?;
        adopt_sources(app, session, &wiki_root, &mut outbox, &needed).await?;
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        write_outbox(&path, &outbox)?;
    }

    // Queue pushes: topics and source slices whose local payload differs from
    // both the cloud state and the last acknowledged push.
    {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let mut outbox = read_outbox(&path)?;
        let now = now_seconds();
        let values = if wiki_root.exists() {
            topics(&wiki_root)?
        } else {
            Vec::new()
        };
        let current_manifest = load_state(app, session)?;
        if !sync_allowed(&current_manifest, &capability) || ready(&current_manifest).is_err() {
            return Ok(false);
        }
        let docs_map: BTreeMap<_, _> = automation::documents(&root, &current_manifest)
            .into_iter()
            .filter(|doc| !crate::inspiration_private::source_is_protected(app, &doc.id))
            .map(|doc| (doc.id.clone(), doc))
            .collect();
        for topic in &values {
            let Some(payload) = topic_payload(topic, &docs_map, &config)? else {
                if outbox
                    .pending
                    .get(&topic.id)
                    .is_some_and(|work| !work.delete)
                {
                    outbox.pending.remove(&topic.id);
                }
                continue;
            };
            let hash = payload["content_hash"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let current_grant =
                outbox.published_grants.get(&topic.id) == Some(&outbox.grant_version);
            if outbox.remote.get(&topic.id) == Some(&hash)
                && outbox.delivered.get(&topic.id) == Some(&hash)
                && current_grant
            {
                outbox.deferred_adoptions.remove(&topic.id);
                continue;
            }
            if outbox.delivered.get(&topic.id) != Some(&hash) || !current_grant {
                queue_topic(&mut outbox, &topic.id, payload, now);
            } else if outbox
                .pending
                .get(&topic.id)
                .is_some_and(|work| !work.delete)
            {
                outbox.pending.remove(&topic.id);
            }
        }
        let docs: Vec<Document> = docs_map.values().cloned().collect();
        let slices = automation::source_catalog_slices(&wiki_root, &docs, &config)?;
        outbox.sources.retain(|id, _| slices.contains_key(id));
        for (id, slice) in slices {
            let hash = source_slice_hash(&slice);
            if outbox.delivered_sources.get(&id) != Some(&hash)
                && !outbox
                    .sources
                    .get(&id)
                    .is_some_and(|item| item.hash == hash)
            {
                outbox.sources.insert(
                    id.clone(),
                    QueuedWork {
                        hash: hash.clone(),
                        payload: json!({
                            "schema": SOURCE_SCHEMA,
                            "source_id": id,
                            "chunks": slice["chunks"],
                            "identities": slice["identities"],
                            "grant_version": outbox.grant_version,
                            "range_version": outbox.range_version,
                        }),
                        next_attempt: now,
                        ..Default::default()
                    },
                );
            }
        }
        write_outbox(&path, &outbox)?;
    }

    let topics_pending = flush_pending(app, session, &path).await?;
    let sources_pending = flush_sources(app, session, &path).await?;
    if topics_pending || sources_pending {
        super::super::request_wiki(&state);
    }
    Ok(topics_pending || sources_pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_suggestions_combine_independent_edits_and_leave_overlap_for_review() {
        let base = "# Release\n\nScope: draft\n\nDate: Friday";
        let local = "# Release\n\nScope: approved\n\nDate: Friday";
        let cloud = "# Release\n\nScope: draft\n\nDate: Monday";
        assert_eq!(
            suggest_merge(base, local, cloud).as_deref(),
            Some("# Release\n\nScope: approved\n\nDate: Monday")
        );
        assert_eq!(
            suggest_merge(base, local, "# Release\n\nScope: cancelled\n\nDate: Friday"),
            None
        );
    }

    #[test]
    fn merge_rechecks_both_version_hashes_and_archives_each_branch() {
        let request = json!({"localVersion":"local-1","cloudVersion":"cloud-1"});
        assert!(verify_conflict_versions(&request, "local-1", "cloud-1").is_ok());
        assert!(verify_conflict_versions(&request, "local-2", "cloud-1").is_err());
        assert!(verify_conflict_versions(&request, "local-1", "cloud-2").is_err());

        let revision = |id: &str| Revision {
            id: id.into(),
            ..Default::default()
        };
        let local = Topic {
            published: Some(revision("local")),
            candidate: Some(revision("draft")),
            history: vec![revision("base")],
            ..Default::default()
        };
        let mut resolved = Topic::default();
        resolve_page_history(
            &local,
            &mut resolved,
            &revision("merged"),
            &revision("cloud"),
        );
        assert_eq!(
            resolved
                .history
                .iter()
                .map(|page| page.id.as_str())
                .collect::<Vec<_>>(),
            vec!["base", "local", "cloud", "draft"]
        );
    }

    #[test]
    fn a_conflict_resolution_queues_against_the_cloud_revision_shown_at_preview() {
        let mut outbox = SyncOutbox::default();
        let cloud = json!({"content_hash":"remote","page":{"markdown":"cloud current"}});
        remember_base(&mut outbox, "topic", &cloud);
        outbox.delivered.insert("topic".into(), "remote".into());
        queue_topic(&mut outbox, "topic", json!({"content_hash":"merged"}), 5);
        assert_eq!(
            outbox.pending["topic"].payload["base_content_hash"],
            "remote"
        );
        assert_eq!(outbox.merge_bases["topic"].markdown, "cloud current");
    }

    #[test]
    fn merged_revision_keeps_each_authorized_sources_reusable_sections() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let config = Models::default();
        let mut manifest = Manifest::default();
        let mut docs = BTreeMap::new();
        let mut branches = Vec::new();
        for id in ["one", "two"] {
            let mut doc = Document {
                id: id.into(),
                kind: "meeting".into(),
                transcript: format!("Evidence {id}"),
                ai_context_enabled: true,
                ..Default::default()
            };
            doc.refresh_revision();
            manifest
                .entries
                .insert(id.into(), store::write_document(&root, &doc, None).unwrap());
            let mut topic = Topic {
                id: "same-topic".into(),
                title: "Release".into(),
                source_ids: vec![id.into()],
                ..Default::default()
            };
            let citation = SourceRef {
                quote: doc.transcript.clone(),
                ..doc.reference()
            };
            topic.published = Some(Revision {
                citations: vec![citation.clone()],
                sections: vec![WikiSection {
                    key: id.into(),
                    source_key: automation::section_source_key(&topic, &doc, &config),
                    citations: vec![citation],
                    ..Default::default()
                }],
                ..Default::default()
            });
            branches.push(topic);
            docs.insert(id.into(), doc);
        }
        let cloud_page = branches[1].published.as_ref().unwrap();
        let (topic, page) = merge_topic_pages(
            &branches[0],
            &branches[1],
            cloud_page,
            "# Release\n\nMerged.",
            false,
            &docs,
            &manifest,
            &config,
        )
        .unwrap();
        assert_eq!(topic.source_ids, vec!["one", "two"]);
        assert_eq!(
            page.sections
                .iter()
                .map(|section| section.key.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        assert_eq!(page.citations.len(), 2);
        assert_eq!(page.review, "approved");
        manifest.entries.get_mut("two").unwrap().excluded = true;
        assert!(merge_topic_pages(
            &branches[0],
            &branches[1],
            cloud_page,
            "Merged.",
            false,
            &docs,
            &manifest,
            &config,
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_second_device_reuses_synced_sections_and_rebinds_changed_source_metadata() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let local = root.join("sources");
        let wiki = root.join("wiki");
        let config = Models::default();
        let mut source = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            title: "Release".into(),
            transcript: "Friday remains a proposal.".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        source.refresh_revision();
        let mut topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Release".into(),
            source_ids: vec![source.id.clone()],
            ..Default::default()
        };
        let quote = SourceRef {
            quote: source.transcript.clone(),
            ..source.reference()
        };
        let markdown = "# Release\n\nFriday remains a proposal.";
        topic.published = Some(Revision {
            id: uuid::Uuid::new_v4().to_string(),
            content_hash: store::digest(markdown),
            markdown: markdown.into(),
            review: "auto_validated".into(),
            citations: vec![quote.clone()],
            cache_key: automation::page_version_keys(
                &topic,
                vec![automation::input_key(&source, &config)],
                &config.text_revision,
            ),
            sections: vec![WikiSection {
                key: "release-friday".into(),
                source_key: "meeting-current".into(),
                body: "Friday remains a proposal.".into(),
                citations: vec![quote],
                ..Default::default()
            }],
            ..Default::default()
        });
        let origin = BTreeMap::from([(source.id.clone(), source.clone())]);
        let payload = topic_payload(&topic, &origin, &config).unwrap().unwrap();
        source.folder_id = "other-allowed-folder".into();
        source.refresh_revision();
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            source.id.clone(),
            store::write_document(&local, &source, None).unwrap(),
        );
        let receiver = BTreeMap::from([(source.id.clone(), source.clone())]);
        assert!(apply_topic_payload(&wiki, &payload, &receiver, &config, &manifest).unwrap());
        let adopted = topics(&wiki).unwrap().remove(0);
        let page = adopted.published.as_ref().unwrap();
        assert_eq!(adopted.last_fingerprint, page.cache_key);
        assert_eq!(page.id, topic.published.unwrap().id);
        assert_eq!(page.sections[0].citations[0].revision, source.revision);
        assert_eq!(
            topic_payload(&adopted, &receiver, &config)
                .unwrap()
                .unwrap()["content_hash"],
            payload["content_hash"]
        );
        assert!(citable(&adopted, &local, &manifest, &config));
        fs::remove_dir_all(root).unwrap();
    }
}
