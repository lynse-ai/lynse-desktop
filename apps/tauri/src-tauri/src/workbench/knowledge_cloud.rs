//! Verified cloud policy and source authority for automatic AI reads.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::collections::BTreeSet;

pub(super) fn response_error(status: reqwest::StatusCode) -> String {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => "Cloud knowledge identity verification failed".into(),
        reqwest::StatusCode::CONFLICT => {
            "Cloud knowledge policy changed; reload before saving".into()
        }
        _ => format!("Cloud knowledge request failed (HTTP {})", status.as_u16()),
    }
}

pub(super) fn stops_dispatch(error: &str) -> bool {
    super::knowledge_transport::transient(error)
        || error.contains("Cloud knowledge identity")
        || error.contains("Cloud knowledge request failed (HTTP 403)")
        || error.contains("Cloud knowledge request failed (HTTP 5")
}

pub(super) async fn request(
    app: &AppHandle,
    session: &Session,
    path: &str,
    body: Option<Value>,
    operation: Option<&str>,
) -> CommandResult<Value> {
    let state = app.state::<WorkbenchState>();
    state
        .knowledge_transport
        .request(session, path, body, operation, || {
            require_current(&state, session)
        })
        .await
}

pub(super) fn source_id(id: &str) -> String {
    id.strip_prefix("local:")
        .map(|value| format!("desktop:{value}"))
        .unwrap_or_else(|| id.to_owned())
}

fn policy_allows(doc: &Document, policy: &Value) -> bool {
    if policy["enrolled"] != true {
        return false;
    }
    if policy["excluded_source_ids"].as_array().is_some_and(|ids| {
        ids.iter()
            .any(|id| id.as_str() == Some(&source_id(&doc.id)))
    }) {
        return false;
    }
    if doc.folder_id.is_empty() {
        policy["include_unfiled"] == true
    } else {
        policy["folder_ids"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&doc.folder_id)))
    }
}

pub(super) fn local_allows(doc: &Document, manifest: &Manifest) -> bool {
    // Pending changes can withdraw access immediately. They cannot expand a
    // server grant before the corresponding operation is acknowledged.
    manifest
        .knowledge_policy
        .as_ref()
        .is_none_or(|policy| policy_allows(doc, policy))
        && manifest
            .knowledge_pending
            .as_ref()
            .and_then(|pending| pending.get("policy"))
            .is_none_or(|policy| policy_allows(doc, policy))
}

fn install_policy(manifest: &mut Manifest, policy: Value) {
    let stale = manifest.knowledge_policy.as_ref().is_some_and(|current| {
        ["range_version", "grant_version", "processing_version"]
            .iter()
            .any(|key| policy[*key].as_u64().unwrap_or(0) < current[*key].as_u64().unwrap_or(0))
    });
    if !stale {
        manifest.knowledge_policy = Some(policy);
    }
}

async fn capabilities(app: &AppHandle, session: &Session, force: bool) -> CommandResult<Value> {
    let state = app.state::<WorkbenchState>();
    let mut cached = state.knowledge_capabilities.lock().await;
    require_current(&state, session)?;
    let now = now_seconds();
    if !force {
        if let Some((_, _, value)) = cached.as_ref().filter(|(generation, checked, _)| {
            *generation == session.generation && now.saturating_sub(*checked) < 30
        }) {
            return Ok(value.clone());
        }
    }
    let value = request(app, session, "/capabilities", None, None).await?;
    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    let mut manifest = load_state(app, session)?;
    let previous = manifest.knowledge_policy.clone();
    if let Some(policy) = value.get("policy").filter(|policy| policy.is_object()) {
        install_policy(&mut manifest, policy.clone());
    }
    if previous != manifest.knowledge_policy {
        persist(app, session, &manifest)?;
    }
    if wiki::update_server_profile(app, session, &value["synthesisProfile"])? {
        super::request_wiki(&state);
    }
    *cached = Some((session.generation, now_seconds(), value.clone()));
    Ok(value)
}

pub(super) async fn refresh_capabilities(
    app: &AppHandle,
    session: &Session,
) -> CommandResult<Value> {
    capabilities(app, session, false).await
}

fn pending_conflict(error: &str) -> bool {
    error == "Cloud knowledge policy changed; reload before saving"
}

pub(super) async fn retry_pending_policy(app: &AppHandle, session: &Session) -> CommandResult<()> {
    let state = app.state::<WorkbenchState>();
    let pending = {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        load_state(app, session)?.knowledge_pending
    };
    let Some(pending) = pending else {
        return Ok(());
    };
    if pending["status"] == "conflict" {
        return Err("Cloud knowledge policy changed; reload before saving".into());
    }
    let operation = pending["operation"]
        .as_str()
        .ok_or("Invalid pending knowledge policy operation")?;
    let body = pending["request"]
        .as_object()
        .ok_or("Invalid pending knowledge policy request")?;
    let result = request(
        app,
        session,
        "/preferences/actions",
        Some(json!({"knowledge":body})),
        Some(operation),
    )
    .await;
    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    let mut manifest = load_state(app, session)?;
    if manifest
        .knowledge_pending
        .as_ref()
        .and_then(|value| value["operation"].as_str())
        != Some(operation)
    {
        return Ok(());
    }
    match result {
        Ok(value) => {
            let policy = value
                .get("knowledge")
                .filter(|policy| policy.is_object())
                .ok_or("Cloud knowledge policy acknowledgement is unavailable")?
                .clone();
            install_policy(&mut manifest, policy);
            manifest.knowledge_pending = None;
            persist(app, session, &manifest)?;
            state.cloud_wakeup.notify_one();
            Ok(())
        }
        Err(error) => {
            if let Some(pending) = &mut manifest.knowledge_pending {
                pending["status"] = json!(if pending_conflict(&error) {
                    "conflict"
                } else {
                    "retry"
                });
                pending["error"] = json!(error);
            }
            persist(app, session, &manifest)?;
            Err(error)
        }
    }
}

