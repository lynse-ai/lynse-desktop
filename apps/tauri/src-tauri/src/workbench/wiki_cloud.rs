//! Cross-device wiki organize state sync (per-user cloud index).
//!
//! Push is diff-driven: the local payload hash of every published topic is
//! compared with the cloud manifest and the last acknowledged push, so
//! compile commits, external Markdown edits and deletions all reconcile
//! without dedicated call sites. Adoption is strict (same text revision and
//! identical per-source input keys), so an adopted topic passes the local
//! staleness gate without any model work. Payloads stay slim: no history,
//! candidate revisions, usage receipts or collection-link citation copies.

use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const TOPIC_SCHEMA: &str = "wiki-topic-v1";
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
    delivered_sources: BTreeMap<String, String>,
    remote: BTreeMap<String, String>,
    remote_tombstones: BTreeSet<String>,
    deferred_adoptions: BTreeMap<String, u64>,
    adopted_sources: BTreeSet<String>,
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
    crate::atomic_write(
        path,
        &serde_json::to_vec_pretty(outbox).map_err(|error| error.to_string())?,
    )
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
        && capability["features"]["wiki_topic_sync"] == true
        && manifest
            .knowledge_policy
            .as_ref()
            .is_some_and(|policy| {
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
    store::digest(json!([head, page]).to_string())
}

fn source_slice_hash(slice: &Value) -> String {
    store::digest(slice.to_string())
}

fn operation_id(kind: &str, hash: &str) -> String {
    format!("wiki-{kind}-{}", &hash[..hash.len().min(40)])
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

/// Adopt one cloud topic payload into local state. Ok(false) defers the
/// topic (sources not synchronized yet or a different model configuration).
fn apply_topic_payload(
    root: &Path,
    payload: &Value,
    docs: &BTreeMap<String, Document>,
    config: &Models,
) -> CommandResult<bool> {
    if payload["schema"].as_str() != Some(TOPIC_SCHEMA)
        || payload["text_revision"].as_str() != Some(&config.text_revision)
    {
        return Ok(false);
    }
    let inputs = payload["source_inputs"]
        .as_object()
        .ok_or("Invalid synced topic inputs")?;
    for (id, key) in inputs {
        let Some(expected) = key.as_str() else {
            return Ok(false);
        };
        let Some(doc) = docs.get(id) else {
            // Source not synchronized on this device yet; retry after sync.
            return Ok(false);
        };
        if automation::input_key(doc, config) != expected {
            // Same id but different content: keep the local organize instead.
            return Ok(false);
        }
    }
    let head: Topic =
        serde_json::from_value(payload["head"].clone()).map_err(|_| "Invalid synced topic head")?;
    let page: Revision = serde_json::from_value(payload["page"].clone())
        .map_err(|_| "Invalid synced topic page")?;
    let page_value = serde_json::to_value(&page).map_err(|error| error.to_string())?;
    if payload["content_hash"].as_str() != Some(&payload_hash(&payload["head"], &page_value)) {
        return Err("Synced topic payload hash mismatch".into());
    }
    let mut values = topics(root)?;
    match values
        .iter()
        .position(|topic| topic_store::matches_id(topic, &head.id))
    {
        Some(index) => values[index] = head.clone(),
        None => values.push(head.clone()),
    }
    save_topics(root, &values)?;
    save_page(root, &head, &page, false)?;
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
    for id in remote_tombstones.iter().filter(|id| !local_deleted.contains(*id)) {
        {
            let _guard = state.serial.lock().await;
            require_current(&state, session)?;
            let mut values = topics(root)?;
            if values.iter().any(|topic| topic_store::matches_id(topic, id)) {
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
        let local_hash = {
            let _guard = state.serial.lock().await;
            require_current(&state, session)?;
            let values = topics(root)?;
            match values.iter().find(|topic| topic.id == *id) {
                Some(topic) => topic_payload(topic, docs, config)?
                    .map(|payload| {
                        payload["content_hash"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned()
                    })
                    .unwrap_or_default(),
                None => String::new(),
            }
        };
        if !local_hash.is_empty() && local_hash == *cloud_hash {
            outbox.remote.insert(id.clone(), cloud_hash.clone());
            outbox.delivered.insert(id.clone(), local_hash);
            outbox.deferred_adoptions.remove(id);
            continue;
        }
        if !local_hash.is_empty() && outbox.delivered.get(id) != Some(&local_hash) {
            // Local edits win until they are acknowledged; keep the push lane.
            {
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                let values = topics(root)?;
                if let Some(topic) = values.iter().find(|topic| topic.id == *id) {
                    if let Some(payload) = topic_payload(topic, docs, config)? {
                        let hash =
                            payload["content_hash"].as_str().unwrap_or_default().to_owned();
                        outbox
                            .pending
                            .entry(id.clone())
                            .or_insert_with(|| QueuedWork {
                                hash,
                                payload,
                                next_attempt: now,
                                ..Default::default()
                            });
                    }
                }
            }
            continue;
        }
        if outbox.deferred_adoptions.get(id).is_some_and(|until| *until > now) {
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
                    outbox.deferred_adoptions.insert(id.clone(), now + DEFER_SECONDS);
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
            match apply_topic_payload(root, &payload, docs, config) {
                Ok(true) => {
                    let hash = payload["content_hash"].as_str().unwrap_or_default().to_owned();
                    outbox.remote.insert(id.clone(), hash.clone());
                    outbox.delivered.insert(id.clone(), hash);
                    outbox.deferred_adoptions.remove(id);
                    work_done += 1;
                }
                Ok(false) => {
                    outbox.deferred_adoptions.insert(id.clone(), now + DEFER_SECONDS);
                }
                Err(error) => {
                    log::warn!("Wiki topic {id} adoption failed: {error}");
                    outbox.deferred_adoptions.insert(id.clone(), now + DEFER_SECONDS);
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
                Some(&operation_id("topic", &hash)),
            )
            .await
        };
        match result {
            Ok(_) => {
                let state = app.state::<WorkbenchState>();
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                let mut outbox = read_outbox(path)?;
                if queued.delete {
                    outbox.delivered.remove(&id);
                } else {
                    outbox.delivered.insert(id.clone(), hash.clone());
                }
                if outbox.pending.get(&id).is_some_and(|item| item.hash == hash) {
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
                if let Some(item) = outbox.pending.get_mut(&id) {
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
        .pending
        .values()
        .any(|queued| queued.next_attempt <= now))
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
            Some(&operation_id("source", &hash)),
        )
        .await;
        match result {
            Ok(_) => {
                let state = app.state::<WorkbenchState>();
                let _guard = state.serial.lock().await;
                require_current(&state, session)?;
                let mut outbox = read_outbox(path)?;
                outbox.delivered_sources.insert(id.clone(), hash.clone());
                if outbox.sources.get(&id).is_some_and(|item| item.hash == hash) {
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
        let docs_map: BTreeMap<_, _> =
            docs.iter().map(|doc| (doc.id.clone(), doc.clone())).collect();
        (config, docs_map)
    };

    let cloud_manifest = cloud_request(app, session, "/wiki-topics", None, None).await?;
    {
        let mut outbox = read_outbox(&path)?;
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

    // Adopt extraction caches for sources referenced by adopted topics.
    let needed: Vec<String> = {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let outbox = read_outbox(&path)?;
        let values = if wiki_root.exists() {
            topics(&wiki_root)?
        } else {
            Vec::new()
        };
        values
            .iter()
            .flat_map(|topic| topic.source_ids.iter().cloned())
            .filter(|id| !outbox.adopted_sources.contains(id) && docs_map.contains_key(id))
            .collect::<BTreeSet<_>>()
            .into_iter()
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
        for topic in &values {
            let Some(payload) = topic_payload(topic, &docs_map, &config)? else {
                continue;
            };
            let hash = payload["content_hash"].as_str().unwrap_or_default().to_owned();
            if outbox.remote.get(&topic.id) == Some(&hash)
                && outbox.delivered.get(&topic.id) == Some(&hash)
            {
                outbox.deferred_adoptions.remove(&topic.id);
                continue;
            }
            if outbox.delivered.get(&topic.id) != Some(&hash) {
                outbox
                    .pending
                    .entry(topic.id.clone())
                    .or_insert_with(|| QueuedWork {
                        hash,
                        payload,
                        next_attempt: now,
                        ..Default::default()
                    });
            }
        }
        let docs: Vec<Document> = docs_map.values().cloned().collect();
        let slices = automation::source_catalog_slices(&wiki_root, &docs, &config)?;
        for (id, slice) in slices {
            let hash = source_slice_hash(&slice);
            if outbox.delivered_sources.get(&id) != Some(&hash)
                && !outbox.sources.get(&id).is_some_and(|item| item.hash == hash)
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
