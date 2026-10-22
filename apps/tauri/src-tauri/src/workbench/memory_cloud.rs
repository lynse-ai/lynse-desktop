//! Markdown cache and retryable edits for the same cloud memory Lynclaw chat uses.
use super::{
    memory::{safe_path, MemoryRequest},
    require_beta, require_current, roots, store, Session, WorkbenchState,
};
use crate::CommandResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Default, Deserialize, Serialize)]
struct Cache {
    files: BTreeMap<String, Value>,
    pending: BTreeMap<String, Value>,
}

fn load(root: &Path) -> CommandResult<Cache> {
    if fs::symlink_metadata(root.join(".cloud-index.json"))
        .is_ok_and(|metadata| !metadata.is_file())
    {
        return Err("Cloud memory cache must be a regular file".into());
    }
    match fs::read(root.join(".cloud-index.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Cloud memory cache is unreadable; the original was preserved".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Cache::default()),
        Err(error) => Err(error.to_string()),
    }
}
fn persist(root: &Path, cache: &Cache) -> CommandResult<()> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    crate::atomic_write(
        &root.join(".cloud-index.json"),
        &serde_json::to_vec_pretty(cache).map_err(|e| e.to_string())?,
    )
}
fn put(root: &Path, cache: &mut Cache, document: Value) -> CommandResult<Value> {
    let path = document["path"]
        .as_str()
        .ok_or("Cloud memory returned no path")?;
    let file = safe_path(root, path)?;
    let markdown = document["markdown"]
        .as_str()
        .ok_or("Cloud memory returned no Markdown")?;
    if markdown.len() > 100_000 || document["revision"].as_str().is_none() {
        return Err("Cloud memory returned an invalid document".into());
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::atomic_write(&file, markdown.as_bytes())?;
    cache.files.insert(path.to_owned(), document.clone());
    persist(root, cache)?;
    Ok(document)
}
fn descriptor(document: &Value) -> Value {
    let mut result = document.clone();
    if let Some(object) = result.as_object_mut() {
        object.remove("markdown");
        object.remove("citations");
        object.remove("revision");
    }
    result
}
fn cached(root: &Path, cache: &mut Cache, path: &str) -> CommandResult<Value> {
    let mut document = cache
        .files
        .get(path)
        .cloned()
        .ok_or("Cloud memory is unavailable; connect once to cache this file")?;
    let file = safe_path(root, path)?;
    let metadata = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 100_000 {
        return Err("Invalid cached memory file".into());
    }
    let markdown = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    if document["markdown"].as_str() != Some(&markdown) && document["editable"] == true {
        queue(root, cache, path, &markdown, &document)?;
        document = cache.files[path].clone();
    }
    Ok(document)
}
fn queue(
    root: &Path,
    cache: &mut Cache,
    path: &str,
    markdown: &str,
    current: &Value,
) -> CommandResult<Value> {
    if markdown.trim().is_empty() || markdown.chars().count() > 8000 {
        return Err("Cloud memory text must contain 1–8000 characters".into());
    }
    let base = cache
        .pending
        .get(path)
        .and_then(|item| item["revision"].as_str())
        .or_else(|| current["revision"].as_str())
        .ok_or("Missing cloud memory revision")?
        .to_owned();
    let operation = cache
        .pending
        .get(path)
        .filter(|item| item["markdown"].as_str() == Some(markdown))
        .and_then(|item| item["operation_id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("desktop-memory-{}", uuid::Uuid::new_v4()));
    cache.pending.insert(
        path.to_owned(),
        json!({"path":path,"markdown":markdown,"revision":base,"operation_id":operation}),
    );
    let mut next = current.clone();
    next["markdown"] = json!(markdown);
    next["revision"] = json!(format!("local:{}", store::digest(markdown)));
    next["syncState"] = json!("pending");
    put(root, cache, next)
}

fn check_status(status: reqwest::StatusCode) -> CommandResult<()> {
    match status.as_u16() {
        200..=299 => Ok(()),
        409 => Err("Memory file changed; reload it before saving".into()),
        401 | 403 => Err("Cloud memory authorization required".into()),
        404 | 405 => Err("Cloud memory endpoint or file is unavailable".into()),
        429 | 500..=599 => Err("Cloud memory offline".into()),
        _ => Err("Cloud memory rejected this change; review its classification and consent".into()),
    }
}

fn verify_binding(binding: &Value, session: &Session) -> CommandResult<()> {
    let user_matches = binding["user_id"].as_str() == Some(&session.user_id);
    let host_matches = binding["host"]
        .as_str()
        .map(|host| host.trim_end_matches('/'))
        == Some(session.base_url.as_str());
    if !user_matches || !host_matches {
        log::warn!("[cloud-memory] binding mismatch: user_matches={user_matches}, host_matches={host_matches}");
        return Err("Cloud memory identity verification failed".into());
    }
    Ok(())
}

async fn request(
    app: &AppHandle,
    session: &Session,
    operation: &str,
    payload: Option<Value>,
    path: Option<&str>,
) -> CommandResult<Value> {
    let state = app.state::<WorkbenchState>();
    require_current(&state, session)?;
    require_beta(&state)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    if session.agent_url != session.base_url {
        let binding = client
            .post(format!("{}/api/session/backend", session.agent_url))
            .header("Authorization", &session.token)
            .json(&json!({"host":session.base_url}))
            .send()
            .await;
        require_current(&state, session)?;
        require_beta(&state)?;
        let binding = binding.map_err(|_| "Cloud memory offline")?;
        if let Err(error) = check_status(binding.status()) {
            log::warn!("[cloud-memory] session binding failed: HTTP {}", binding.status().as_u16());
            return Err(error);
        }
        let binding: Value = binding
            .json()
            .await
            .map_err(|_| "Cloud memory returned an invalid response")?;
        verify_binding(&binding, session)?;
    }
    require_current(&state, session)?;
    require_beta(&state)?;
    let prefix = if session.agent_url == session.base_url {
        "/api/business/ai/memory/files"
    } else {
        "/api/memory/files"
    };
    let mut url = url::Url::parse(&format!("{}{prefix}{operation}", session.agent_url))
        .map_err(|_| "Invalid cloud memory URL")?;
    if let Some(path) = path {
        url.query_pairs_mut().append_pair("path", path);
    }
    let mut call = if payload.is_some() {
        client.post(url)
    } else {
        client.get(url)
    };
    call = call.header("Authorization", &session.token);
    if let Some(body) = payload {
        call = call.json(&body);
    }
    let response = call.send().await;
    require_current(&state, session)?;
    require_beta(&state)?;
    let response = response.map_err(|_| "Cloud memory offline")?;
    if let Err(error) = check_status(response.status()) {
        let status = response.status().as_u16();
        let failure = response.json::<Value>().await.unwrap_or(Value::Null);
        require_current(&state, session)?;
        require_beta(&state)?;
        // Log only known error codes, never the response body or caller credentials.
        let code = match failure.pointer("/error/code").and_then(Value::as_str) {
            Some(code @ ("reauthentication_required" | "missing_token" | "invalid_token"
                | "identity_unavailable" | "context_unavailable" | "http_401" | "http_403")) => code,
            _ => "unclassified",
        };
        log::warn!("[cloud-memory] memory files request failed: HTTP {status}, code={code}");
        return Err(error);
    }
    let value = response
        .json()
        .await
        .map_err(|_| "Cloud memory returned an invalid response")?;
    require_current(&state, session)?;
    require_beta(&state)?;
    Ok(value)
}

async fn flush(
    app: &AppHandle,
    session: &Session,
    root: &Path,
    cache: &mut Cache,
) -> CommandResult<BTreeMap<String, Value>> {
    let mut saved = BTreeMap::new();
    for (path, pending) in cache.pending.clone() {
        match request(app, session, "/save", Some(pending), None).await {
            Ok(document) => {
                saved.insert(path.clone(), document.clone());
                cache.pending.remove(&path);
                cache.files.remove(&path);
                put(root, cache, document)?;
            }
            Err(error) if error == "Cloud memory offline" => break,
            Err(error) => {
                require_current(&app.state::<WorkbenchState>(), session)?;
                require_beta(&app.state::<WorkbenchState>())?;
                if error.contains("Account changed") || error.contains("authorization") {
                    return Err(error);
                }
                if let Some(document) = cache.files.get_mut(&path) {
                    document["syncState"] = json!("conflict");
                    document["syncError"] = json!(error);
                }
                persist(root, cache)?;
            }
        }
    }
    Ok(saved)
}

pub(super) async fn handle(
    app: &AppHandle,
    session: &Session,
    action: MemoryRequest,
) -> CommandResult<Value> {
    let (_, memory_root) = roots(app, session)?;
    let root = memory_root.join("cloud");
    // Reuse the account-scoped native serializer so local edits and retry state cannot race.
    let state = app.state::<WorkbenchState>();
    let _guard = state.serial.lock().await;
    require_current(&state, session)?;
    require_beta(&state)?;
    safe_path(&root, "MEMORY.md")?;
    let mut cache = load(&root)?;
    match action {
        MemoryRequest::List => {
            for path in cache.files.keys().cloned().collect::<Vec<_>>() {
                cached(&root, &mut cache, &path)?;
            }
            flush(app, session, &root, &mut cache).await?;
            match request(app, session, "", None, None).await {
                Ok(response) => {
                    let files = response["files"]
                        .as_array()
                        .ok_or("Invalid cloud memory file list")?;
                    let paths: BTreeSet<String> = files
                        .iter()
                        .filter_map(|file| file["path"].as_str().map(str::to_owned))
                        .collect();
                    let removed: Vec<_> = cache
                        .files
                        .keys()
                        .filter(|path| !paths.contains(*path) && !cache.pending.contains_key(*path))
                        .cloned()
                        .collect();
                    for path in removed {
                        cache.files.remove(&path);
                        let file = safe_path(&root, &path)?;
                        if file.exists() {
                            fs::remove_file(file).map_err(|e| e.to_string())?;
                        }
                    }
                    let mut result = files.clone();
                    for (path, document) in &cache.files {
                        if cache.pending.contains_key(path) {
                            result.retain(|file| file["path"].as_str() != Some(path));
                            result.push(descriptor(document));
                        }
                    }
                    persist(&root, &cache)?;
                    Ok(json!(result))
                }
                Err(error) if error == "Cloud memory offline" && !cache.files.is_empty() => {
                    Ok(json!(cache
                        .files
                        .values()
                        .map(descriptor)
                        .collect::<Vec<_>>()))
                }
                Err(error) => Err(error),
            }
        }
        MemoryRequest::Read { path } => {
            safe_path(&root, &path)?;
            if cache.files.contains_key(&path) {
                cached(&root, &mut cache, &path)?;
            }
            if cache.pending.contains_key(&path) {
                return cached(&root, &mut cache, &path);
            }
            match request(app, session, "/read", None, Some(&path)).await {
                Ok(document) => put(&root, &mut cache, document),
                Err(error) if error == "Cloud memory offline" => {
                    let mut document = cached(&root, &mut cache, &path)?;
                    if document["syncState"] != "pending" {
                        document["syncState"] = json!("offline");
                    }
                    Ok(document)
                }
                Err(error) => Err(error),
            }
        }
        MemoryRequest::Reload { path } => {
            safe_path(&root, &path)?;
            let document = request(app, session, "/read", None, Some(&path)).await?;
            cache.pending.remove(&path);
            put(&root, &mut cache, document)
        }
        MemoryRequest::Save {
            path,
            markdown,
            revision,
        } => {
            let current = cached(&root, &mut cache, &path)?;
            if current["editable"] != true {
                return Err("Memory snapshots are read-only".into());
            }
            if current["revision"].as_str() != Some(&revision) {
                return Err("Memory file changed; reload it before saving".into());
            }
            queue(&root, &mut cache, &path, &markdown, &current)?;
            let saved = flush(app, session, &root, &mut cache).await?;
            if let Some(document) = saved.get(&path) {
                return Ok(document.clone());
            }
            if let Some(next) = cache.files.get(&path) {
                return Ok(next.clone());
            }
            Err("Saved cloud memory could not be reloaded".into())
        }
        MemoryRequest::Create { title } => {
            let document = request(app, session, "/create", Some(json!({"title":title,"operation_id":format!("desktop-memory-{}", uuid::Uuid::new_v4())})), None).await?;
            put(&root, &mut cache, document)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_keeps_verified_account_and_backend_isolation() {
        let session = Session {
            scope: "account".into(),
            user_id: "verified-user".into(),
            base_url: "https://backend.test".into(),
            agent_url: "https://agent.test".into(),
            token: "synthetic-token".into(),
            model_override: None,
            locale: "en".into(),
            generation: 0,
        };
        assert!(verify_binding(
            &json!({"user_id":"verified-user", "host":"https://backend.test/"}),
            &session,
        )
        .is_ok());
        for binding in [
            json!({"user_id":"customer-record", "host":"https://backend.test"}),
            json!({"user_id":"verified-user", "host":"https://other-backend.test"}),
            json!({"host":"https://backend.test"}),
        ] {
            assert!(verify_binding(&binding, &session).is_err());
        }
    }

    #[test]
    fn service_failures_do_not_require_another_login() {
        for (status, error) in [
            (401, "Cloud memory authorization required"),
            (403, "Cloud memory authorization required"),
            (404, "Cloud memory endpoint or file is unavailable"),
            (405, "Cloud memory endpoint or file is unavailable"),
            (429, "Cloud memory offline"),
            (503, "Cloud memory offline"),
            (409, "Memory file changed; reload it before saving"),
        ] {
            assert_eq!(
                check_status(reqwest::StatusCode::from_u16(status).unwrap()).unwrap_err(),
                error,
            );
        }
    }

    #[test]
    fn offline_edits_preserve_the_cloud_base_and_survive_restart() {
        let root = std::env::temp_dir().join(format!("memory-cloud-{}", uuid::Uuid::new_v4()));
        let mut cache = Cache::default();
        let doc = json!({"path":"MEMORY.md","title":"Memory","markdown":"# Original","revision":"mem-one:3","editable":true,"syncState":"synced"});
        put(&root, &mut cache, doc.clone()).unwrap();
        queue(&root, &mut cache, "MEMORY.md", "# First edit", &doc).unwrap();
        let mut cache = load(&root).unwrap();
        let current = cached(&root, &mut cache, "MEMORY.md").unwrap();
        queue(&root, &mut cache, "MEMORY.md", "# Second edit", &current).unwrap();
        assert_eq!(cache.pending["MEMORY.md"]["revision"], "mem-one:3");
        assert_eq!(
            load(&root).unwrap().files["MEMORY.md"]["markdown"],
            "# Second edit"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_markdown_edits_are_queued_without_changing_the_cloud_base() {
        let root = std::env::temp_dir().join(format!("memory-cloud-{}", uuid::Uuid::new_v4()));
        let mut cache = Cache::default();
        put(&root, &mut cache, json!({"path":"MEMORY.md","title":"Memory","markdown":"# Original","revision":"mem-one:3","editable":true,"syncState":"synced"})).unwrap();
        fs::write(root.join("MEMORY.md"), "# External correction").unwrap();
        let document = cached(&root, &mut cache, "MEMORY.md").unwrap();
        assert_eq!(document["markdown"], "# External correction");
        assert_eq!(document["syncState"], "pending");
        assert_eq!(
            load(&root).unwrap().pending["MEMORY.md"]["revision"],
            "mem-one:3"
        );
        assert!(safe_path(&root, "../other-user/MEMORY.md").is_err());
        #[cfg(unix)]
        {
            fs::create_dir(root.join("notes")).unwrap();
            std::os::unix::fs::symlink(root.join("MEMORY.md"), root.join("notes/alias.md"))
                .unwrap();
            assert!(safe_path(&root, "notes/alias.md").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