pub(super) async fn authorize(
    app: &AppHandle,
    session: &Session,
    documents: &[Document],
    purpose: &str,
) -> CommandResult<()> {
    if documents
        .iter()
        .any(|doc| crate::inspiration_private::source_is_protected(app, &doc.id))
    {
        return Err("Encrypted inspirations are unavailable to AI".into());
    }
    let sources: Vec<_> = documents
        .iter()
        .map(|doc| {
            json!({"source_id":source_id(&doc.id),
        "folder_id":doc.folder_id,"local":doc.id.starts_with("local:"),"revision":doc.revision})
        })
        .collect();
    let result = request(
        app,
        session,
        "/source-eligibility",
        Some(json!({"sources":sources,"purpose":purpose})),
        None,
    )
    .await?;
    let allowed = result["allowed_source_ids"]
        .as_array()
        .ok_or("Cloud source eligibility unavailable")?;
    if documents
        .iter()
        .any(|doc| crate::inspiration_private::source_is_protected(app, &doc.id))
    {
        return Err("Encrypted inspirations are unavailable to AI".into());
    }
    if documents.iter().any(|doc| {
        !allowed
            .iter()
            .any(|value| value.as_str() == Some(&source_id(&doc.id)))
    }) {
        return Err(
            "A source is outside the current cloud policy or stopped from automatic use".into(),
        );
    }
    Ok(())
}

fn locally_ai_eligible(entry: &store::Entry, doc: &Document, manifest: &Manifest) -> bool {
    store::eligible(entry)
        && entry.revision == doc.revision
        && doc.ai_context_enabled
        && local_allows(doc, manifest)
        && (manifest.wiki_automation.is_none() || wiki::in_automatic_scope(doc, manifest))
}

fn filter_authorized_items(
    items: Vec<Value>,
    docs: &[Document],
    cloud_allowed: &[Value],
) -> Vec<Value> {
    let allowed = |id: &str, revision: Option<&str>| {
        docs.iter()
            .any(|doc| doc.id == id && revision.is_none_or(|revision| doc.revision == revision))
            && cloud_allowed
                .iter()
                .any(|value| value.as_str() == Some(&source_id(id)))
    };
    items
        .into_iter()
        .filter(|item| {
            if item["document"]["aiContextEnabled"] == false {
                return false;
            }
            if item["kind"] == "wiki" || item["document"]["kind"] == "wiki" {
                item["citations"]
                    .as_array()
                    .or(item["document"]["citations"].as_array())
                    .is_some_and(|refs| {
                        !refs.is_empty()
                            && refs.iter().all(|reference| {
                                reference["id"]
                                    .as_str()
                                    .zip(reference["revision"].as_str())
                                    .is_some_and(|(id, revision)| allowed(id, Some(revision)))
                            })
                    })
            } else {
                item["id"]
                    .as_str()
                    .or(item["document"]["id"].as_str())
                    .is_some_and(|id| {
                        allowed(
                            id,
                            item["revision"]
                                .as_str()
                                .or(item["document"]["revision"].as_str()),
                        )
                    })
            }
        })
        .collect()
}

pub(super) async fn filter_items(
    app: &AppHandle,
    session: &Session,
    items: Vec<Value>,
) -> CommandResult<Vec<Value>> {
    let state = app.state::<WorkbenchState>();
    require_current(&state, session)?;
    if items.is_empty() {
        return Ok(items);
    }
    let manifest = load_state(app, session)?;
    let (root, _) = roots(app, session)?;
    let mut identifiers = BTreeSet::new();
    for item in &items {
        if item["kind"] == "wiki" || item["document"]["kind"] == "wiki" {
            if let Some(refs) = item["citations"]
                .as_array()
                .or(item["document"]["citations"].as_array())
            {
                for reference in refs {
                    if let Some(id) = reference["id"].as_str() {
                        identifiers.insert(id.to_owned());
                    }
                }
            }
        } else if let Some(id) = item["id"].as_str().or(item["document"]["id"].as_str()) {
            identifiers.insert(id.to_owned());
        }
    }
    let mut docs: Vec<_> = identifiers
        .iter()
        .filter_map(|id| manifest.entries.get(id))
        .filter(|entry| store::eligible(entry))
        .filter_map(|entry| {
            store::read_document(&root, entry)
                .ok()
                .filter(|doc| locally_ai_eligible(entry, doc, &manifest))
        })
        .filter(|doc| !crate::inspiration_private::source_is_protected(app, &doc.id))
        .collect();
    if docs.is_empty() {
        return Ok(Vec::new());
    }
    let sources: Vec<_> = docs
        .iter()
        .map(|doc| {
            json!({"source_id":source_id(&doc.id),"folder_id":doc.folder_id,
        "local":doc.id.starts_with("local:"),"revision":doc.revision})
        })
        .collect();
    let result = request(
        app,
        session,
        "/source-eligibility",
        Some(json!({"sources":sources})),
        None,
    )
    .await?;
    let allowed = result["allowed_source_ids"]
        .as_array()
        .ok_or("Cloud source eligibility unavailable")?;
    // A cloud allowance cannot restore a local source withdrawn while the
    // authorization request was in flight, or approve a different revision.
    let latest = load_state(app, session)?;
    docs.retain(|doc| {
        latest
            .entries
            .get(&doc.id)
            .is_some_and(|entry| locally_ai_eligible(entry, doc, &latest))
            && !crate::inspiration_private::source_is_protected(app, &doc.id)
    });
    require_current(&state, session)?;
    Ok(filter_authorized_items(items, &docs, allowed))
}

