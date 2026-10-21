use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use store::{eligible, read_document, write_document, Entry};
#[path = "local_sources.rs"]
mod local_sources;

fn client() -> CommandResult<reqwest::Client> {
    let builder = reqwest::Client::builder();
    #[cfg(test)]
    let builder = builder.no_proxy();
    builder
        .timeout(Duration::from_secs(100))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Network client unavailable".into())
}
fn unpack(value: Value) -> CommandResult<Value> {
    if value.get("code").is_some() {
        if value["code"].as_i64() != Some(200) {
            if value
                .get("msg")
                .and_then(Value::as_str)
                .is_some_and(|s| s.contains("not.ready"))
            {
                return Err("Text not.ready".into());
            }
            return Err(format!("API request failed ({})", value["code"]));
        }
        return Ok(value.get("data").cloned().unwrap_or(Value::Null));
    }
    Ok(value)
}
async fn request(session: &Session, path: &str, post: bool, body: Value) -> CommandResult<Value> {
    let mut url =
        url::Url::parse(&format!("{}{}", session.base_url, path)).map_err(|_| "Invalid API URL")?;
    if !post {
        if let Some(fields) = body.as_object() {
            let mut query = url.query_pairs_mut();
            for (key, value) in fields {
                query.append_pair(
                    key,
                    &value
                        .as_str()
                        .map(String::from)
                        .unwrap_or_else(|| value.to_string()),
                );
            }
        }
    }
    let request = if post {
        client()?.post(url).json(&body)
    } else {
        client()?.get(url)
    };
    let response = request
        .header("Authorization", &session.token)
        .send()
        .await
        .map_err(|_| "Network unavailable; retry when connected")?;
    if !response.status().is_success() {
        return Err(format!(
            "API request failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Server returned invalid JSON")?;
    if path == "/api/business/file/page" {
        return unpack_page(value);
    }
    unpack(value)
}
fn unpack_page(value: Value) -> CommandResult<Value> {
    let total = value.get("total").cloned();
    let pages = value.get("pages").cloned();
    let mut data = unpack(value)?;
    if data.is_array() {
        data = json!({"list":data});
    }
    if let Some(total) = total {
        if data.get("total").is_none() {
            data["total"] = total;
        }
    }
    if let Some(pages) = pages {
        if data.get("pages").is_none() {
            data["pages"] = pages;
        }
    }
    Ok(data)
}
pub(super) async fn verify_identity(base: &str, token: &str) -> CommandResult<String> {
    let session = Session {
        base_url: base.into(),
        agent_url: base.into(),
        model_override: None,
        token: token.into(),
        scope: String::new(),
        user_id: String::new(),
        locale: String::new(),
        generation: 0,
    };
    let identity = request(&session, "/api/business/customer/current", false, json!({})).await?;
    // Match Lynclaw's authenticated profile identity before comparing its binding.
    [
        "userId",
        "user_id",
        "id",
        "uid",
        "accountId",
        "account_id",
        "customerId",
        "customer_id",
        "customerNo",
    ]
    .iter()
    .filter_map(|key| identity.get(key))
    .find_map(|value| match value {
        Value::String(id) if !id.trim().is_empty() => Some(id.trim().to_owned()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    })
    .ok_or_else(|| "Server did not return a verified account".into())
}
fn string(row: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| {
            row.get(key).and_then(|v| {
                v.as_str()
                    .map(String::from)
                    .or_else(|| v.as_u64().map(|n| n.to_string()))
            })
        })
        .unwrap_or_default()
}
fn rows(value: &Value) -> Vec<Value> {
    if let Some(array) = value.as_array() {
        return array.clone();
    }
    for key in [
        "list",
        "records",
        "data",
        "transcriptionRecords",
        "segments",
    ] {
        if let Some(array) = value[key].as_array() {
            return array.clone();
        }
    }
    vec![]
}
fn absent_text(error: &str) -> bool {
    error.contains("not.ready") || error.contains("not ready")
}

async fn enumerate(session: &Session) -> CommandResult<Vec<Value>> {
    let mut meetings = Vec::new();
    let mut seen = BTreeSet::new();
    let mut expected_total = 0;
    let mut expected_pages = 0;
    // Empty-page termination also covers gateways that omit totals. Repeated
    // pages are an error, never a successful partial "all meetings" sync.
    for page in 1..=100_000usize {
        let response = request(
            session,
            "/api/business/file/page",
            false,
            json!({"pageNum":page,"pageSize":100}),
        )
        .await?;
        let batch = rows(&response);
        if batch.is_empty() {
            if meetings.len() < expected_total || page < expected_pages {
                return Err("Server ended pagination before all meetings were returned".into());
            }
            return Ok(meetings);
        }
        let pages = response.get("pages").and_then(Value::as_u64);
        let total = response.get("total").and_then(Value::as_u64);
        expected_total = response
            .get("total")
            .and_then(Value::as_u64)
            .unwrap_or(expected_total as u64) as usize;
        expected_pages = response
            .get("pages")
            .and_then(Value::as_u64)
            .unwrap_or(expected_pages as u64) as usize;
        let mut added = 0;
        for row in batch.iter() {
            let id = string(row, &["id", "fileId"]);
            if id.is_empty() {
                return Err("Meeting list contains a record without an ID".into());
            }
            if seen.insert(id) {
                meetings.push(row.clone());
                added += 1;
            }
        }
        if pages.is_some_and(|pages| page as u64 >= pages)
            || total.is_some_and(|total| meetings.len() as u64 >= total)
        {
            if total.is_some_and(|total| (meetings.len() as u64) < total) {
                return Err("Server reported inconsistent pagination totals".into());
            }
            return Ok(meetings);
        }
        if added == 0 {
            return Err("Server repeated a meeting page; full sync is incomplete".into());
        }
    }
    Err("Meeting enumeration exceeded the supported page count".into())
}

fn normalize_transcript(value: &Value) -> (String, Vec<Value>) {
    let mut segments = rows(value);
    let content = string(value, &["content", "transcriptText", "text"]);
    if segments.is_empty() && !content.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<Value>(&content) {
            segments = rows(&parsed);
        }
    }
    let normalized:Vec<Value>=segments.into_iter().enumerate().map(|(index,row)|{
        let text=string(&row,&["text","recognizedText","content","transcriptionText"]);
        let mut value=json!({"id":string(&row,&["id","sentenceId"]),"text":text,"speakerName":string(&row,&["speakerName","speaker","speakerId"])});
        if value["id"]==""{value["id"]=json!(format!("segment-{index}"));}
        // Only explicit millisecond fields are safe for audio positioning.
        if let Some(ms)=row.get("startMs").or_else(||row.get("beginTime")).and_then(Value::as_u64){value["startMs"]=json!(ms);}
        if let Some(ms)=row.get("endMs").or_else(||row.get("endTime")).and_then(Value::as_u64){value["endMs"]=json!(ms);}
        value
    }).collect();
    let text = if normalized.is_empty() {
        content
    } else {
        normalized
            .iter()
            .filter_map(|s| s["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    (text, normalized)
}

async fn optional_detail(
    session: &Session,
    path: &str,
    id: &str,
    awaiting: bool,
) -> CommandResult<Value> {
    match request(session, path, false, json!({"fileId":id})).await {
        Ok(value) => Ok(value),
        Err(error) if absent_text(&error) || (awaiting && error.contains("HTTP 404")) => {
            Ok(Value::Null)
        }
        Err(error) => Err(error),
    }
}
async fn cloud_document(
    session: &Session,
    row: &Value,
    todos: &[Value],
) -> CommandResult<Document> {
    let id = string(row, &["id", "fileId"]);
    let awaiting = matches!(
        string(row, &["status"]).as_str(),
        "0" | "1" | "PENDING" | "PROCESSING" | "recorded" | "queued"
    );
    let (transcript, outline, conclusions) = tokio::try_join!(
        optional_detail(session, "/api/business/file/trans/get", &id, awaiting),
        optional_detail(session, "/api/business/file/outline/get", &id, awaiting),
        optional_detail(session, "/api/business/file/conclusion/list", &id, awaiting)
    )?;
    let (text, segments) = normalize_transcript(&transcript);
    let mut document = Document {
        id: id.clone(),
        kind: "meeting".into(),
        title: string(row, &["originalFilename", "title", "name"]),
        created_at: string(row, &["createdAt", "createTime"]),
        updated_at: string(row, &["updatedAt", "updateTime", "createTime"]),
        folder_id: string(row, &["folderId"]),
        tags: row["tags"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        transcript: text,
        segments,
        outline: string(&outline, &["content", "outlineText"]),
        conclusions: rows(&conclusions),
        todos: todos
            .iter()
            .filter(|t| string(t, &["fileId"]) == id)
            .cloned()
            .collect(),
        ai_context_enabled: row
            .get("aiContextEnabled")
            .or_else(|| row.get("ai_context_enabled"))
            .and_then(Value::as_bool)
            != Some(false)
            && !matches!(
                string(row, &["sensitivity"]).as_str(),
                "private" | "sensitive" | "restricted"
            ),
        ..Default::default()
    };
    let folder_name = string(row, &["folderName"]);
    if !folder_name.is_empty() {
        document.tags.push(folder_name);
    }
    document.refresh_revision();
    Ok(document)
}
fn local_document(row: &Value) -> Document {
    let mut document = Document {
        id: string(row, &["id"]),
        kind: "meeting".into(),
        title: string(row, &["title"]),
        created_at: string(row, &["createdAt"]),
        updated_at: string(row, &["updatedAt"]),
        transcript: string(row, &["transcriptText"]),
        segments: rows(&row["segments"]),
        markers: rows(&row["markers"]),
        playback_path: string(row, &["sourcePath"]),
        cloud_file_id: string(row, &["cloudFileId"]),
        ai_context_enabled: row.get("aiContextEnabled").and_then(Value::as_bool) != Some(false),
        ..Default::default()
    };
    document.refresh_revision();
    document
}

pub(super) fn forget_source(state: &mut Manifest, id: &str) {
    state.memories.retain(|item| {
        !item["citations"]
            .as_array()
            .is_some_and(|refs| refs.iter().any(|r| r["id"] == id))
    });
    state.artifacts.remove(id);
}

pub(super) async fn commit_document(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    document: Document,
) -> CommandResult<()> {
    commit_document_inner(app, state, session, document, true).await
}

async fn commit_document_inner(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    document: Document,
    preserve_legacy_edit: bool,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let mut manifest = load_state(app, session)?;
    if !manifest.enabled {
        return Err("Memory disabled".into());
    }
    let (root, _) = roots(app, session)?;
    if preserve_legacy_edit
        && manifest
            .entries
            .get(&document.id)
            .is_none_or(|entry| entry.markdown_hash.is_empty())
    {
        if let Some(edited) = crate::vault::modified_legacy_note(app, &document.id)? {
            let original = write_document(&root, &document, None)?;
            crate::atomic_write(&store::paths(&root, &document.id).0, edited.as_bytes())?;
            manifest.entries.insert(document.id.clone(), original);
        }
    }
    let old = manifest.entries.get(&document.id);
    if old.is_some_and(|entry| {
        entry.revision == document.revision
            && eligible(entry)
            && read_document(&root, entry).is_ok()
    }) {
        return Ok(());
    }
    let changed = old.is_some_and(|old| old.revision != document.revision);
    let mut entry = write_document(&root, &document, old)?;
    entry.excluded = entry.excluded || manifest.excluded_sources.contains(&document.id);
    if entry.status == "conflict" || !document.ai_context_enabled {
        forget_source(&mut manifest, &document.id);
    } else if changed {
        manifest.memories.retain(|item| {
            item["sourceId"] != document.id || item["pinned"] == true || item["userEdited"] == true
        });
        for item in manifest
            .memories
            .iter_mut()
            .filter(|item| item["sourceId"] == document.id)
        {
            item["stale"] = json!(true);
        }
        if let Some(artifact) = manifest.artifacts.get_mut(&document.id) {
            artifact["todoSuggestions"] = json!([]);
        }
    }
    manifest.entries.insert(document.id.clone(), entry);
    manifest.updated_at = crate::now();
    persist(app, session, &manifest)
}

fn begin_sync(manifest: &mut Manifest, root: String) -> bool {
    if manifest.bootstrap_valid(&root) {
        return true;
    }
    manifest.initial_complete = false;
    manifest.sync_root = root;
    manifest.sync_round = uuid::Uuid::new_v4().to_string();
    manifest.completed_round.clear();
    manifest.wiki_progress = None;
    manifest.phase = "discovering".into();
    manifest.error.clear();
    false
}

pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    let refresh_existing = state.refresh_existing.swap(false, Ordering::SeqCst);
    let background = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        if !crate::vault::load_vault_config(app)?.enabled {
            return Ok(());
        }
        let local = roots(app, session)?.0;
        let background = local_sources::prepare_sync(&local, &mut manifest)?;
        persist(app, session, &manifest)?;
        background
    };
    let mut discovery_error = None;
    let mut cloud = match enumerate(session).await {
        Ok(rows) => rows,
        Err(error) => {
            discovery_error = Some(error);
            vec![]
        }
    };
    if discovery_error.is_none() {
        match request(session, "/api/business/file/folder/list", false, json!({})).await {
            Ok(value) => {
                let folders = rows(&value);
                for row in &mut cloud {
                    if let Some(folder) = folders
                        .iter()
                        .find(|folder| string(folder, &["id"]) == string(row, &["folderId"]))
                    {
                        row["folderName"] = json!(string(folder, &["folderName"]));
                    }
                }
            }
            Err(error) => discovery_error = Some(error),
        }
    }
    let cloud_todos = if discovery_error.is_none() {
        match request(session, "/api/business/file/todo/listall", true, json!({})).await {
            Ok(value) => rows(&value),
            Err(error) => {
                discovery_error = Some(error);
                vec![]
            }
        }
    } else {
        vec![]
    };
    let local = crate::list_store(app, "local-transcriptions")?;
    let local_todos = crate::list_store(app, "local-todos")?;
    let mut active = BTreeSet::new();
    let cloud_ids: BTreeSet<String> = cloud
        .iter()
        .map(|row| string(row, &["id", "fileId"]))
        .collect();
    let legacy_notes = crate::vault::legacy_notes(app, &cloud_ids)?;
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        if !background {
            manifest.phase = "syncing".into();
        }
        for row in &cloud {
            let id = string(row, &["id", "fileId"]);
            active.insert(id.clone());
            manifest.entries.entry(id.clone()).or_insert_with(|| Entry {
                id,
                kind: "meeting".into(),
                title: string(row, &["originalFilename", "title"]),
                status: "pending".into(),
                ..Default::default()
            });
        }
        persist(app, session, &manifest)?;
    }
    for row in local {
        if let Some(owner) = row.get("workbenchScope").and_then(Value::as_str) {
            if owner != session.scope {
                continue;
            }
        }
        let cloud_id = string(&row, &["cloudFileId"]);
        if !cloud_id.is_empty() && cloud_ids.contains(&cloud_id) {
            // An uploaded local recording already has usable text; do not fetch it back from cloud.
            if !refresh_existing {
                let missing = {
                    let _guard = state.serial.lock().await;
                    let manifest = load_state(app, session)?;
                    matches!(
                        local_sources::cached_meeting(
                            &roots(app, session)?.0,
                            &manifest,
                            &cloud_id
                        ),
                        Ok(None)
                    )
                };
                let mut document = local_document(&row);
                if missing && document.has_meeting_text() {
                    document.id = cloud_id.clone();
                    if let Some(cloud_row) = cloud
                        .iter()
                        .find(|value| string(value, &["id", "fileId"]) == cloud_id)
                    {
                        if let Some(note) = legacy_notes
                            .get(&cloud_id)
                            .and_then(|text| local_sources::legacy_document(cloud_row, text))
                        {
                            document.outline = note.outline;
                        }
                        document = local_sources::restrict_context(document, cloud_row);
                    }
                    document.refresh_revision();
                    commit_document_inner(app, state, session, document, false).await?;
                }
            }
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let mut manifest = load_state(app, session)?;
            let local_id = string(&row, &["id"]);
            manifest.aliases.insert(local_id.clone(), cloud_id.clone());
            if let Some(local_artifacts) = manifest.artifacts.remove(&local_id) {
                let cloud_artifacts = manifest
                    .artifacts
                    .entry(cloud_id.clone())
                    .or_insert_with(|| json!({"summaries":[],"todoSuggestions":[]}));
                if let (Some(from), Some(to)) = (
                    local_artifacts["summaries"].as_array(),
                    cloud_artifacts["summaries"].as_array_mut(),
                ) {
                    for item in from {
                        if !to.iter().any(|v| v["id"] == item["id"]) {
                            to.push(item.clone());
                        }
                    }
                }
            }
            // Keep the old evidence version visible as stale until cloud synthesis replaces it.
            for memory in manifest
                .memories
                .iter_mut()
                .filter(|m| m["sourceId"] == local_id)
            {
                memory["sourceId"] = json!(cloud_id);
                memory["stale"] = json!(true);
                if let Some(refs) = memory["citations"].as_array_mut() {
                    for reference in refs {
                        if reference["id"] == local_id {
                            reference["id"] = json!(cloud_id);
                        }
                    }
                }
            }
            if manifest.excluded_sources.contains(&local_id)
                && !manifest.excluded_sources.contains(&cloud_id)
            {
                manifest.excluded_sources.push(cloud_id.clone());
            }
            persist(app, session, &manifest)?;
            continue;
        }
        if row.get("saved").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let mut document = local_document(&row);
        if document.id.is_empty() {
            continue;
        }
        // New records carry their verified scope; legacy device records are
        // claimed by this account's explicit first-enable consent.
        if let Some(owner) = row.get("workbenchScope").and_then(Value::as_str) {
            if owner != session.scope {
                continue;
            }
        } else {
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let mut claimed = row.clone();
            claimed["workbenchScope"] = json!(session.scope);
            crate::save_store_value(app, "local-transcriptions", claimed)?;
        }
        document.todos = local_todos
            .iter()
            .filter(|t| string(t, &["sourceFileId"]) == document.id)
            .cloned()
            .collect();
        document.refresh_revision();
        active.insert(document.id.clone());
        commit_document(app, state, session, document).await?;
    }
    let mut deferred_meetings = Vec::new();
    for row in &cloud {
        if discovery_error.is_some() {
            break;
        }
        require_current(state, session)?;
        let id = string(row, &["id", "fileId"]);
        let related: Vec<&Value> = cloud_todos
            .iter()
            .filter(|todo| string(todo, &["fileId"]) == id)
            .collect();
        let remote_revision =
            store::digest(serde_json::to_vec(&json!([row, related])).map_err(|e| e.to_string())?);
        let cached = {
            let _guard = state.serial.lock().await;
            let manifest = load_state(app, session)?;
            local_sources::cached_meeting(&roots(app, session)?.0, &manifest, &id)
        };
        let (cached, imported_legacy) = match cached {
            Ok(Some(doc)) => (Some(doc), false),
            Ok(None) => (
                legacy_notes
                    .get(&id)
                    .and_then(|text| local_sources::legacy_document(row, text)),
                true,
            ),
            Err(error) => {
                let _guard = state.serial.lock().await;
                require_current(state, session)?;
                let mut manifest = load_state(app, session)?;
                if let Some(entry) = manifest.entries.get_mut(&id) {
                    entry.status = "conflict".into();
                    entry.error = error;
                }
                forget_source(&mut manifest, &id);
                persist(app, session, &manifest)?;
                continue;
            }
        };
        if !refresh_existing && cached.is_some() {
            let document = local_sources::load_meeting(session, row, &cloud_todos, cached).await?;
            commit_document_inner(app, state, session, document, !imported_legacy).await?;
            continue;
        }
        let (unchanged, unavailable) = {
            let _guard = state.serial.lock().await;
            let manifest = load_state(app, session)?;
            let (root, _) = roots(app, session)?;
            let unavailable = manifest.entries.get(&id).is_some_and(|entry| {
                matches!(entry.status.as_str(), "awaiting_transcription" | "failed")
            });
            let unchanged = !string(row, &["updatedAt", "updateTime"]).is_empty()
                && manifest.entries.get(&id).is_some_and(|entry| {
                    entry.remote_revision == remote_revision
                        && entry.status == "synced"
                        && read_document(&root, entry).is_ok()
                });
            (unchanged, unavailable)
        };
        if unavailable {
            deferred_meetings.push((row.clone(), remote_revision));
            continue;
        }
        if unchanged {
            continue;
        }
        {
            let _guard = state.serial.lock().await;
            let manifest = load_state(app, session)?;
            if manifest
                .entries
                .get(&id)
                .is_some_and(|entry| entry.failed_download_revision == remote_revision)
            {
                continue;
            }
        }
        let mut loaded = Err("Meeting download failed".into());
        for attempt in 0..3 {
            loaded = local_sources::load_meeting(session, row, &cloud_todos, None).await;
            if loaded.is_ok() {
                break;
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_secs(5 * (attempt + 1))).await;
                require_current(state, session)?;
            }
        }
        match loaded {
            Ok(document) => {
                commit_document(app, state, session, document).await?;
                let _guard = state.serial.lock().await;
                require_current(state, session)?;
                let mut manifest = load_state(app, session)?;
                if let Some(entry) = manifest.entries.get_mut(&id) {
                    entry.remote_revision = remote_revision;
                }
                persist(app, session, &manifest)?;
            }
            Err(error) => {
                let _guard = state.serial.lock().await;
                require_current(state, session)?;
                let mut manifest = load_state(app, session)?;
                if let Some(entry) = manifest.entries.get_mut(&id) {
                    entry.status = "failed".into();
                    entry.error = error;
                    entry.failed_download_revision = remote_revision;
                }
                forget_source(&mut manifest, &id);
                persist(app, session, &manifest)?;
            }
        }
    }
    // Journal records remain in their existing local store; the knowledge-base
    // record is an indexed view used by the same retrieval path as meetings.
    for row in crate::list_store(app, "local-inspirations")? {
        if let Some(owner) = row.get("workbenchScope").and_then(Value::as_str) {
            if owner != session.scope {
                continue;
            }
        } else {
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let mut claimed = row.clone();
            claimed["workbenchScope"] = json!(session.scope);
            crate::save_store_value(app, "local-inspirations", claimed)?;
        }
        let raw_id = string(&row, &["id"]);
        if raw_id.is_empty() {
            continue;
        }
        let mut document = Document {
            id: format!("inspiration:{raw_id}"),
            kind: "inspiration".into(),
            title: string(&row, &["text"]).chars().take(80).collect(),
            transcript: string(&row, &["text", "transcript"]),
            created_at: string(&row, &["createdAt"]),
            updated_at: string(&row, &["updatedAt"]),
            tags: row["tags"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            ai_context_enabled: row.get("aiContextEnabled").and_then(Value::as_bool) != Some(false)
                && !matches!(
                    string(&row, &["sensitivity"]).as_str(),
                    "private" | "sensitive" | "restricted"
                ),
            ..Default::default()
        };
        document.refresh_revision();
        active.insert(document.id.clone());
        commit_document(app, state, session, document).await?;
    }
    for todo in local_todos.iter().filter(|todo| {
        todo.get("workbenchScope")
            .and_then(Value::as_str)
            .is_none_or(|scope| scope == session.scope)
    }) {
        if todo.get("workbenchScope").is_none() {
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let mut claimed = todo.clone();
            claimed["workbenchScope"] = json!(session.scope);
            crate::save_store_value(app, "local-todos", claimed)?;
        }
        let id = string(todo, &["id"]);
        if id.is_empty() {
            continue;
        }
        let mut document = Document {
            id: format!("task:{id}"),
            kind: "todo".into(),
            title: string(todo, &["title"]),
            transcript: format!(
                "{}\n{}\nCompleted: {}",
                string(todo, &["title"]),
                string(todo, &["notes"]),
                todo["completed"]
            ),
            updated_at: string(todo, &["updatedAt"]),
            todos: vec![todo.clone()],
            ai_context_enabled: true,
            ..Default::default()
        };
        document.refresh_revision();
        active.insert(document.id.clone());
        commit_document(app, state, session, document).await?;
    }
    if let Some(error) = discovery_error {
        // Network failure cannot revoke a usable local knowledge base or delete its files.
        if background {
            let has_local = {
                let _guard = state.serial.lock().await;
                let manifest = load_state(app, session)?;
                let local = roots(app, session)?.0;
                manifest
                    .entries
                    .values()
                    .any(|entry| eligible(entry) && read_document(&local, entry).is_ok())
            };
            if has_local {
                state.discovery_requested.notify_one();
                return super::wiki::run(app, state, session).await;
            }
        }
        return Err(error);
    }
    // Reconcile a second enumeration before publishing this round's completion.
    // New/deleted/changed meetings during download require another complete pass.
    let verification = enumerate(session).await?;
    let signature = |values: &[Value]| -> BTreeMap<String, String> {
        values
            .iter()
            .map(|v| {
                let mut row = v.clone();
                if let Some(map) = row.as_object_mut() {
                    map.remove("folderName");
                }
                let revision = if refresh_existing {
                    row
                } else {
                    // Existing local text does not become stale because a server counter changed.
                    json!([
                        row.get("aiContextEnabled")
                            .or_else(|| row.get("ai_context_enabled")),
                        row.get("sensitivity")
                    ])
                };
                (
                    string(v, &["id", "fileId"]),
                    store::digest(revision.to_string()),
                )
            })
            .collect()
    };
    if signature(&cloud) != signature(&verification) {
        return Err("Meeting list changed during sync; retry to finish the complete round".into());
    }
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        let deleted: Vec<String> = manifest
            .entries
            .values()
            .filter(|entry| entry.kind != "gmail" && !active.contains(&entry.id))
            .map(|entry| entry.id.clone())
            .collect();
        let (root, _) = roots(app, session)?;
        for id in deleted {
            manifest.entries.remove(&id);
            forget_source(&mut manifest, &id);
            let (md, source) = store::paths(&root, &id);
            let _ = fs::remove_file(md);
            let _ = fs::remove_file(source);
        }
        store::rebuild_index(&root, &manifest)?;
        let complete = finish_sync(&root, &mut manifest);
        persist(app, session, &manifest)?;
        if !complete {
            return Ok(());
        }
    }
    // Optional backfill cannot delay the first Wiki pass over complete meetings.
    state.discovery_requested.notify_one();
    super::wiki::run(app, state, session).await?;
    let mut transcriptions_ready = false;
    for (row, remote_revision) in deferred_meetings {
        require_current(state, session)?;
        // Poll skipped meetings after Wiki starts, even if list metadata has not changed.
        // A transient polling failure leaves the meeting skipped until the next pass.
        let Ok(document) = cloud_document(session, &row, &cloud_todos).await else {
            continue;
        };
        let ready = !document.transcript.trim().is_empty();
        let id = document.id.clone();
        commit_document(app, state, session, document).await?;
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        if let Some(entry) = manifest.entries.get_mut(&id) {
            entry.remote_revision = remote_revision;
        }
        persist(app, session, &manifest)?;
        transcriptions_ready |= ready;
    }
    if transcriptions_ready {
        super::wiki::run(app, state, session).await?;
    }
    if super::sources::sync_optional(app, state, session).await? {
        super::wiki::run(app, state, session).await?;
    }
    Ok(())
}

fn finish_sync(root: &std::path::Path, manifest: &mut Manifest) -> bool {
    let complete = wiki_sync_complete(root, manifest);
    manifest.initial_complete = complete;
    if complete {
        manifest.completed_round = manifest.sync_round.clone();
    }
    manifest.phase = if complete { "ready" } else { "incomplete" }.into();
    // Source sync recovers independently of AI consent and Wiki processing.
    let wiki_error = manifest.error.starts_with("Wiki processing failed for ")
        || manifest.error.starts_with("Embedding failed for ");
    let wiki_complete = manifest
        .wiki_progress
        .as_ref()
        .is_some_and(|progress| progress.stage == "complete" && progress.failed == 0);
    if complete && (!wiki_error || wiki_complete) {
        manifest.error.clear();
    }
    complete
}

fn wiki_sync_complete(root: &std::path::Path, manifest: &Manifest) -> bool {
    manifest
        .entries
        .values()
        .filter(|entry| entry.kind != "gmail")
        .all(|entry| {
            // Unavailable meetings stay visible and retryable, but do not block usable text.
            matches!(entry.status.as_str(), "failed" | "awaiting_transcription")
                || (!matches!(entry.status.as_str(), "pending" | "conflict")
                    && read_document(root, entry).is_ok())
        })
}

pub(super) fn split_text(text: &str, max: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut buffer = String::new();
    let mut count = 0;
    for line in text.split_inclusive('\n') {
        for ch in line.chars() {
            buffer.push(ch);
            count += 1;
            if count >= max {
                parts.push(std::mem::take(&mut buffer));
                count = 0;
            }
        }
    }
    if !buffer.is_empty() {
        parts.push(buffer);
    }
    parts
}

pub(super) fn validate_result(
    documents: &[Document],
    manifest: &Manifest,
    result: &Value,
) -> CommandResult<()> {
    let mut citations = Vec::new();
    if let Some(refs) = result["citations"].as_array() {
        citations.extend(refs.iter());
    }
    for key in ["memoryItems", "todoSuggestions", "decisions"] {
        if let Some(items) = result[key].as_array() {
            for item in items {
                let refs = item["citations"]
                    .as_array()
                    .filter(|v| !v.is_empty())
                    .ok_or("AI result has an unsupported claim")?;
                citations.extend(refs.iter());
            }
        }
    }
    if citations.is_empty()
        && result.get("insufficientEvidence").and_then(Value::as_bool) != Some(true)
    {
        return Err("AI result has no source evidence".into());
    }
    for reference in citations {
        let id = reference["id"].as_str().ok_or("Invalid AI citation")?;
        let document = documents
            .iter()
            .find(|d| d.id == id)
            .ok_or("AI cited a source outside this request")?;
        if !document.ai_context_enabled
            || !(if document.kind == "memory" {
                manifest.memories.iter().any(|item| {
                    format!("memory:{}", item["id"].as_str().unwrap_or_default()) == id
                        && item["excluded"] != true
                        && item["stale"] != true
                })
            } else {
                manifest
                    .entries
                    .get(id)
                    .is_some_and(|e| eligible(e) && e.revision == document.revision)
            })
        {
            return Err("Source changed or was excluded; AI result discarded".into());
        }
        let quote = reference["quote"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or("AI citation has no quote")?;
        if reference["revision"] != document.revision || !document.text().contains(quote) {
            return Err("AI citation does not match the original source".into());
        }
        if let Some(ms) = reference.get("startMs").and_then(Value::as_u64) {
            if !document.segments.iter().any(|segment| {
                segment["startMs"].as_u64() == Some(ms)
                    && string(segment, &["text", "recognizedText"]).contains(quote)
            }) {
                return Err("AI invented an audio position".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sync_recovery_clears_persisted_errors_without_ai_processing() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut doc = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            transcript: "Existing meeting text".into(),
            ..Default::default()
        };
        doc.refresh_revision();
        let entry = write_document(&root, &doc, None).unwrap();
        for error in [
            "API request failed (2000)",
            "API request failed (HTTP 401)",
            "Network unavailable; retry when connected",
        ] {
            let mut manifest = Manifest {
                enabled: true,
                initial_complete: true,
                sync_root: root.to_string_lossy().into_owned(),
                sync_round: "verified-round".into(),
                completed_round: "verified-round".into(),
                phase: "failed".into(),
                error: error.into(),
                ..Default::default()
            };
            manifest.entries.insert(doc.id.clone(), entry.clone());
            let state_path = root.join("state.json");
            store::save(&state_path, &manifest).unwrap();
            let mut recovered = store::load(&state_path).unwrap();
            assert!(begin_sync(&mut recovered, manifest.sync_root.clone()));
            assert!(finish_sync(&root, &mut recovered));
            store::save(&state_path, &recovered).unwrap();
            let saved = store::load(&state_path).unwrap();
            assert!(saved.error.is_empty(), "old sync error survived: {error}");
            assert_eq!(saved.phase, "ready");
            assert!(saved.bootstrap_valid(&manifest.sync_root));
            assert!(!saved.allow_ai);
            assert!(saved.wiki_progress.is_none());
            assert_eq!(
                read_document(&root, &entry).unwrap().transcript,
                doc.transcript
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_recovery_keeps_wiki_failures_separate_from_old_sync_errors() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut manifest = Manifest {
            enabled: true,
            allow_ai: true,
            sync_round: "new-round".into(),
            error: "API request failed (2000)".into(),
            wiki_progress: Some(store::WikiProgress {
                stage: "complete".into(),
                total: 2,
                completed: 1,
                failed: 1,
                ..Default::default()
            }),
            ..Default::default()
        };
        let progress = serde_json::to_value(&manifest.wiki_progress).unwrap();
        assert!(finish_sync(&root, &mut manifest));
        assert!(manifest.error.is_empty());
        for error in [
            "Wiki processing failed for 1 topics; open Wiki to review and retry",
            "Embedding failed for 1 sources; keyword search remains available",
        ] {
            manifest.error = error.into();
            assert!(finish_sync(&root, &mut manifest));
            assert_eq!(manifest.error, error);
            assert_eq!(
                serde_json::to_value(&manifest.wiki_progress).unwrap(),
                progress
            );
        }
        manifest.wiki_progress.as_mut().unwrap().failed = 0;
        assert!(finish_sync(&root, &mut manifest));
        assert!(manifest.error.is_empty());
    }

    #[test]
    fn incomplete_sync_does_not_clear_the_error_or_publish_completion() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut manifest = Manifest {
            sync_round: "new-round".into(),
            error: "API request failed (2000)".into(),
            ..Default::default()
        };
        manifest.entries.insert(
            "pending".into(),
            Entry {
                id: "pending".into(),
                kind: "meeting".into(),
                status: "pending".into(),
                ..Default::default()
            },
        );
        assert!(!finish_sync(&root, &mut manifest));
        assert_eq!(manifest.phase, "incomplete");
        assert!(!manifest.initial_complete);
        assert!(manifest.completed_round.is_empty());
        assert_eq!(manifest.error, "API request failed (2000)");
    }

    #[test]
    fn background_sync_preserves_completed_wiki_and_bootstrap() {
        let mut manifest = Manifest {
            enabled: true,
            allow_ai: true,
            initial_complete: true,
            sync_root: "/vault/Meetings/account".into(),
            sync_round: "completed-round".into(),
            completed_round: "completed-round".into(),
            phase: "ready".into(),
            wiki_progress: Some(store::WikiProgress {
                stage: "complete".into(),
                completed: 1,
                total: 1,
                ..Default::default()
            }),
            ..Default::default()
        };
        let before = serde_json::to_value(&manifest).unwrap();
        assert!(begin_sync(&mut manifest, "/vault/Meetings/account".into()));
        assert_eq!(serde_json::to_value(&manifest).unwrap(), before);
        assert!(!begin_sync(&mut manifest, "/other/Meetings/account".into()));
        assert!(!manifest.initial_complete);
        assert!(manifest.completed_round.is_empty());
        assert!(manifest.wiki_progress.is_none());
        assert_eq!(manifest.phase, "discovering");
    }
    #[test]
    fn wiki_skips_unavailable_meetings_and_includes_them_when_ready() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut manifest = Manifest::default();
        let mut ready = Document {
            id: "ready".into(),
            kind: "meeting".into(),
            transcript: "Available evidence".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        ready.refresh_revision();
        manifest.entries.insert(
            ready.id.clone(),
            write_document(&root, &ready, None).unwrap(),
        );
        let mut waiting = Document {
            id: "waiting".into(),
            kind: "meeting".into(),
            title: "Untranscribed meeting".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        waiting.refresh_revision();
        manifest.entries.insert(
            waiting.id.clone(),
            write_document(&root, &waiting, None).unwrap(),
        );
        manifest.entries.insert(
            "failed".into(),
            Entry {
                id: "failed".into(),
                kind: "meeting".into(),
                status: "failed".into(),
                ..Default::default()
            },
        );
        assert!(wiki_sync_complete(&root, &manifest));
        assert_eq!(
            manifest
                .entries
                .values()
                .filter(|entry| eligible(entry))
                .count(),
            1
        );
        assert_eq!(
            store::search(&root, &manifest, "Untranscribed", 10).len(),
            0
        );
        assert_eq!(
            store::browse(&root, &manifest, "Untranscribed", 10).len(),
            1
        );
        waiting.transcript = "Transcription is now available".into();
        waiting.refresh_revision();
        manifest.entries.insert(
            waiting.id.clone(),
            write_document(&root, &waiting, None).unwrap(),
        );
        assert_eq!(
            manifest
                .entries
                .values()
                .filter(|entry| eligible(entry))
                .count(),
            2
        );
        manifest.entries.get_mut("failed").unwrap().status = "pending".into();
        assert!(!wiki_sync_complete(&root, &manifest));
        manifest.entries.get_mut("failed").unwrap().status = "conflict".into();
        assert!(!wiki_sync_complete(&root, &manifest));
        manifest.entries.get_mut("failed").unwrap().status = "synced".into();
        assert!(!wiki_sync_complete(&root, &manifest));
        let mut recovered = Document {
            id: "failed".into(),
            kind: "meeting".into(),
            transcript: "Recovered evidence".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        recovered.refresh_revision();
        manifest.entries.insert(
            recovered.id.clone(),
            write_document(&root, &recovered, None).unwrap(),
        );
        assert!(wiki_sync_complete(&root, &manifest));
        assert_eq!(
            manifest
                .entries
                .values()
                .filter(|entry| eligible(entry))
                .count(),
            3
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    fn test_session(base: String) -> Session {
        Session {
            agent_url: base.clone(),
            model_override: None,
            base_url: base,
            token: "synthetic-token".into(),
            scope: "account-a".into(),
            user_id: "verified-a".into(),
            locale: "en".into(),
            generation: 1,
        }
    }
    pub(super) fn mock_pages(
        responses: Vec<Value>,
    ) -> (Session, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let session = test_session(format!("http://{}", server.local_addr().unwrap()));
        let worker = std::thread::spawn(move || {
            let mut paths = vec![];
            for value in responses {
                let (mut socket, _) = server.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut data = [0u8; 4096];
                let count = socket.read(&mut data).unwrap();
                let header = String::from_utf8_lossy(&data[..count]);
                paths.push(header.lines().next().unwrap().to_string());
                let body = value.to_string();
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
            paths
        });
        (session, worker)
    }
    #[tokio::test]
    async fn all_pages_include_old_years_even_when_gateway_caps_page_size() {
        let mut pages = vec![];
        for page in 0..3 {
            let rows:Vec<Value>=(page*75..((page+1)*75).min(205)).map(|id|json!({"id":format!("meeting-{id}"),"createTime":if id==204{"1995-01-01"}else{"2026-10-01"}})).collect();
            pages.push(json!({"code":200,"data":rows,"total":205}));
        }
        let (session, server) = mock_pages(pages);
        let meetings = enumerate(&session).await.unwrap();
        assert_eq!(meetings.len(), 205);
        assert_eq!(meetings.last().unwrap()["createTime"], "1995-01-01");
        let paths = server.join().unwrap();
        assert_eq!(paths.len(), 3);
        assert!(paths[2].contains("pageNum=3"));
        assert!(paths
            .iter()
            .all(|path| !path.contains("startTime") && !path.contains("endTime")));
    }
    #[tokio::test]
    async fn truncated_or_repeated_pages_are_incomplete() {
        for pages in [
            vec![
                json!({"code":200,"data":[{"id":"one"}],"total":2}),
                json!({"code":200,"data":[],"total":2}),
            ],
            vec![
                json!({"code":200,"data":[{"id":"one"}],"total":2}),
                json!({"code":200,"data":[{"id":"one"}],"total":2}),
            ],
        ] {
            let (session, server) = mock_pages(pages);
            assert!(enumerate(&session).await.is_err());
            server.join().unwrap();
        }
    }
    #[tokio::test]
    async fn identity_is_derived_from_the_authenticated_profile() {
        let (session, server) =
            mock_pages(vec![json!({"code":200,"data":{"id":"verified-account"}})]);
        assert_eq!(
            verify_identity(&session.base_url, &session.token)
                .await
                .unwrap(),
            "verified-account"
        );
        assert!(server.join().unwrap()[0].contains("/api/business/customer/current"));
    }
    #[tokio::test]
    async fn identity_matches_lynclaw_when_user_and_customer_ids_differ() {
        for (profile, expected) in [
            (
                json!({"id":"customer-record", "userId":"verified-user"}),
                "verified-user",
            ),
            (json!({"id":17, "userId":42}), "42"),
            (
                json!({"userId":"  ", "user_id":" verified-user ", "id":"customer-record"}),
                "verified-user",
            ),
            (json!({"userId":null, "id":17}), "17"),
            (
                json!({"accountId":"verified-account", "customerId":"customer-record"}),
                "verified-account",
            ),
        ] {
            let (session, server) = mock_pages(vec![json!({"code":200,"data":profile})]);
            assert_eq!(
                verify_identity(&session.base_url, &session.token)
                    .await
                    .unwrap(),
                expected,
            );
            server.join().unwrap();
        }
    }
    #[tokio::test]
    async fn identity_rejects_profiles_without_account_identifiers() {
        for profile in [
            json!({"id":true}),
            json!({"userId":{}, "id":[]}),
            json!({"email":"user@example.test", "phone":"123", "nickname":"User"}),
        ] {
            let (session, server) = mock_pages(vec![json!({"code":200,"data":profile})]);
            assert!(verify_identity(&session.base_url, &session.token)
                .await
                .is_err());
            server.join().unwrap();
        }
    }
    #[test]
    fn transcript_has_speakers_times_and_all_detail_versions() {
        let (text, segments) = normalize_transcript(
            &json!({"transcriptionRecords":[{"id":"line-1","recognizedText":"决定周五发布","speakerName":"Sam","beginTime":12000,"endTime":15000}]}),
        );
        assert_eq!(text, "决定周五发布");
        assert_eq!(segments[0]["startMs"], 12000);
        assert_eq!(segments[0]["speakerName"], "Sam");
    }
    #[test]
    fn chunks_preserve_every_character_and_newline() {
        let text = "跨年会议\nNext action: confirm\n".repeat(500);
        let chunks = split_text(&text, 1200);
        assert!(chunks.iter().all(|c| c.chars().count() <= 1200));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn text_chunks_preserve_unicode_without_dropping_content() {
        let text = "会议讨论\n".repeat(10_000);
        let parts = split_text(&text, 12_000);
        assert_eq!(parts.concat(), text);
        assert!(parts.iter().all(|s| s.chars().count() <= 12_000));
    }
    #[test]
    fn unsupported_claims_and_changed_revisions_fail_closed() {
        let doc = Document {
            id: "one".into(),
            revision: "r1".into(),
            kind: "meeting".into(),
            transcript: "Ship on Friday".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            doc.id.clone(),
            Entry {
                id: doc.id.clone(),
                revision: "r1".into(),
                status: "synced".into(),
                ..Default::default()
            },
        );
        let good = json!({"citations":[{"id":"one","revision":"r1","quote":"Ship on Friday"}]});
        assert!(validate_result(&[doc.clone()], &manifest, &good).is_ok());
        let bad = json!({"citations":[{"id":"one","revision":"r1","quote":"Ship on Monday"}]});
        assert!(validate_result(&[doc.clone()], &manifest, &bad).is_err());
        manifest.entries.get_mut("one").unwrap().excluded = true;
        assert!(validate_result(&[doc], &manifest, &good).is_err());
    }
}
