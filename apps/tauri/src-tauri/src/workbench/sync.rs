use super::*;
use std::collections::BTreeSet;
use std::time::Duration;
use store::{eligible, read_document, write_document, Entry};

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
        token: token.into(),
        scope: String::new(),
        user_id: String::new(),
        agent_url: String::new(),
        locale: String::new(),
        generation: 0,
        model_override: None,
    };
    let identity = request(&session, "/api/business/customer/current", false, json!({})).await?;
    identity
        .get("id")
        .or_else(|| identity.get("userId"))
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_str()
                .map(String::from)
                .unwrap_or_else(|| v.to_string())
        })
        .filter(|v| !v.trim().is_empty())
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

async fn commit_document(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    document: Document,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let mut manifest = load_state(app, session)?;
    if !manifest.enabled {
        return Err("Memory disabled".into());
    }
    let (root, _) = roots(app, session)?;
    if manifest
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

pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        if !manifest.enabled {
            return Ok(());
        }
        manifest.phase = "discovering".into();
        manifest.error.clear();
        persist(app, session, &manifest)?;
    }
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
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        manifest.phase = "syncing".into();
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
    for mut row in local {
        if let Some(owner) = row.get("workbenchScope").and_then(Value::as_str) {
            if owner != session.scope {
                continue;
            }
        }
        let cloud_id = string(&row, &["cloudFileId"]);
        if !cloud_id.is_empty() && cloud_ids.contains(&cloud_id) {
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
        if string(&row, &["status"]) == "recorded" {
            let provider = crate::resolve_provider(
                app,
                row.get("language").and_then(Value::as_str),
                None,
                Some(&session.locale),
            );
            if crate::model_is_installed(app, provider.engine(), provider.model_id()) {
                let id = string(&row, &["id"]);
                if let Ok(updated) = crate::local_transcription_retry(app.clone(), id, None).await {
                    row = updated;
                }
                require_current(state, session)?;
            }
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
        let unchanged = {
            let _guard = state.serial.lock().await;
            let manifest = load_state(app, session)?;
            let (root, _) = roots(app, session)?;
            !string(row, &["updatedAt", "updateTime"]).is_empty()
                && manifest.entries.get(&id).is_some_and(|entry| {
                    entry.remote_revision == remote_revision
                        && matches!(entry.status.as_str(), "synced" | "awaiting_transcription")
                        && read_document(&root, entry).is_ok()
                })
        };
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
            loaded = cloud_document(session, row, &cloud_todos).await;
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
        return Err(error);
    }
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        let deleted: Vec<String> = manifest
            .entries
            .keys()
            .filter(|id| !active.contains(*id))
            .cloned()
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
        let failed = manifest
            .entries
            .values()
            .any(|entry| matches!(entry.status.as_str(), "failed" | "pending" | "conflict"));
        manifest.initial_complete = !failed;
        manifest.phase = if failed { "incomplete" } else { "ready" }.into();
        persist(app, session, &manifest)?;
        if failed {
            return Ok(());
        }
    }
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        if manifest.allow_ai {
            manifest.phase = "processing".into();
            persist(app, session, &manifest)?;
        }
    }
    synthesize_pending(app, state, session).await?;
    write_snapshot(app, state, session).await
}