pub(super) async fn policy_action(
    app: &AppHandle,
    session: &Session,
    payload: Value,
) -> CommandResult<Value> {
    let state = app.state::<WorkbenchState>();
    if payload["action"] == "read" {
        // Retrying the same operation first also recovers a lost successful
        // response before comparing a later server snapshot.
        let _ = retry_pending_policy(app, session).await;
        let value = capabilities(app, session, true).await?;
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let mut manifest = load_state(app, session)?;
        if let Some(policy) = value.get("policy").filter(|policy| policy.is_object()) {
            install_policy(&mut manifest, policy.clone());
            persist(app, session, &manifest)?;
        }
        return Ok(
            json!({"capabilities":value,"pending":manifest.knowledge_pending.is_some(),
            "pendingStatus":manifest.knowledge_pending.as_ref().map(|pending|&pending["status"]),
            "pendingError":manifest.knowledge_pending.as_ref().map(|pending|&pending["error"])}),
        );
    }
    if payload["action"] != "update" {
        return Err("Unsupported knowledge policy action".into());
    }
    let body = payload
        .get("policy")
        .filter(|body| body.is_object())
        .ok_or("Knowledge policy is required")?
        .clone();
    {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let mut manifest = load_state(app, session)?;
        let operation = manifest
            .knowledge_pending
            .as_ref()
            .filter(|pending| pending["request"] == body && pending["status"] != "conflict")
            .and_then(|pending| pending["operation"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("knowledge-policy-{}", uuid::Uuid::new_v4()));
        let mut local = manifest
            .knowledge_policy
            .clone()
            .unwrap_or_else(|| json!({}));
        if let (Some(local), Some(changes)) = (local.as_object_mut(), body.as_object()) {
            for (key, value) in changes {
                if !key.starts_with("base_") {
                    local.insert(key.clone(), value.clone());
                }
            }
        }
        manifest.knowledge_pending =
            Some(json!({"policy":local,"request":body,"operation":operation,"status":"retry"}));
        persist(app, session, &manifest)?;
    }
    state.cloud_wakeup.notify_one();
    retry_pending_policy(app, session).await?;
    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    let manifest = load_state(app, session)?;
    Ok(json!({"policy":manifest.knowledge_policy,"pending":manifest.knowledge_pending.is_some()}))
}

fn chunks(text: &str, limit: usize) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if current.len() + character.len_utf8() > limit {
            result.push(current);
            current = String::new();
        }
        current.push(character);
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn upload_current(manifest: &Manifest, id: &str, revision: &str) -> bool {
    manifest
        .entries
        .get(id)
        .is_some_and(|entry| entry.revision == revision && store::eligible(entry))
        && manifest.knowledge_policy.as_ref().is_none_or(|policy| {
            policy["local_text_consent"] == true && policy["memory_consent"] == true
        })
        && manifest
            .knowledge_pending
            .as_ref()
            .and_then(|pending| pending.get("policy"))
            .is_none_or(|policy| {
                policy["local_text_consent"] == true && policy["memory_consent"] == true
            })
}

async fn check_upload_current(
    app: &AppHandle,
    session: &Session,
    doc: &Document,
) -> CommandResult<()> {
    let state = app.state::<WorkbenchState>();
    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    let manifest = load_state(app, session)?;
    if !upload_current(&manifest, &doc.id, &doc.revision)
        || !local_allows(doc, &manifest)
        || crate::inspiration_private::source_is_protected(app, &doc.id)
    {
        return Err("Recording changed or synchronization permission was withdrawn".into());
    }
    Ok(())
}

async fn save_upload_receipt(
    app: &AppHandle,
    session: &Session,
    id: &str,
    revision: &str,
    receipt: &Value,
) -> CommandResult<()> {
    let state = app.state::<WorkbenchState>();
    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    let mut manifest = load_state(app, session)?;
    if !upload_current(&manifest, id, revision) {
        return Err("Recording changed during text synchronization; retry".into());
    }
    // A concurrent upload of the same snapshot must not downgrade a completed receipt.
    if manifest.knowledge_uploads.get(id).is_some_and(|saved| {
        saved["complete"] == true
            && receipt["complete"] != true
            && saved["source_fingerprint"] == receipt["source_fingerprint"]
    }) {
        return Ok(());
    }
    manifest
        .knowledge_uploads
        .insert(id.to_owned(), receipt.clone());
    persist(app, session, &manifest)
}

pub(super) async fn upload_local(
    app: &AppHandle,
    session: &Session,
    id: &str,
) -> CommandResult<Value> {
    let uuid = id
        .strip_prefix("local:")
        .ok_or("Only a local recording can use text synchronization")?;
    uuid::Uuid::parse_str(uuid).map_err(|_| "Invalid recording UUID")?;
    let capability = refresh_capabilities(app, session).await?;
    let policy = &capability["policy"];
    if capability["available"] != true
        || policy["local_text_consent"] != true
        || policy["memory_consent"] != true
    {
        return Err("Authorize local work transcript synchronization first".into());
    }
    let (doc, preferred, previous) = {
        let state = app.state::<WorkbenchState>();
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let manifest = load_state(app, session)?;
        let (root, _) = roots(app, session)?;
        let entry = manifest
            .entries
            .get(id)
            .ok_or("Recording is not available to this account")?;
        let doc = store::read_document(&root, entry)?;
        if !locally_ai_eligible(entry, &doc, &manifest)
            || crate::inspiration_private::source_is_protected(app, id)
        {
            return Err("Recording is outside the authorized source range".into());
        }
        let preferred = wiki::memory_source(doc.clone(), &manifest);
        let previous = manifest
            .knowledge_uploads
            .get(id)
            .cloned()
            .unwrap_or(Value::Null);
        (doc, preferred, previous)
    };
    let text = wiki::mask_memory_text(&preferred.text());
    if text.trim().is_empty() || text.len() > 16 * 1024 * 1024 {
        return Err("Transcript text is empty or exceeds 16 MiB".into());
    }
    let content_hash = store::digest(&text);
    let source_fingerprint = store::digest(json!([doc.revision, preferred.text()]).to_string());
    let remote = request(
        app,
        session,
        &format!("/desktop-sources/{}", source_id(id)),
        None,
        None,
    )
    .await?;
    check_upload_current(app, session, &doc).await?;
    if previous["source_fingerprint"] == source_fingerprint
        && previous["complete"] == true
        && previous["source_revision"] == remote["revision"]
    {
        return Ok(previous);
    }
    if remote["source_fingerprint"] == source_fingerprint
        && remote["revision"].as_u64().unwrap_or(0) > 0
    {
        let recovered = json!({"source_fingerprint":source_fingerprint,"content_hash":content_hash,"source_revision":remote["revision"],"complete":true});
        save_upload_receipt(app, session, id, &doc.revision, &recovered).await?;
        return Ok(recovered);
    }
    if previous.is_null()
        && remote["revision"].as_u64().unwrap_or(0) > 0
        && remote["source_fingerprint"] != source_fingerprint
    {
        return Err(
            "Cloud text snapshot differs; review it before replacing from this device".into(),
        );
    }
    let stable = store::digest(
        json!([
            id,
            source_fingerprint,
            content_hash,
            policy["grant_versions"],
            policy["range_version"]
        ])
        .to_string(),
    );
    let mut receipt = if previous["input"] == stable {
        previous
    } else {
        json!({"input":stable,"content_hash":content_hash,"source_fingerprint":source_fingerprint,"base_revision":previous.get("source_revision").unwrap_or(&remote["revision"])})
    };
    save_upload_receipt(app, session, id, &doc.revision, &receipt).await?;
    if receipt["upload_id"].as_str().is_none() {
        let prepared=request(app,session,"/desktop-sources/uploads",Some(json!({"recording_id":uuid,
            "base_revision":receipt["base_revision"],"folder_id":doc.folder_id,"scene":"work",
            "source_fingerprint":source_fingerprint,
            "representation":if preferred.kind == "meeting_summary" {"masked_summary"} else {"masked_transcript"}})),Some(&format!("source-prepare-{stable}"))).await?;
        receipt["upload_id"] = prepared["upload_id"].clone();
        save_upload_receipt(app, session, id, &doc.revision, &receipt).await?;
    }
    let upload_id = receipt["upload_id"]
        .as_str()
        .ok_or("Invalid source upload session")?;
    let pieces = chunks(&text, 256 * 1024);
    for (index, piece) in pieces.iter().enumerate() {
        check_upload_current(app, session, &doc).await?;
        request(
            app,
            session,
            &format!("/desktop-sources/uploads/{upload_id}/chunks"),
            Some(json!({"index":index,"data":STANDARD.encode(piece.as_bytes())})),
            Some(&format!("source-chunk-{stable}-{index}")),
        )
        .await?;
    }
    check_upload_current(app, session, &doc).await?;
    let committed = request(
        app,
        session,
        &format!("/desktop-sources/uploads/{upload_id}/commit"),
        Some(json!({"chunk_count":pieces.len(),"content_hash":content_hash})),
        Some(&format!("source-commit-{stable}")),
    )
    .await?;
    receipt["source_revision"] = committed["source"]["revision"].clone();
    receipt["source_id"] = committed["source"]["source_id"].clone();
    receipt["complete"] = json!(true);
    save_upload_receipt(app, session, id, &doc.revision, &receipt).await?;
    Ok(receipt)
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct QueuedEvent {
    input: String,
    page: Value,
    attempts: u32,
    next_attempt: u64,
    error: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct EventOutbox {
    pending: std::collections::BTreeMap<String, QueuedEvent>,
    delivered: std::collections::BTreeMap<String, String>,
    policy: Value,
    source_cursor: String,
}

fn outbox_path(app: &AppHandle, session: &Session) -> CommandResult<PathBuf> {
    Ok(state_path(app, session)?.with_file_name("knowledge-outbox.json"))
}

fn read_outbox(path: &std::path::Path) -> CommandResult<EventOutbox> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Knowledge event outbox is unreadable; original preserved".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(EventOutbox::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_outbox(path: &std::path::Path, outbox: &EventOutbox) -> CommandResult<()> {
    crate::atomic_write(
        path,
        &serde_json::to_vec_pretty(outbox).map_err(|error| error.to_string())?,
    )
}

fn policy_input(manifest: &Manifest) -> Value {
    let policy = manifest.knowledge_policy.as_ref().unwrap_or(&Value::Null);
    json!([
        policy["range_version"],
        policy["grant_version"],
        policy["processing_version"],
        policy["grant_versions"],
        policy["memory_consent"],
        policy["extraction_paused"],
        manifest
            .knowledge_pending
            .as_ref()
            .map(|pending| &pending["policy"])
    ])
}

fn memory_allowed(manifest: &Manifest) -> bool {
    manifest.enabled
        && manifest.allow_ai
        && manifest.knowledge_policy.as_ref().is_some_and(|policy| {
            policy["enrolled"] == true
                && policy["memory_consent"] == true
                && policy["extraction_paused"] != true
        })
        && manifest
            .knowledge_pending
            .as_ref()
            .and_then(|pending| pending.get("policy"))
            .is_none_or(|policy| {
                policy["enrolled"] == true
                    && policy["memory_consent"] == true
                    && policy["extraction_paused"] != true
            })
}

fn queue_events(outbox: &mut EventOutbox, pages: Vec<Value>, policy: &Value) {
    let mut active = BTreeSet::new();
    for page in pages {
        let Some(topic) = page["topic_id"].as_str().map(str::to_owned) else {
            continue;
        };
        active.insert(topic.clone());
        let input = store::digest(json!(["wiki-memory-outbox-v1", page, policy]).to_string());
        if outbox.delivered.get(&topic) == Some(&input) {
            outbox.pending.remove(&topic);
        } else if !outbox
            .pending
            .get(&topic)
            .is_some_and(|queued| queued.input == input)
        {
            outbox.pending.insert(
                topic,
                QueuedEvent {
                    input,
                    page,
                    ..Default::default()
                },
            );
        }
    }
    outbox.pending.retain(|topic, _| active.contains(topic));
    outbox.delivered.retain(|topic, _| active.contains(topic));
}

pub(super) async fn enqueue_events(
    app: &AppHandle,
    session: &Session,
    pages: Vec<Value>,
) -> CommandResult<()> {
    let state = app.state::<WorkbenchState>();
    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    let manifest = load_state(app, session)?;
    let path = outbox_path(app, session)?;
    let mut outbox = read_outbox(&path)?;
    let before = serde_json::to_value(&outbox).map_err(|error| error.to_string())?;
    if memory_allowed(&manifest) {
        queue_events(&mut outbox, pages, &policy_input(&manifest));
    } else {
        outbox.pending.clear();
    }
    outbox.policy = policy_input(&manifest);
    if serde_json::to_value(&outbox).map_err(|error| error.to_string())? != before {
        write_outbox(&path, &outbox)?;
        state.cloud_wakeup.notify_one();
    }
    Ok(())
}

fn due_events(outbox: &EventOutbox, now: u64) -> Vec<QueuedEvent> {
    outbox
        .pending
        .values()
        .filter(|queued| queued.next_attempt <= now)
        .take(8)
        .cloned()
        .collect()
}

fn acknowledge_event(outbox: &mut EventOutbox, event: &QueuedEvent) {
    if let Some(topic) = event.page["topic_id"].as_str() {
        outbox.delivered.insert(topic.into(), event.input.clone());
        if outbox
            .pending
            .get(topic)
            .is_some_and(|queued| queued.input == event.input)
        {
            outbox.pending.remove(topic);
        }
    }
}

fn fail_event(outbox: &mut EventOutbox, event: &QueuedEvent, now: u64, error: &str) {
    if let Some(queued) = event.page["topic_id"]
        .as_str()
        .and_then(|topic| outbox.pending.get_mut(topic))
        .filter(|queued| queued.input == event.input)
    {
        queued.attempts = queued.attempts.saturating_add(1);
        queued.next_attempt = now + 30 * (1_u64 << queued.attempts.min(5));
        queued.error = error.into();
    }
}

fn source_batches(events: &[QueuedEvent], cursor: &str) -> Vec<Vec<String>> {
    let ids: BTreeSet<_> = events
        .iter()
        .flat_map(|event| event.page["citations"].as_array().into_iter().flatten())
        .filter_map(|reference| reference["id"].as_str())
        .filter(|id| !id.starts_with("local:"))
        .map(str::to_owned)
        .collect();
    let mut ids: Vec<_> = ids.into_iter().collect();
    let next = ids.partition_point(|id| id.as_str() <= cursor);
    if next < ids.len() {
        ids.rotate_left(next);
    }
    ids.chunks(50).map(|batch| batch.to_vec()).collect()
}

#[derive(Default)]
struct SourceSync {
    versions: std::collections::BTreeMap<String, u64>,
    errors: std::collections::BTreeMap<String, String>,
    deferred: BTreeSet<String>,
    cursor: Option<String>,
    fatal: Option<String>,
    requests: usize,
}

fn source_specific_failure(error: &str) -> bool {
    pending_conflict(error)
        || [400, 404, 409, 410, 422]
            .iter()
            .any(|status| error == format!("Cloud knowledge request failed (HTTP {status})"))
}

async fn synchronize_batches<F, Fut>(
    batches: Vec<Vec<String>>,
    budget: usize,
    mut synchronize: F,
) -> SourceSync
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = CommandResult<Value>>,
{
    let mut report = SourceSync::default();
    let mut pending: std::collections::VecDeque<_> = batches.into();
    while let Some(batch) = pending.pop_front() {
        if report.requests >= budget {
            report.deferred.extend(batch);
            report.deferred.extend(pending.into_iter().flatten());
            break;
        }
        if batch.is_empty() {
            continue;
        }
        report.requests += 1;
        report.cursor = batch.last().cloned();
        match synchronize(batch.clone()).await {
            Ok(value) => {
                for source in value["sources"].as_array().into_iter().flatten() {
                    if let (Some(id), Some(version)) =
                        (source["source_id"].as_str(), source["revision"].as_u64())
                    {
                        if batch.iter().any(|requested| requested == id) {
                            report.versions.insert(id.to_owned(), version);
                        }
                    }
                }
                report.deferred.extend(
                    batch
                        .into_iter()
                        .filter(|id| !report.versions.contains_key(id)),
                );
            }
            Err(error) if !stops_dispatch(&error) && source_specific_failure(&error) => {
                if batch.len() == 1 {
                    report.errors.insert(batch[0].clone(), error);
                } else {
                    let middle = batch.len() / 2;
                    pending.push_front(batch[middle..].to_vec());
                    pending.push_front(batch[..middle].to_vec());
                }
            }
            Err(error) => {
                report.fatal = Some(error);
                report.deferred.extend(batch);
                report.deferred.extend(pending.into_iter().flatten());
                break;
            }
        }
    }
    report
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn settle_outbox(
    app: &AppHandle,
    session: &Session,
    event: &QueuedEvent,
    identity: Option<String>,
    error: &str,
) -> CommandResult<()> {
    let state = app.state::<WorkbenchState>();
    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    let path = outbox_path(app, session)?;
    let mut outbox = read_outbox(&path)?;
    if let Some(identity) = identity {
        let mut manifest = load_state(app, session)?;
        let topic = event.page["topic_id"]
            .as_str()
            .ok_or("Invalid Wiki event topic")?;
        manifest.knowledge_events.insert(topic.into(), identity);
        persist(app, session, &manifest)?;
        acknowledge_event(&mut outbox, event);
    } else {
        fail_event(&mut outbox, event, now_seconds(), error);
    }
    write_outbox(&path, &outbox)
}

pub(super) async fn background(app: &AppHandle, session: &Session) -> CommandResult<bool> {
    let state = app.state::<WorkbenchState>();
    require_current(&state, session)?;
    // Cross-device organize-state reconciliation runs on the same lane; its
    // failures never block the memory-event outbox below.
    let wiki_sync_more = match wiki::cloud::background(app, session).await {
        Ok(more) => more,
        Err(error) => {
            log::warn!("Wiki organize sync paused: {error}");
            false
        }
    };
    let _ = retry_pending_policy(app, session).await;
    let capability = refresh_capabilities(app, session).await?;
    let refresh_outbox = {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let manifest = load_state(app, session)?;
        read_outbox(&outbox_path(app, session)?)?.policy != policy_input(&manifest)
    };
    if refresh_outbox {
        wiki::publish_memory_events(app, &state, session).await?;
    }
    let (events, policy, policy_version, source_cursor) = {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let manifest = load_state(app, session)?;
        if capability["available"] != true
            || !memory_allowed(&manifest)
            || wiki::ready(&manifest).is_err()
        {
            return Ok(false);
        }
        let outbox = read_outbox(&outbox_path(app, session)?)?;
        (
            due_events(&outbox, now_seconds()),
            manifest.knowledge_policy.clone().unwrap_or(Value::Null),
            policy_input(&manifest),
            outbox.source_cursor,
        )
    };
    if events.is_empty() {
        return Ok(false);
    }
    let current = wiki::memory_events_current(
        app,
        session,
        &events
            .iter()
            .map(|event| event.page.clone())
            .collect::<Vec<_>>(),
    )
    .await?;
    let events: Vec<_> = {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let path = outbox_path(app, session)?;
        let mut outbox = read_outbox(&path)?;
        for event in &events {
            if let Some(topic) = event.page["topic_id"]
                .as_str()
                .filter(|topic| !current.contains(*topic))
            {
                if outbox
                    .pending
                    .get(topic)
                    .is_some_and(|queued| queued.input == event.input)
                {
                    outbox.pending.remove(topic);
                }
            }
        }
        write_outbox(&path, &outbox)?;
        events
            .into_iter()
            .filter(|event| {
                event.page["topic_id"]
                    .as_str()
                    .is_some_and(|topic| current.contains(topic))
            })
            .collect()
    };
    // Isolate source-specific failures without allowing a poisoned 50-source
    // batch to monopolize the lane. The cursor resumes deferred work fairly.
    let expected_policy = &policy_version;
    let report = synchronize_batches(
        source_batches(&events, &source_cursor),
        16,
        |batch| async move {
            let latest = load_state(app, session)?;
            if !memory_allowed(&latest) || policy_input(&latest) != *expected_policy {
                return Err(
                    "Source synchronization authority changed; retry after synchronization".into(),
                );
            }
            request(
                app,
                session,
                "/sources/sync",
                Some(json!({"source_ids":batch})),
                None,
            )
            .await
        },
    )
    .await;
    if let Some(cursor) = report.cursor {
        let _guard = state.serial.lock().await;
        require_current(&state, session)?;
        let path = outbox_path(app, session)?;
        let mut outbox = read_outbox(&path)?;
        outbox.source_cursor = cursor;
        write_outbox(&path, &outbox)?;
    }
    if let Some(error) = report.fatal {
        for event in &events {
            settle_outbox(app, session, event, None, &error).await?;
        }
        return Err(error);
    }
    let mut versions = report.versions;
    let mut source_errors = report.errors;
    source_errors.extend(report.deferred.into_iter().map(|id| {
        (
            id,
            "Source synchronization deferred by the request budget; retry pending".into(),
        )
    }));
    let local: BTreeSet<_> = events
        .iter()
        .flat_map(|event| event.page["citations"].as_array().into_iter().flatten())
        .filter_map(|reference| reference["id"].as_str())
        .filter(|id| id.starts_with("local:"))
        .map(str::to_owned)
        .collect();
    for id in local {
        let manifest = load_state(app, session)?;
        if manifest
            .knowledge_uploads
            .get(&id)
            .is_some_and(|receipt| receipt["complete"] == true)
        {
            match upload_local(app, session, &id).await {
                Ok(receipt) => {
                    if let Some(version) = receipt["source_revision"].as_u64() {
                        versions.insert(source_id(&id), version);
                    }
                }
                Err(error) => {
                    source_errors.insert(id, error);
                }
            }
        }
    }
    for event in events {
        let outcome: CommandResult<String> = async {
            let manifest = load_state(app, session)?;
            if !memory_allowed(&manifest) || policy_input(&manifest) != policy_version {
                return Err("Cloud knowledge policy changed; reload before saving".into());
            }
            if !wiki::memory_events_current(app, session, std::slice::from_ref(&event.page)).await?.contains(event.page["topic_id"].as_str().unwrap_or_default()) {
                return Err("Wiki page changed before cloud publication".into());
            }
            let refs = event.page["citations"].as_array().ok_or("Wiki citations unavailable")?;
            let ids: BTreeSet<_> = refs.iter().filter_map(|reference| reference["id"].as_str()).collect();
            if let Some(error) = ids.iter().find_map(|id| source_errors.get(*id)) { return Err(error.clone()); }
            let (root, _) = roots(app, session)?;
            let docs: Vec<_> = ids.iter().map(|id| {
                let entry = manifest.entries.get(*id).ok_or("Wiki source unavailable")?;
                let doc = store::read_document(&root, entry)?;
                if !locally_ai_eligible(entry, &doc, &manifest) { return Err("Wiki source stopped from automatic use".into()); }
                Ok(doc)
            }).collect::<CommandResult<_>>()?;
            authorize(app, session, &docs, "wiki_compile").await?;
            let latest = load_state(app, session)?;
            if !memory_allowed(&latest) || policy_input(&latest) != policy_version
                || docs.iter().any(|doc| latest.entries.get(&doc.id).is_none_or(|entry| !locally_ai_eligible(entry, doc, &latest)))
                || !wiki::memory_events_current(app, session, std::slice::from_ref(&event.page)).await?.contains(event.page["topic_id"].as_str().unwrap_or_default())
            { return Err("Wiki publication authority changed; retry after synchronization".into()); }
            let source_refs = ids.iter().map(|id| versions.get(&source_id(id)).map(|version|
                json!({"source_id":source_id(id),"source_revision":version}))).collect::<Option<Vec<_>>>()
                .ok_or("Wiki sources await cloud text synchronization")?;
            let identity = store::digest(json!([event.page["topic_id"],event.page["topic_title"],event.page["fingerprint"],source_refs,policy["processing_version"],policy["grant_version"]]).to_string());
            request(app, session, "/wiki-memory/events", Some(json!({"topic_id":event.page["topic_id"],"topic_title":event.page["topic_title"],"input_fingerprint":identity,"source_refs":source_refs})), Some(&format!("wiki-memory-{identity}"))).await?;
            Ok(identity)
        }.await;
        match outcome {
            Ok(identity) => settle_outbox(app, session, &event, Some(identity), "").await?,
            Err(error) => {
                settle_outbox(app, session, &event, None, &error).await?;
                if stops_dispatch(&error) {
                    return Err(error);
                }
            }
        }
    }
    let events_pending = !due_events(&read_outbox(&outbox_path(app, session)?)?, now_seconds())
        .is_empty();
    Ok(events_pending || wiki_sync_more)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_page(topic: &str, fingerprint: &str, ids: &[&str]) -> Value {
        json!({"topic_id":topic,"topic_title":topic,"fingerprint":fingerprint,
            "citations":ids.iter().map(|id|json!({"id":id,"revision":"source-v1"})).collect::<Vec<_>>()})
    }

    #[test]
    fn event_outbox_reopens_without_replaying_delivered_pages_and_only_queues_changes() {
        let path = std::env::temp_dir()
            .join(uuid::Uuid::new_v4().to_string())
            .join("outbox.json");
        let pages = vec![
            event_page("one", "v1", &["shared"]),
            event_page("two", "v1", &["shared"]),
        ];
        let mut outbox = EventOutbox::default();
        queue_events(&mut outbox, pages.clone(), &json!(1));
        for event in due_events(&outbox, 0) {
            acknowledge_event(&mut outbox, &event);
        }
        write_outbox(&path, &outbox).unwrap();
        let mut restored = read_outbox(&path).unwrap();
        queue_events(&mut restored, pages, &json!(1));
        assert!(due_events(&restored, 0).is_empty());
        queue_events(
            &mut restored,
            vec![
                event_page("two", "v2", &["shared"]),
                event_page("one", "v1", &["shared"]),
            ],
            &json!(1),
        );
        let pending = due_events(&restored, 0);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].page["topic_id"], "two");
        assert_eq!(restored.delivered.len(), 2);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn late_event_acknowledgement_cannot_remove_newer_queued_page() {
        let mut outbox = EventOutbox::default();
        queue_events(
            &mut outbox,
            vec![event_page("one", "old", &["source"])],
            &json!(1),
        );
        let previous = due_events(&outbox, 0).remove(0);
        queue_events(
            &mut outbox,
            vec![event_page("one", "new", &["source"])],
            &json!(1),
        );
        acknowledge_event(&mut outbox, &previous);
        fail_event(&mut outbox, &previous, 0, "old request failed");
        assert_eq!(outbox.pending["one"].page["fingerprint"], "new");
        assert_eq!(outbox.pending["one"].attempts, 0);
        assert_eq!(due_events(&outbox, 0).len(), 1);
    }

    #[test]
    fn dispatch_deduplicates_shared_sources_and_bounds_each_gateway_batch() {
        let pages: Vec<_> = (0..125)
            .map(|index| {
                event_page(
                    &format!("topic-{index}"),
                    "v1",
                    &["shared", &format!("source-{index}"), "local:private"],
                )
            })
            .collect();
        let mut outbox = EventOutbox::default();
        queue_events(&mut outbox, pages, &json!(1));
        let events: Vec<_> = outbox.pending.into_values().collect();
        let batches = source_batches(&events, "");
        assert_eq!(batches.len(), 3);
        assert!(batches.iter().all(|batch| batch.len() <= 50));
        let ids: Vec<_> = batches.into_iter().flatten().collect();
        assert_eq!(ids.len(), 126);
        assert_eq!(ids.iter().filter(|id| id.as_str() == "shared").count(), 1);
        assert!(ids.iter().all(|id| !id.starts_with("local:")));
    }

    #[tokio::test]
    async fn source_batch_isolates_a_poisoned_source_and_keeps_healthy_pages_dispatchable() {
        let ids: Vec<_> = (0..32).map(|index| format!("source-{index:02}")).collect();
        let report = synchronize_batches(vec![ids], 16, |batch| async move {
            if batch.iter().any(|id| id == "source-13") {
                Err("Cloud knowledge request failed (HTTP 404)".into())
            } else {
                Ok(json!({"sources":batch.iter().map(|id|json!({"source_id":id,"revision":1})).collect::<Vec<_>>()}))
            }
        }).await;
        assert!(report.fatal.is_none());
        assert!(report.requests <= 16);
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors.contains_key("source-13"));
        assert_eq!(report.versions.len(), 31);
        assert!(report.deferred.is_empty());
    }

    #[tokio::test]
    async fn source_isolation_budget_resumes_after_cursor_and_authority_errors_fail_closed() {
        let mut outbox = EventOutbox::default();
        let ids: Vec<_> = (0..50).map(|index| format!("source-{index:02}")).collect();
        queue_events(
            &mut outbox,
            vec![event_page(
                "one",
                "v1",
                &ids.iter().map(String::as_str).collect::<Vec<_>>(),
            )],
            &json!(1),
        );
        let events = due_events(&outbox, 0);
        let first = synchronize_batches(source_batches(&events, ""), 16, |_| async {
            Err("Cloud knowledge request failed (HTTP 409)".into())
        })
        .await;
        assert_eq!(first.requests, 16);
        assert!(!first.deferred.is_empty());
        let cursor = first.cursor.as_deref().unwrap();
        let next = source_batches(&events, cursor);
        assert_ne!(next[0][0], "source-00");
        assert!(first.deferred.contains(&next[0][0]));
        for error in [
            "Cloud knowledge request failed (HTTP 403)",
            "Cloud knowledge request failed (HTTP 429)",
            "Cloud knowledge request failed (HTTP 503)",
        ] {
            let report =
                synchronize_batches(next.clone(), 16, |_| async { Err(error.into()) }).await;
            assert_eq!(report.requests, 1);
            assert_eq!(report.fatal.as_deref(), Some(error));
            assert!(report.versions.is_empty());
        }
    }

    #[test]
    fn failed_dispatch_backs_off_without_starving_other_queued_events() {
        let mut outbox = EventOutbox::default();
        queue_events(
            &mut outbox,
            (0..20)
                .map(|index| event_page(&format!("topic-{index:02}"), "v1", &["source"]))
                .collect(),
            &json!(1),
        );
        let first = due_events(&outbox, 0);
        assert_eq!(first.len(), 8);
        for event in &first {
            fail_event(&mut outbox, event, 0, "offline");
        }
        let second = due_events(&outbox, 0);
        assert_eq!(second.len(), 8);
        assert!(second
            .iter()
            .all(|event| !first.iter().any(|old| old.input == event.input)));
        assert_eq!(outbox.pending["topic-00"].next_attempt, 60);
    }

    #[test]
    fn pending_policy_only_narrows_server_authority_and_old_ack_cannot_roll_it_back() {
        let doc = Document {
            folder_id: "work".into(),
            ..Default::default()
        };
        let mut manifest = Manifest {
            knowledge_policy: Some(
                json!({"enrolled":true,"folder_ids":["work"],"range_version":4,"grant_version":3,"processing_version":5}),
            ),
            ..Default::default()
        };
        manifest.knowledge_pending =
            Some(json!({"policy":{"enrolled":true,"folder_ids":["other"]},"status":"retry"}));
        assert!(!local_allows(&doc, &manifest));
        manifest.knowledge_policy = Some(
            json!({"enrolled":true,"folder_ids":["work","other"],"range_version":5,"grant_version":3,"processing_version":6}),
        );
        assert!(!local_allows(&doc, &manifest));
        install_policy(
            &mut manifest,
            json!({"enrolled":true,"folder_ids":["work"],"range_version":4,"grant_version":3,"processing_version":5}),
        );
        assert_eq!(
            manifest.knowledge_policy.as_ref().unwrap()["range_version"],
            5
        );
        manifest.knowledge_policy = Some(json!({"enrolled":false,"folder_ids":["work"]}));
        manifest.knowledge_pending =
            Some(json!({"policy":{"enrolled":true,"folder_ids":["work"]}}));
        assert!(!local_allows(&doc, &manifest));
    }

    fn ai_read_fixture() -> (Document, store::Entry, Manifest) {
        let mut doc = Document {
            id: "local:approved".into(),
            kind: "meeting".into(),
            folder_id: "work".into(),
            transcript: "Reviewed meeting evidence".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        let entry = store::Entry {
            id: doc.id.clone(),
            revision: doc.revision.clone(),
            status: "synced".into(),
            ..Default::default()
        };
        let manifest = Manifest {
            wiki_automation: Some(store::WikiAutomation {
                folder_ids: vec!["work".into()],
                include_unfiled: false,
            }),
            knowledge_policy: Some(
                json!({"enrolled":true,"folder_ids":["work"],"include_unfiled":false}),
            ),
            ..Default::default()
        };
        (doc, entry, manifest)
    }

    #[test]
    fn cloud_permission_cannot_override_local_ai_withdrawal_or_unsettled_sources() {
        let (doc, entry, manifest) = ai_read_fixture();
        let item = json!({"document":{"id":doc.id,"kind":"meeting","revision":doc.revision,"aiContextEnabled":true},"markdown":"Reviewed meeting evidence"});
        let cloud_allowed = vec![json!(source_id(&doc.id))];
        assert!(locally_ai_eligible(&entry, &doc, &manifest));
        assert_eq!(
            filter_authorized_items(
                vec![item.clone()],
                std::slice::from_ref(&doc),
                &cloud_allowed
            )
            .len(),
            1
        );

        for reason in [
            "excluded",
            "conflict",
            "pending",
            "failed",
            "awaiting_transcription",
            "ai-disabled",
            "cloud-range",
            "native-range",
            "changed-revision",
        ] {
            let mut current_entry = entry.clone();
            let mut current_doc = doc.clone();
            let mut current_manifest = manifest.clone();
            match reason {
                "excluded" => current_entry.excluded = true,
                "conflict" | "pending" | "failed" | "awaiting_transcription" => {
                    current_entry.status = reason.into()
                }
                "ai-disabled" => current_doc.ai_context_enabled = false,
                "cloud-range" => {
                    current_manifest.knowledge_policy =
                        Some(json!({"enrolled":true,"folder_ids":["other"]}))
                }
                "native-range" => {
                    current_manifest
                        .wiki_automation
                        .as_mut()
                        .unwrap()
                        .folder_ids = vec!["other".into()]
                }
                "changed-revision" => current_entry.revision = "newer-source-version".into(),
                _ => unreachable!(),
            }
            let local_docs: Vec<_> = std::iter::once(current_doc)
                .filter(|doc| locally_ai_eligible(&current_entry, doc, &current_manifest))
                .collect();
            assert!(local_docs.is_empty(), "Local denial must win: {reason}");
            assert!(
                filter_authorized_items(vec![item.clone()], &local_docs, &cloud_allowed).is_empty(),
                "Cloud permission restored denied source: {reason}"
            );
        }
    }

    #[test]
    fn wiki_ai_reads_require_every_citation_to_pass_local_and_cloud_authority() {
        let (doc, _, _) = ai_read_fixture();
        let items = vec![
            json!({"id":"valid","kind":"wiki","citations":[{"id":doc.id,"revision":doc.revision}]}),
            json!({"id":"withdrawn-citation","kind":"wiki","citations":[{"id":doc.id,"revision":doc.revision},{"id":"local:withdrawn","revision":"withdrawn-version"}]}),
            json!({"id":"stale-citation","kind":"wiki","citations":[{"id":doc.id,"revision":"old-version"}]}),
            json!({"document":{"id":doc.id,"revision":"old-version","kind":"meeting"}}),
            json!({"document":{"id":"nested-withdrawn","kind":"wiki","citations":[{"id":"local:withdrawn"}]}}),
            json!({"id":"missing-reference-id","kind":"wiki","citations":[{"quote":"No source identity"}]}),
            json!({"id":"empty-citations","kind":"wiki","citations":[]}),
            json!({"id":"missing-citations","kind":"wiki"}),
            json!({"document":{"id":doc.id,"kind":"meeting","aiContextEnabled":false}}),
        ];
        let cloud_allowed = vec![json!(source_id(&doc.id)), json!("desktop:withdrawn")];
        let filtered = filter_authorized_items(items, std::slice::from_ref(&doc), &cloud_allowed);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["id"], "valid");
        assert!(filter_authorized_items(filtered, std::slice::from_ref(&doc), &[]).is_empty());
    }

    #[test]
    fn server_failure_keeps_http_status_and_is_not_reported_as_bad_login() {
        for status in [403, 404, 429, 500, 501, 503] {
            let message = response_error(reqwest::StatusCode::from_u16(status).unwrap());
            assert!(message.contains(&format!("HTTP {status}")));
            assert!(!message.contains("identity verification failed"));
        }
        assert_eq!(
            response_error(reqwest::StatusCode::UNAUTHORIZED),
            "Cloud knowledge identity verification failed"
        );
        assert_eq!(
            response_error(reqwest::StatusCode::CONFLICT),
            "Cloud knowledge policy changed; reload before saving"
        );
        for status in [401, 429, 500, 503] {
            assert!(stops_dispatch(&response_error(
                reqwest::StatusCode::from_u16(status).unwrap()
            )));
        }
        assert!(!stops_dispatch(&response_error(
            reqwest::StatusCode::CONFLICT
        )));
    }
    #[test]
    fn upload_chunks_count_utf8_bytes_and_preserve_text() {
        let text = "中🙂".repeat(50000);
        let pieces = chunks(&text, 256 * 1024);
        assert!(pieces.iter().all(|piece| piece.len() <= 256 * 1024));
        assert_eq!(pieces.concat(), text);
    }
    #[test]
    fn pending_range_is_enforced_before_cloud_acknowledgement() {
        let doc = Document {
            folder_id: "old".into(),
            ..Default::default()
        };
        let mut manifest = Manifest::default();
        manifest.knowledge_pending =
            Some(json!({"policy":{"enrolled":true,"folder_ids":["new"],"include_unfiled":false}}));
        assert!(!local_allows(&doc, &manifest));
    }
}
