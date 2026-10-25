//! Versioned opaque sync. An encrypted record never falls back to the v1 client.
use super::*;
use reqwest::{Client, Method};
use sha2::{Digest, Sha256};
use std::io::Read;

fn ops_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(index_path(app)?.with_file_name("ops.json"))
}
pub fn ops(app: &AppHandle) -> CommandResult<Vec<Value>> {
    let mut pending = crate::read_array(&ops_path(app)?)?;
    // The row and its signed operation share one atomic index write. Recover a
    // process failure between that write and updating the secondary queue.
    for row in crate::read_array(&index_path(app)?)? {
        if let Some(op) = row.get("_sync_op").filter(|v| v.is_object()) {
            pending.retain(|old| old["id"] != row["id"]);
            pending.push(op.clone());
        }
    }
    Ok(pending)
}
fn save_ops(app: &AppHandle, ops: &[Value]) -> CommandResult<()> {
    crate::write_array(&ops_path(app)?, ops)
}
pub fn sign_body(app: &AppHandle, action: &str, body: Value) -> CommandResult<Value> {
    let owner = scope(app)?;
    with_bundle(app, |bundle| {
        let mut body = body;
        let signature = crypto::sign(
            &crypto::decode(bundle["sign_seed"].as_str().ok_or("invalid_device_key")?)?,
            &json!({"action":action,"account_scope":owner,"payload":body}),
        )?;
        body["proof"] = json!({"device_id":bundle["device_id"],"signature":signature});
        Ok(body)
    })
}
pub fn wire(row: &Value) -> CommandResult<Value> {
    let mut result = json!({"previously_plain":row["historyCleanup"]=="unverified","account_scope":row["account_scope"],"id":row["id"],"protection":row["protection"].as_str().unwrap_or("plain"),"base_version":row["version"].as_u64().unwrap_or(0),"created_at":row["createdAt"],"media_ids":row["media_ids"].as_array().cloned().unwrap_or_default(),"ai_context_enabled":row["aiContextEnabled"].as_bool().unwrap_or(false)});
    if row["protection"] == "e2ee" {
        for key in [
            "crypto_version",
            "content_revision",
            "key_epoch",
            "envelope",
        ] {
            result[key] = row[key].clone();
        }
        result["ai_context_enabled"] = json!(false);
    } else {
        let mut content = row.clone();
        for key in [
            "account_scope",
            "version",
            "syncState",
            "transition",
            "serverRecord",
            "deletedAt",
            "media_ids",
            "_sync_op",
        ] {
            content.as_object_mut().ok_or("invalid_record")?.remove(key);
        }
        result["payload"] = content;
    }
    Ok(result)
}
pub fn from_wire(row: &Value) -> CommandResult<Value> {
    let mut local = if row["protection"] == "plain" {
        row["payload"].clone()
    } else {
        json!({})
    };
    if !local.is_object() {
        local = json!({});
    }
    for field in [
        "id",
        "account_scope",
        "protection",
        "version",
        "media_ids",
        "crypto_version",
        "content_revision",
        "key_epoch",
        "envelope",
    ] {
        if let Some(v) = row.get(field) {
            local[field] = v.clone();
        }
    }
    local["historyCleanup"] = row["history_cleanup"].clone();
    local["legacyImported"] = json!(row["legacy_owned"] == true);
    local["createdAt"] = row["created_at"].clone();
    local["updatedAt"] = row["updated_at"].clone();
    local["aiContextEnabled"] =
        json!(row["protection"] != "e2ee" && row["ai_context_enabled"].as_bool().unwrap_or(false));
    if local["protection"] == "plain" {
        for asset in asset_entries(&local) {
            let file = asset["file"].as_str().ok_or("invalid_attachment")?;
            uuid::Uuid::parse_str(file).map_err(|_| "invalid_attachment")?;
            if !local["media_ids"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == file))
            {
                return Err("invalid_attachment".into());
            }
        }
    }
    local["syncState"] = json!("synced");
    if let Some(date) = row["deleted_at"].as_str().filter(|s| !s.is_empty()) {
        local["deletedAt"] = json!(date);
    }
    Ok(local)
}
fn digest(path: &Path) -> CommandResult<(u64, String)> {
    let mut file = File::open(path).map_err(|_| "attachment_unavailable")?;
    let mut buf = vec![0; crypto::CHUNK];
    let mut hash = Sha256::new();
    let mut size = 0;
    loop {
        let n = file.read(&mut buf).map_err(|_| "attachment_read_failed")?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hash.update(&buf[..n]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}
pub(super) fn file_specs(app: &AppHandle, row: &Value) -> CommandResult<Vec<Value>> {
    let mut files = Vec::new();
    for id in row["media_ids"].as_array().into_iter().flatten() {
        let id = id.as_str().ok_or("invalid_attachment")?;
        uuid::Uuid::parse_str(id).map_err(|_| "invalid_attachment")?;
        let (size, hash) = digest(
            &directory(app, row["id"].as_str().ok_or("invalid_record")?)?.join(format!("{id}.bin")),
        )?;
        let mut spec = json!({"account_scope":row["account_scope"],"id":id,"size_bytes":size,"sha256":hash,"kind":"file","protection":row["protection"].as_str().unwrap_or("plain")});
        if row["protection"] == "e2ee" {
            spec = sign_body(app, "media_prepare", spec)?;
        }
        files.push(spec);
    }
    Ok(files)
}
fn make_operation(app: &AppHandle, row: &Value) -> CommandResult<Value> {
    let mut body = wire(row)?;
    if row["protection"] == "e2ee" {
        body = sign_body(app, "save", body)?;
    }
    Ok(
        json!({"id":row["id"],"operation_id":uuid::Uuid::new_v4().to_string(),"kind":"save","body":body,"files":file_specs(app,row)?}),
    )
}
fn persist_operation(app: &AppHandle, row: &Value, op: Value) -> CommandResult<()> {
    let mut pending = ops(app)?;
    pending.retain(|old| old["id"] != row["id"]);
    pending.push(op.clone());
    let mut row = row.clone();
    row["_sync_op"] = op;
    put(app, &row)?;
    save_ops(app, &pending)
}
pub fn queue(app: &AppHandle, row: &Value) -> CommandResult<()> {
    persist_operation(app, row, make_operation(app, row)?)
}
pub(super) fn transport(app: &AppHandle, owner: &str) -> CommandResult<Option<Zeroizing<String>>> {
    let state = app.state::<PrivateState>();
    let cache = state.transport.lock().map_err(|_| "session_unavailable")?;
    Ok(cache
        .as_ref()
        .filter(|(scope, _)| scope == owner)
        .map(|(_, token)| Zeroizing::new(token.to_string())))
}
pub async fn request(
    app: &AppHandle,
    method: Method,
    path: &str,
    body: Option<&Value>,
    operation: Option<&str>,
) -> CommandResult<Value> {
    let owner = body
        .and_then(|body| {
            body["account_scope"]
                .as_str()
                .or(body["record"]["account_scope"].as_str())
                .or(body["device"]["account_scope"].as_str())
        })
        .map(str::to_owned)
        .unwrap_or(scope(app)?);
    request_scoped(app, &owner, method, path, body, operation).await
}
async fn request_scoped(
    app: &AppHandle,
    owner: &str,
    method: Method,
    path: &str,
    body: Option<&Value>,
    operation: Option<&str>,
) -> CommandResult<Value> {
    let (binding, generation, token) = {
        let state = app.state::<PrivateState>();
        let _guard = state.serial.lock().map_err(|_| "session_unavailable")?;
        let binding = inspiration_cloud::read_binding(app)?.ok_or("verified_account_required")?;
        if binding.account_scope != owner {
            return Err("account_changed".into());
        }
        let token = state.token.lock().map_err(|_| "session_unavailable")?;
        let token = Zeroizing::new(token.as_ref().ok_or("cloud_offline")?.to_string());
        if format!("{:x}", Sha256::digest(token.as_bytes())) != binding.token_fingerprint {
            return Err("account_changed".into());
        }
        (
            binding,
            state.binding_generation.load(Ordering::SeqCst),
            token,
        )
    };
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "network_unavailable")?;
    let mut req = client
        .request(
            method,
            format!("{}{}", binding.api_base.trim_end_matches('/'), path),
        )
        .bearer_auth(&*token);
    if !binding.backend_host.is_empty() {
        req = req.header("X-Lynse-Backend-Host", &binding.backend_host);
    }
    if let Some(cap) = transport(app, &binding.account_scope)? {
        req = req.header("X-Lynse-Private-Session", &*cap);
    }
    if let Some(body) = body {
        req = req.json(body)
    }
    if let Some(id) = operation {
        req = req.header("Operation-Id", id)
    }
    let response = req.send().await.map_err(|_| "cloud_offline")?;
    let status = response.status();
    if binding.account_scope
        != inspiration_cloud::read_binding(app)?
            .ok_or("account_changed")?
            .account_scope
    {
        return Err("account_changed".into());
    }
    // A lock can safely allow opaque sync, but an account switch cannot.
    if generation
        != app
            .state::<PrivateState>()
            .binding_generation
            .load(Ordering::SeqCst)
    {
        return Err("account_changed".into());
    }
    let result: Value = response
        .json()
        .await
        .map_err(|_| "invalid_cloud_response")?;
    if generation
        != app
            .state::<PrivateState>()
            .binding_generation
            .load(Ordering::SeqCst)
    {
        return Err("account_changed".into());
    }
    if result["account_scope"]
        .as_str()
        .is_some_and(|scope| scope != owner)
    {
        return Err("account_changed".into());
    }
    if !status.is_success() {
        return Err(result
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("cloud_request_failed")
            .to_owned());
    }
    Ok(result)
}
pub(super) async fn upload(
    app: &AppHandle,
    row_id: &str,
    spec: &Value,
    operation: &str,
) -> CommandResult<()> {
    let owner = spec["account_scope"]
        .as_str()
        .ok_or("invalid_account_scope")?;
    if scope(app)? != owner {
        return Err("account_changed".into());
    }
    let id = spec["id"].as_str().ok_or("invalid_attachment")?;
    let base = format!("/v2/inspirations/{row_id}/media");
    let remote = request_scoped(
        app,
        owner,
        Method::POST,
        &base,
        Some(spec),
        Some(&format!("{operation}-prepare-{id}")),
    )
    .await?;
    if remote["state"] == "active" {
        return Ok(());
    }
    let done = remote["parts"].as_array().map(Vec::len).unwrap_or(0);
    let (binding, token, path) = {
        let state = app.state::<PrivateState>();
        let _guard = state.serial.lock().map_err(|_| "session_unavailable")?;
        let binding = inspiration_cloud::read_binding(app)?.ok_or("account_changed")?;
        if binding.account_scope != owner {
            return Err("account_changed".into());
        }
        let token = state.token.lock().map_err(|_| "session_unavailable")?;
        let token = Zeroizing::new(token.as_ref().ok_or("cloud_offline")?.to_string());
        if format!("{:x}", Sha256::digest(token.as_bytes())) != binding.token_fingerprint {
            return Err("account_changed".into());
        }
        (
            binding,
            token,
            directory(app, row_id)?.join(format!("{id}.bin")),
        )
    };
    let mut file = File::open(path).map_err(|_| "attachment_unavailable")?;
    let mut buf = vec![0; crypto::CHUNK];
    let mut index = 0;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "network_unavailable")?;
    loop {
        let count = file.read(&mut buf).map_err(|_| "attachment_read_failed")?;
        if count == 0 {
            break;
        }
        if index >= done {
            if scope(app)? != binding.account_scope {
                return Err("account_changed".into());
            }
            let mut req = client
                .put(format!(
                    "{}{}{id}/parts/{index}",
                    binding.api_base.trim_end_matches('/'),
                    format!("{base}/")
                ))
                .bearer_auth(&*token)
                .header("Content-Type", "application/octet-stream")
                .body(buf[..count].to_vec());
            if !binding.backend_host.is_empty() {
                req = req.header("X-Lynse-Backend-Host", &binding.backend_host)
            }
            if let Some(cap) = transport(app, &binding.account_scope)? {
                req = req.header("X-Lynse-Private-Session", &*cap);
            }
            let response = req.send().await.map_err(|_| "cloud_offline")?;
            if !response.status().is_success() {
                return Err("attachment_upload_failed".into());
            }
        }
        index += 1;
    }
    request_scoped(
        app,
        owner,
        Method::POST,
        &format!("{base}/{id}/finalize"),
        Some(&json!({})),
        Some(&format!("{operation}-finalize-{id}")),
    )
    .await?;
    Ok(())
}
async fn download(app: &AppHandle, row: &Value) -> CommandResult<()> {
    let owner = row["account_scope"]
        .as_str()
        .ok_or("invalid_account_scope")?;
    if scope(app)? != owner {
        return Err("account_changed".into());
    }
    let id = row["id"].as_str().ok_or("invalid_record")?;
    let dir = directory(app, id)?;
    fs::create_dir_all(&dir).map_err(|_| "storage_unavailable")?;
    for asset in row["media_ids"].as_array().into_iter().flatten() {
        let asset = asset.as_str().ok_or("invalid_attachment")?;
        uuid::Uuid::parse_str(asset).map_err(|_| "invalid_attachment")?;
        let target = dir.join(format!("{asset}.bin"));
        if target.exists() {
            continue;
        }
        let report = request_scoped(
            app,
            owner,
            Method::GET,
            &format!("/v2/inspirations/{id}/media/{asset}/download"),
            None,
            None,
        )
        .await?;
        let temp = dir.join(format!("{asset}.download"));
        let result: CommandResult<()> = async {
            let mut out = File::create(&temp).map_err(|_| "storage_unavailable")?;
            let mut hash = Sha256::new();
            let mut size = 0u64;
            for part in report["parts"].as_array().ok_or("invalid_cloud_response")? {
                let url = reqwest::Url::parse(part["url"].as_str().ok_or("invalid_download_url")?)
                    .map_err(|_| "invalid_download_url")?;
                if url.scheme() != "https"
                    && !(url.scheme() == "http"
                        && matches!(url.host_str(), Some("127.0.0.1" | "localhost")))
                {
                    return Err("invalid_download_url".into());
                }
                // Storage URLs never receive the user's Lynse token.
                let client = Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(60))
                    .build()
                    .map_err(|_| "network_unavailable")?;
                let mut response = client
                    .get(url)
                    .send()
                    .await
                    .map_err(|_| "attachment_download_failed")?;
                if !response.status().is_success() {
                    return Err("attachment_download_failed".into());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| "attachment_download_failed")?
                {
                    if bytes.len() + chunk.len() > crypto::CHUNK + 64 {
                        return Err("attachment_too_large".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                if bytes.len() > crypto::CHUNK + 64
                    || Some(bytes.len() as u64) != part["size_bytes"].as_u64()
                    || format!("{:x}", Sha256::digest(&bytes))
                        != part["sha256"].as_str().unwrap_or("")
                {
                    return Err("attachment_checksum_failed".into());
                }
                size += bytes.len() as u64;
                if size > 201 * 1024 * 1024 {
                    return Err("attachment_too_large".into());
                }
                hash.update(&bytes);
                out.write_all(&bytes).map_err(|_| "storage_unavailable")?;
            }
            if Some(size) != report["size_bytes"].as_u64()
                || format!("{:x}", hash.finalize()) != report["sha256"].as_str().unwrap_or("")
            {
                return Err("attachment_checksum_failed".into());
            }
            out.sync_all().map_err(|_| "storage_unavailable")?;
            if scope(app)? != owner {
                return Err("account_changed".into());
            }
            fs::rename(&temp, &target).map_err(|_| "storage_unavailable")?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
    }
    Ok(())
}
pub async fn sync(app: &AppHandle, token: String) -> CommandResult<Value> {
    let state = app.state::<PrivateState>();
    let _sync = state.sync.lock().await;
    let owner = scope(app)?;
    if !inspiration_cloud::read_binding(app)?.is_some_and(|binding| {
        binding.token_fingerprint == format!("{:x}", Sha256::digest(token.as_bytes()))
    }) {
        return Err("account_changed".into());
    }
    devices::finish_bootstrap(app).await?;
    devices::refresh(app).await?;
    {
        let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
        if scope(app)? != owner {
            return Err("account_changed".into());
        }
        for row in crate::read_array(&index_path(app)?)? {
            if row["syncState"] == "local"
                && row["deletedAt"].is_null()
                && row["transition"].is_null()
                && !ops(app)?.iter().any(|op| op["id"] == row["id"])
            {
                if row["protection"] != "e2ee" || with_bundle(app, |_| Ok(())).is_ok() {
                    queue(app, &row)?;
                }
            }
        }
    }
    let mut submitted = 0;
    for mut op in ops(app)? {
        if scope(app)? != owner {
            return Err("account_changed".into());
        }
        let id = op["id"].as_str().ok_or("invalid_record")?.to_owned();
        let operation = op["operation_id"]
            .as_str()
            .ok_or("invalid_operation")?
            .to_owned();
        let result: CommandResult<()> = async {
            if op["kind"] == "delete" {
                request_scoped(
                    app,
                    &owner,
                    Method::DELETE,
                    &format!("/v2/inspirations/{id}"),
                    Some(&op["body"]),
                    Some(&operation),
                )
                .await?;
            } else {
                if op["kind"] != "transition" && op["submitted_version"].is_null() {
                    let creating = op["body"]["base_version"].as_u64().unwrap_or(0) == 0;
                    let method = if creating {
                        Method::POST
                    } else {
                        Method::PATCH
                    };
                    let path = if creating {
                        "/v2/inspirations".into()
                    } else {
                        format!("/v2/inspirations/{id}")
                    };
                    let remote = request_scoped(
                        app,
                        &owner,
                        method,
                        &path,
                        Some(&op["body"]),
                        Some(&operation),
                    )
                    .await?;
                    if op["body"]["payload"]["legacyImported"] == true {
                        request_scoped(
                            app,
                            &owner,
                            Method::POST,
                            &format!("/v2/inspirations/{id}/legacy-claim"),
                            Some(&json!({"acknowledge":true})),
                            Some(&format!("{operation}-legacy-claim")),
                        )
                        .await?;
                    }
                    op["submitted_version"] = remote["version"].clone();
                    let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
                    if scope(app)? != owner {
                        return Err("account_changed".into());
                    }
                    if scope(app)? != owner {
                        return Err("account_changed".into());
                    }
                    let mut pending = ops(app)?;
                    if let Some(current) =
                        pending.iter_mut().find(|o| o["operation_id"] == operation)
                    {
                        *current = op.clone();
                    }
                    save_ops(app, &pending)?;
                    let mut local = stored(app, &id)?;
                    local["version"] = remote["version"].clone();
                    local["_sync_op"] = op.clone();
                    put(app, &local)?;
                }
                for spec in op["files"].as_array().into_iter().flatten() {
                    upload(app, &id, spec, &operation).await?;
                }
                if op["kind"] == "transition" {
                    let transition = op["transition_id"].as_str().ok_or("invalid_transition")?;
                    let remote = request_scoped(
                        app,
                        &owner,
                        Method::POST,
                        &format!("/v2/inspirations/{id}/transitions/{transition}/commit"),
                        Some(&op["body"]),
                        Some(&operation),
                    )
                    .await?;
                    let row = {
                        let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
                        if scope(app)? != owner {
                            return Err("account_changed".into());
                        }
                        let mut row = stored(app, &id)?;
                        row["version"] = remote["version"].clone();
                        row.as_object_mut()
                            .ok_or("invalid_record")?
                            .remove("transition");
                        row["syncState"] = json!("synced");
                        put(app, &row)?;
                        row
                    };
                    // Verify the committed envelope before retiring app-owned old files.
                    let verified = request_scoped(
                        app,
                        &owner,
                        Method::GET,
                        &format!("/v2/inspirations/{id}"),
                        None,
                        None,
                    )
                    .await?;
                    if verified["version"] != row["version"]
                        || verified["protection"] != row["protection"]
                    {
                        return Err("transition_readback_failed".into());
                    }
                    if row["protection"] == "e2ee" && verified["envelope"] != row["envelope"] {
                        return Err("transition_readback_failed".into());
                    }
                    {
                        let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
                        if scope(app)? != owner {
                            return Err("account_changed".into());
                        }
                        cleanup_conversion(app, &row)?;
                    }
                } else {
                    let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
                    if scope(app)? != owner {
                        return Err("account_changed".into());
                    }
                    let mut local = stored(app, &id)?;
                    local["syncState"] = json!("synced");
                    put(app, &local)?;
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            if scope(app)? != owner {
                return Err("account_changed".into());
            }
            if error == "version_conflict" {
                let mut local = stored(app, &id)?;
                local["syncState"] = json!("conflict");
                put(app, &local)?;
            }
            let _ = app.emit("inspiration-sync-error", json!({"code":error}));
            return Ok(json!({"error":error,"pendingOps":ops(app)?.len(),"submitted":submitted}));
        }
        let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
        if scope(app)? != owner {
            return Err("account_changed".into());
        }
        let mut local = stored(app, &id)?;
        if local["_sync_op"]["operation_id"] == operation {
            local
                .as_object_mut()
                .ok_or("invalid_record")?
                .remove("_sync_op");
            put(app, &local)?;
        }
        let mut pending = ops(app)?;
        pending.retain(|o| o["operation_id"] != operation);
        save_ops(app, &pending)?;
        submitted += 1;
    }
    let remote = request_scoped(app, &owner, Method::GET, "/v2/inspirations", None, None).await?;
    for record in remote["records"]
        .as_array()
        .ok_or("invalid_cloud_response")?
    {
        if scope(app)? != owner {
            return Err("account_changed".into());
        }
        let id = record["id"].as_str().ok_or("invalid_record")?;
        let pending = ops(app)?;
        if pending.iter().any(|o| o["id"] == id) {
            continue;
        }
        let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
        if scope(app)? != owner {
            return Err("account_changed".into());
        }
        if record["locked"] == true {
            if record["transition"].is_string() {
                if let Ok(mut existing) = stored(app, id) {
                    if existing["transition"].is_object() {
                        continue;
                    }
                    existing["transition"] = json!({"id":record["transition"],"phase":"remote"});
                    existing["aiContextEnabled"] = json!(false);
                    put(app, &existing)?;
                }
            }
            continue;
        }
        if stored(app, id).is_ok_and(|row| {
            row["syncState"] == "local"
                || (row["transition"].is_object() && row["transition"]["phase"] != "remote")
        }) {
            continue;
        }
        let local = from_wire(record)?;
        if let Ok(existing) = stored(app, id) {
            if existing["version"].as_u64().unwrap_or(0) > local["version"].as_u64().unwrap_or(0) {
                return Err("cloud_revision_rollback".into());
            }
        }
        put(app, &local)?;
        drop(_guard);
        if local["deletedAt"].is_null() {
            if let Err(code) = download(app, &local).await {
                let _ = app.emit("inspiration-sync-error", json!({"code":code}));
            }
        } else {
            let _ = fs::remove_dir_all(directory(app, id)?);
        }
    }
    request_scoped(
        app,
        &owner,
        Method::POST,
        "/v2/private/cleanup",
        Some(&json!({})),
        Some(&uuid::Uuid::new_v4().to_string()),
    )
    .await?;
    Ok(json!({"submitted":submitted,"pendingOps":ops(app)?.len()}))
}
pub(super) fn cleanup_conversion(app: &AppHandle, row: &Value) -> CommandResult<()> {
    let ids = row["media_ids"].as_array().cloned().unwrap_or_default();
    let dir = directory(app, row["id"].as_str().ok_or("invalid_record")?)?;
    for entry in fs::read_dir(dir)
        .map_err(|_| "attachment_cleanup_failed")?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".bin") {
            if uuid::Uuid::parse_str(id).is_ok() && !ids.iter().any(|v| v == id) {
                fs::remove_file(entry.path()).map_err(|_| "attachment_cleanup_failed")?
            }
        }
    }
    if row["protection"] == "e2ee" {
        let id = row["id"].as_str().ok_or("invalid_record")?;
        crate::vault::remove_journal(app, id);
        if row["legacyImported"] == true {
            let uuid = id.trim_start_matches("inspiration:");
            for path in [
                crate::app_data_dir(app)?.join("inspirations").join(uuid),
                crate::vault::content_dir(app, crate::vault::ContentKind::Inspirations)?.join(uuid),
            ] {
                if path.is_dir() {
                    fs::remove_dir_all(path).map_err(|_| "attachment_cleanup_failed")?;
                }
            }
        }
    } else {
        crate::vault::sync_journal(app, row)
    }
    Ok(())
}
#[tauri::command]
pub async fn inspiration_toggle_protection(app: AppHandle, id: String) -> CommandResult<Value> {
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    with_bundle(&app, |_| Ok(()))?;
    if !inspiration_cloud::read_binding(&app)?.is_some_and(|binding| binding.private_enabled) {
        return Err("private_storage_unavailable".into());
    }
    let metadata: Value = serde_json::from_slice(
        &fs::read(key_path(&app)?).map_err(|_| "device_package_unavailable")?,
    )
    .map_err(|_| "invalid_key_bundle")?;
    if metadata["recoveryConfirmed"] == false {
        return Err("recovery_confirmation_required".into());
    }
    let state = app.state::<PrivateState>();
    let sync_guard = state.sync.lock().await;
    let mut old = stored(&app, &id)?;
    if old["transition"].is_object() && old["transition"]["phase"] != "preparing" {
        return Err("protection_transition_pending".into());
    }
    if old["syncState"] == "local"
        && old["version"].as_u64().unwrap_or(0) > 0
        && old["transition"].is_null()
    {
        return Err("sync_before_protection_change".into());
    }
    let target = if old["transition"]["target"].is_string() {
        old["transition"]["target"].as_str().unwrap().to_owned()
    } else if old["protection"] == "e2ee" {
        "plain".to_owned()
    } else {
        "e2ee".to_owned()
    };
    let transition = old["transition"]["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let version = old["version"].as_u64().unwrap_or(0);
    old["transition"] = json!({"id":transition,"target":target,"phase":"preparing"});
    old["aiContextEnabled"] = json!(false);
    {
        let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
        put(&app, &old)?;
    }
    if version > 0 {
        let begin = sign_body(
            &app,
            "transition",
            json!({"target":target,"base_version":version,"transition_id":transition}),
        )?;
        let remote = request(
            &app,
            Method::POST,
            &format!("/v2/inspirations/{id}/transitions"),
            Some(&begin),
            Some(&format!("{transition}-begin")),
        )
        .await?;
        if remote["id"] != transition || remote["target"] != target {
            return Err("transition_conflict".into());
        }
    }
    let guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
    if stored(&app, &id)?["updatedAt"] != old["updatedAt"] {
        return Err("version_conflict".into());
    }
    let mut created = CreatedAssets::new();
    let mut content = payload(&app, &old)?;
    content.0["aiContextEnabled"] = json!(false);
    content.0["protection"] = json!(target);
    let dir = directory(&app, &id)?;
    for field in ["images", "files", "audio"] {
        let entries = if field == "audio" {
            content.0[field]
                .as_object()
                .map(|_| vec![content.0[field].clone()])
                .unwrap_or_default()
        } else {
            content.0[field].as_array().cloned().unwrap_or_default()
        };
        let mut converted = Vec::new();
        for mut asset in entries {
            let previous = asset["file"].as_str().ok_or("invalid_attachment")?;
            let source = dir.join(format!("{previous}.bin"));
            let next = uuid::Uuid::new_v4().to_string();
            let destination = dir.join(format!("{next}.bin"));
            created.paths.push(destination.clone());
            let mut out = File::create(&destination).map_err(|_| "attachment_write_failed")?;
            if target == "e2ee" {
                let key = crypto::random_key()?;
                crypto::encrypt_file(
                    &mut RevocableReader::new(
                        File::open(source).map_err(|_| "attachment_not_downloaded")?,
                        &state.generation,
                        generation,
                    ),
                    &mut out,
                    &key,
                    &crypto::aad("file", &scope(&app)?, &id, &next, 1),
                )?;
                asset["key"] = json!(crypto::encode(&key));
            } else {
                crypto::decrypt_file(
                    &mut RevocableReader::new(
                        File::open(source).map_err(|_| "attachment_not_downloaded")?,
                        &state.generation,
                        generation,
                    ),
                    &mut out,
                    &crypto::decode(asset["key"].as_str().ok_or("invalid_file_key")?)?,
                    &crypto::aad("file", &scope(&app)?, &id, previous, 1),
                )?;
                asset
                    .as_object_mut()
                    .ok_or("invalid_attachment")?
                    .remove("key");
            }
            out.sync_all().map_err(|_| "attachment_write_failed")?;
            asset["file"] = json!(next);
            converted.push(asset);
        }
        content.0[field] = if field == "audio" {
            converted.into_iter().next().unwrap_or(Value::Null)
        } else {
            json!(converted)
        };
    }
    let mut row = if target == "e2ee" {
        with_bundle(&app, |b| {
            crypto::seal_record(
                &root_key(b, epoch(b)?)?,
                &scope(&app)?,
                &id,
                epoch(b)?,
                &content.0,
            )
        })?
    } else {
        content.0.clone()
    };
    for key in [
        "id",
        "account_scope",
        "createdAt",
        "version",
        "legacyImported",
    ] {
        row[key] = old[key].clone();
    }
    row["historyCleanup"] = if target == "e2ee" || old["historyCleanup"] == "unverified" {
        json!("unverified")
    } else {
        json!("none")
    };
    row["protection"] = json!(target);
    row["aiContextEnabled"] = json!(false);
    row["updatedAt"] = json!(crate::now());
    row["syncState"] = json!("local");
    row["media_ids"] = json!(asset_entries(&content.0)
        .iter()
        .map(|a| a["file"].clone())
        .collect::<Vec<_>>());
    if generation != state.generation.load(Ordering::SeqCst) {
        return Err("vault_locked".into());
    }
    let mut op = make_operation(&app, &row)?;
    if version > 0 {
        row["transition"] = json!({"id":transition,"target":target,"phase":"uploading"});
        op["kind"] = json!("transition");
        op["transition_id"] = json!(transition);
        op["body"] = sign_body(
            &app,
            "commit_transition",
            json!({"protection":target,"record":op["body"]}),
        )?;
        for spec in op["files"].as_array_mut().ok_or("invalid_operation")? {
            if spec.get("proof").is_none() {
                *spec = sign_body(&app, "media_prepare", spec.clone())?;
            }
        }
    }
    persist_operation(&app, &row, op)?;
    created.committed = true;
    if version == 0 {
        cleanup_conversion(&app, &row)?;
    }
    drop(guard);
    drop(sync_guard);
    if target == "e2ee" {
        crate::workbench::revoke_private_inspiration(&app, &id).await?;
    }
    if version > 0 {
        let token = {
            let s = app.state::<PrivateState>();
            let t = s.token.lock().map_err(|_| "cloud_offline")?;
            t.as_ref().ok_or("cloud_offline")?.to_string()
        };
        let _ = sync(&app, token).await?;
    }
    view(&app, &stored(&app, &id)?, false)
}

pub(super) fn rotation_record(
    app: &AppHandle,
    row: &Value,
    new_root: &[u8],
    new_epoch: u64,
    full: bool,
) -> CommandResult<Value> {
    let state = app.state::<PrivateState>();
    let generation = state.generation.load(Ordering::SeqCst);
    let id = row["id"].as_str().ok_or("invalid_record")?;
    let owner = scope(app)?;
    let mut next = row.clone();
    if full {
        let mut content = payload(app, row)?;
        for field in ["images", "files", "audio"] {
            let entries = if field == "audio" {
                content.0[field]
                    .as_object()
                    .map(|_| vec![content.0[field].clone()])
                    .unwrap_or_default()
            } else {
                content.0[field].as_array().cloned().unwrap_or_default()
            };
            let mut changed = Vec::new();
            for mut asset in entries {
                let previous = asset["file"].as_str().ok_or("invalid_attachment")?;
                let mut plain = Zeroizing::new(Vec::new());
                crypto::decrypt_file(
                    &mut RevocableReader::new(
                        File::open(directory(app, id)?.join(format!("{previous}.bin")))
                            .map_err(|_| "attachment_not_downloaded")?,
                        &state.generation,
                        generation,
                    ),
                    &mut *plain,
                    &crypto::decode(asset["key"].as_str().ok_or("invalid_file_key")?)?,
                    &crypto::aad("file", &owner, id, previous, 1),
                )?;
                let file = uuid::Uuid::new_v4().to_string();
                let key = crypto::random_key()?;
                let mut out = File::create(directory(app, id)?.join(format!("{file}.bin")))
                    .map_err(|_| "attachment_write_failed")?;
                crypto::encrypt_file(
                    &mut plain.as_slice(),
                    &mut out,
                    &key,
                    &crypto::aad("file", &owner, id, &file, 1),
                )?;
                out.sync_all().map_err(|_| "attachment_write_failed")?;
                asset["file"] = json!(file);
                asset["key"] = json!(crypto::encode(&key));
                changed.push(asset);
            }
            content.0[field] = if field == "audio" {
                changed.into_iter().next().unwrap_or(Value::Null)
            } else {
                json!(changed)
            };
        }
        let sealed = crypto::seal_record(new_root, &owner, id, new_epoch, &content.0)?;
        for field in [
            "crypto_version",
            "content_revision",
            "envelope",
            "key_epoch",
        ] {
            next[field] = sealed[field].clone();
        }
        next["media_ids"] = json!(asset_entries(&content.0)
            .iter()
            .map(|a| a["file"].clone())
            .collect::<Vec<_>>());
    } else {
        let revision = row["content_revision"].as_str().ok_or("invalid_record")?;
        let previous_epoch = row["key_epoch"].as_u64().ok_or("invalid_record")?;
        let wrapped: Envelope = serde_json::from_value(row["envelope"]["wrapped_key"].clone())
            .map_err(|_| "invalid_record")?;
        let key = with_bundle(app, |b| {
            crypto::open(
                &root_key(b, previous_epoch)?,
                &wrapped,
                &crypto::aad("record-key", &owner, id, revision, previous_epoch),
            )
        })?;
        next["envelope"]["wrapped_key"] = serde_json::to_value(crypto::seal(
            new_root,
            &key,
            &crypto::aad("record-key", &owner, id, revision, new_epoch),
        )?)
        .map_err(|_| "invalid_record")?;
        next["key_epoch"] = json!(new_epoch);
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_wire_never_carries_display_plaintext_or_internal_operations() {
        let row = json!({"id":"inspiration:test","account_scope":"scope","protection":"e2ee","text":"private canary","tags":["private tag"],"files":[{"name":"private.pdf","key":"must-stay-native"}],"envelope":{"payload":{"ciphertext":"opaque"},"wrapped_key":{"ciphertext":"opaque-key"}},"content_revision":"revision","key_epoch":1,"crypto_version":1,"aiContextEnabled":true,"_sync_op":{"payload":"old plaintext"}});
        let body = wire(&row).unwrap();
        assert_eq!(body["ai_context_enabled"], false);
        for canary in [
            "private canary",
            "private tag",
            "private.pdf",
            "must-stay-native",
            "old plaintext",
        ] {
            assert!(!body.to_string().contains(canary));
        }
        assert_eq!(body["account_scope"], "scope");
    }
    #[test]
    fn remote_plain_manifests_cannot_escape_the_record_or_reference_another_asset() {
        let mut row = json!({"id":"inspiration:00000000-0000-4000-8000-000000000001","account_scope":"scope","protection":"plain","payload":{"text":"ordinary","files":[{"file":"../secret"}]},"media_ids":["../secret"]});
        assert!(from_wire(&row).is_err());
        row["payload"]["files"][0]["file"] = json!("00000000-0000-4000-8000-000000000002");
        row["media_ids"] = json!([]);
        assert!(from_wire(&row).is_err());
        row["media_ids"] = json!(["00000000-0000-4000-8000-000000000002"]);
        assert!(from_wire(&row).is_ok());
    }
}