fn split_text(text: &str, max: usize) -> Vec<String> {
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

pub(super) async fn synthesize(
    session: &Session,
    task: &str,
    documents: &[Document],
    query: Option<&str>,
) -> CommandResult<Value> {
    let mut budget = 60_000usize;
    let sources:Vec<Value>=documents.iter().filter_map(|doc|{
        if budget==0{return None;}
        let text=doc.text().chars().take(budget.min(12_000)).collect::<String>();budget=budget.saturating_sub(text.chars().count());
        if text.trim().is_empty(){return None;}
        Some(json!({"id":doc.id,"kind":doc.kind,"revision":doc.revision,"title":doc.title,"text":text,"segments":doc.segments,"todos":doc.todos}))
    }).collect();
    if session.agent_url != session.base_url {
        let registered = client()?
            .post(format!("{}/api/session/backend", session.agent_url))
            .header("Authorization", &session.token)
            .json(&json!({"host":session.base_url}))
            .send()
            .await
            .map_err(|_| "AI service could not verify this server")?;
        if !registered.status().is_success() {
            return Err("AI service could not verify this server".into());
        }
        let binding: Value = registered
            .json()
            .await
            .map_err(|_| "AI service returned an invalid server binding")?;
        if binding["host"]
            .as_str()
            .map(|host| host.trim_end_matches('/'))
            != Some(session.base_url.as_str())
            || binding["user_id"]
                .as_str()
                .is_none_or(|id| id.trim().is_empty())
        {
            return Err("AI service did not confirm this server identity".into());
        }
    }
    let body = json!({"task":task,"language":if session.locale.is_empty(){"en"}else{&session.locale},"sources":sources,"query":query,"modelOverride":session.model_override});
    let path = if session.agent_url == session.base_url {
        "/api/business/ai/desktop/synthesize"
    } else {
        "/api/desktop/synthesize"
    };
    let response = client()?
        .post(format!("{}{}", session.agent_url, path))
        .header("Authorization", &session.token)
        .json(&body)
        .send()
        .await
        .map_err(|_| "AI service is unavailable")?;
    if !response.status().is_success() {
        return Err(format!(
            "AI synthesis failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    unpack(
        response
            .json()
            .await
            .map_err(|_| "AI service returned invalid JSON")?,
    )
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

fn synthesis_key(session: &Session, revision: &str) -> String {
    store::digest(format!(
        "{}\n{}\ndesktop-evidence-v1\n{}\n{}",
        revision,
        session.agent_url,
        session.locale,
        session.model_override.as_ref().unwrap_or(&Value::Null)
    ))
}

async fn synthesize_pending(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    let pending = {
        let _guard = state.serial.lock().await;
        let manifest = load_state(app, session)?;
        if !manifest.enabled || !manifest.allow_ai || !manifest.initial_complete {
            return Ok(());
        }
        let (root, _) = roots(app, session)?;
        manifest
            .entries
            .values()
            .filter(|e| {
                eligible(e)
                    && e.synthesis_revision != synthesis_key(session, &e.revision)
                    && e.failed_synthesis_revision != synthesis_key(session, &e.revision)
            })
            .filter_map(|e| read_document(&root, e).ok())
            .filter(|d| d.ai_context_enabled && !d.text().trim().is_empty())
            .collect::<Vec<_>>()
    };
    for document in pending {
        require_current(state, session)?;
        let chunks = split_text(&document.text(), 12_000);
        let mut results = Vec::new();
        let mut failed = None;
        for chunk in chunks {
            let mut part = document.clone();
            part.transcript = chunk;
            part.outline.clear();
            part.conclusions.clear();
            part.todos.clear();
            part.segments.retain(|s| {
                part.transcript
                    .contains(&string(s, &["text", "recognizedText"]))
            });
            let mut result = None;
            for attempt in 0..3 {
                require_current(state, session)?;
                match synthesize(
                    session,
                    if document.kind == "meeting" {
                        "meeting_summary"
                    } else {
                        "memory_extract"
                    },
                    &[part.clone()],
                    None,
                )
                .await
                {
                    Ok(value) => {
                        result = Some(value);
                        break;
                    }
                    Err(error) => {
                        failed = Some(error);
                        if attempt < 2 {
                            tokio::time::sleep(Duration::from_secs(5 * (attempt + 1))).await;
                        }
                    }
                }
            }
            if let Some(value) = result {
                results.push(value);
            } else {
                break;
            }
        }
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        let (root, _) = roots(app, session)?;
        if !store::is_current_document(&root, &manifest, &document) {
            continue;
        }
        if results.is_empty() || results.len() != split_text(&document.text(), 12_000).len() {
            if let Some(entry) = manifest.entries.get_mut(&document.id) {
                entry.error = failed.unwrap_or_else(|| "AI processing failed".into());
                entry.failed_synthesis_revision = synthesis_key(session, &document.revision);
            }
            persist(app, session, &manifest)?;
            continue;
        }
        if let Some(error) = results
            .iter()
            .find_map(|result| validate_result(&[document.clone()], &manifest, result).err())
        {
            if let Some(entry) = manifest.entries.get_mut(&document.id) {
                entry.error = error;
                entry.failed_synthesis_revision = synthesis_key(session, &document.revision);
            }
            persist(app, session, &manifest)?;
            continue;
        }
        let artifact = manifest
            .artifacts
            .entry(document.id.clone())
            .or_insert_with(|| json!({"summaries":[],"todoSuggestions":[]}));
        let summaries = artifact["summaries"]
            .as_array_mut()
            .ok_or("Invalid local summaries")?;
        summaries.push(json!({"id":uuid::Uuid::new_v4().to_string(),"markdown":results.iter().filter_map(|r|r["summary"].as_str()).collect::<Vec<_>>().join("\n\n"),"createdAt":crate::now(),"sourceRevision":document.revision}));
        let mut proposals = artifact["todoSuggestions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for result in &results {
            for proposal in result["todoSuggestions"].as_array().into_iter().flatten() {
                let mut item = proposal.clone();
                item["id"] = json!(store::digest(format!(
                    "{}\n{}\n{}",
                    document.id, item["title"], item["citations"]
                )));
                if !proposals
                    .iter()
                    .any(|existing| existing["id"] == item["id"])
                {
                    proposals.push(item);
                }
            }
        }
        artifact["todoSuggestions"] = json!(proposals);
        let pinned: Vec<Value> = manifest
            .memories
            .iter()
            .filter(|m| m["pinned"] == true && m["sourceId"] == document.id)
            .cloned()
            .collect();
        manifest.memories.retain(|m| {
            m["sourceId"] != document.id || m["pinned"] == true || m["userEdited"] == true
        });
        for result in &results {
            for item in result["memoryItems"].as_array().into_iter().flatten() {
                let mut memory = item.clone();
                memory["id"] = json!(store::digest(format!(
                    "{}\n{}\n{}",
                    document.id, item["kind"], item["text"]
                )));
                memory["sourceId"] = json!(document.id);
                memory["updatedAt"] = json!(crate::now());
                memory["sourceTitle"] = json!(document.title);
                if !pinned.iter().any(|p| p["text"] == memory["text"])
                    && !manifest.memories.iter().any(|m| m["id"] == memory["id"])
                {
                    manifest.memories.push(memory);
                }
            }
        }
        if let Some(entry) = manifest.entries.get_mut(&document.id) {
            entry.synthesis_revision = synthesis_key(session, &document.revision);
            entry.error.clear();
        }
        persist(app, session, &manifest)?;
    }
    Ok(())
}
async fn write_snapshot(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let mut manifest = load_state(app, session)?;
    let (_, memory) = roots(app, session)?;
    store::write_memory_views(&memory, &manifest)?;
    let failed = manifest
        .entries
        .values()
        .filter(|entry| !entry.failed_synthesis_revision.is_empty())
        .count();
    manifest.phase = if failed > 0 { "incomplete" } else { "ready" }.into();
    if failed > 0 {
        manifest.error = format!("AI processing failed for {failed} sources; retry manually");
    }
    manifest.updated_at = crate::now();
    persist(app, session, &manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_session(base: String) -> Session {
        Session {
            base_url: base,
            token: "synthetic-token".into(),
            scope: "account-a".into(),
            user_id: "verified-a".into(),
            agent_url: String::new(),
            locale: "en".into(),
            generation: 1,
            model_override: None,
        }
    }
    fn mock_pages(responses: Vec<Value>) -> (Session, std::thread::JoinHandle<Vec<String>>) {
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
    fn dedupe_key_includes_prompt_model_and_language() {
        let mut session = test_session("http://localhost".into());
        let key = synthesis_key(&session, "r1");
        session.model_override = Some(json!({"model":"another-model"}));
        assert_ne!(key, synthesis_key(&session, "r1"));
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
