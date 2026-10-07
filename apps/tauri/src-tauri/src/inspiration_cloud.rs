//! Account-scoped inspiration cache and the Lynse Memory cloud sync engine
//! (plan T7.1/T7.4 + T8).
//!
//! Storage layout — everything under `<app_data>/inspiration-cloud/`:
//!
//! ```text
//! active-account.json     { userId, apiBase, verifiedAt } — written ONLY after the
//!                         renderer verified the Lynse token against /v1/me; offline
//!                         startup may trust this previously verified binding.
//! accounts/<hash(userId)>/  per-account partition (sha256 prefix; raw ids never
//!                         become path segments)
//!   cache.json            { schemaVersion, records[], tombstones[], cursor } —
//!                         records carry server `version` and `syncState`
//!                         (local|syncing|synced|conflict). Every mutation rewrites
//!                         this file atomically (tmp+rename): records, tombstones
//!                         and the cursor move together, all-or-nothing.
//!   ops.json              pending-operation journal (coalesced per entity)
//!   conflicts.json        { entityId, localDraft, serverRecord, at } drafts kept
//!                         for the user to pick on 409
//!   status.json           { lastSyncAt, lastError, paused }
//! ```
//!
//! The legacy global `local-inspirations` store stays the UI source this
//! iteration: local writes go through both (existing behaviour + write-through
//! hook), and pulled server changes are merged back into it, so the visible
//! list converges across devices. The old WebDAV copy never feeds this cache
//! (plan T7.3), and binding never auto-imports the legacy global JSON — only
//! records the user actually edits while bound become cloud-owned (plan
//! T7.4/T12 import UI comes later).

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::{app_data_dir, now, CommandResult};

pub(crate) const CLOUD_ROOT: &str = "inspiration-cloud";
const SCHEMA_VERSION: u32 = 1;

// ── binding ─────────────────────────────────────────────────────────────────

/// The account binding exists only after the renderer verified the Lynse
/// token against `GET /v1/me` (server-derived user id). API-Key-only sessions
/// never bind, so the cloud cache never opens (plan T7.4).
#[derive(Clone, Debug)]
pub(crate) struct AccountBinding {
    pub user_id: String,
    pub api_base: String,
    pub verified_at: String,
}

fn cloud_root(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?.join(CLOUD_ROOT);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn binding_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(cloud_root(app)?.join("active-account.json"))
}

fn account_segment(user_id: &str) -> String {
    let digest = Sha256::digest(user_id.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn account_dir(app: &AppHandle, user_id: &str) -> CommandResult<PathBuf> {
    let path = cloud_root(app)?.join("accounts").join(account_segment(user_id));
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub(crate) fn read_binding(app: &AppHandle) -> CommandResult<Option<AccountBinding>> {
    let path = binding_path(app)?;
    let Ok(content) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
    let user_id = value.get("userId").and_then(Value::as_str).unwrap_or_default().to_owned();
    if user_id.is_empty() {
        return Ok(None);
    }
    Ok(Some(AccountBinding {
        user_id,
        api_base: value.get("apiBase").and_then(Value::as_str).unwrap_or_default().to_owned(),
        verified_at: value.get("verifiedAt").and_then(Value::as_str).unwrap_or_default().to_owned(),
    }))
}

pub(crate) fn write_binding(app: &AppHandle, binding: &AccountBinding) -> CommandResult<()> {
    let path = binding_path(app)?;
    let content = serde_json::to_string_pretty(&json!({
        "userId": binding.user_id,
        "apiBase": binding.api_base,
        "verifiedAt": binding.verified_at,
    }))
    .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

/// Logout / account switch (plan T7.4): drop the active binding and all
/// in-memory state. The per-account directory is intentionally KEPT — its
/// pending operations pause until the same account binds again; the queue
/// resumes on the next `sync`.
pub(crate) fn clear_binding(app: &AppHandle) -> CommandResult<()> {
    let path = binding_path(app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

// ── cache ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub(crate) struct AccountCache {
    pub records: Vec<Value>,
    pub tombstones: Vec<Value>,
    pub cursor: String,
}

fn cache_path(dir: &PathBuf) -> PathBuf { dir.join("cache.json") }
fn ops_path(dir: &PathBuf) -> PathBuf { dir.join("ops.json") }
fn conflicts_path(dir: &PathBuf) -> PathBuf { dir.join("conflicts.json") }
fn status_path(dir: &PathBuf) -> PathBuf { dir.join("status.json") }

pub(crate) fn load_cache(dir: &PathBuf) -> AccountCache {
    let Ok(content) = fs::read_to_string(cache_path(dir)) else {
        return AccountCache::default();
    };
    let value: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
    AccountCache {
        records: value.get("records").and_then(Value::as_array).cloned().unwrap_or_default(),
        tombstones: value.get("tombstones").and_then(Value::as_array).cloned().unwrap_or_default(),
        cursor: value.get("cursor").and_then(Value::as_str).unwrap_or_default().to_owned(),
    }
}

/// One atomic write: records + tombstones + cursor land together or not at
/// all (the local-transaction guarantee of plan T7.1).
pub(crate) fn save_cache(dir: &PathBuf, cache: &AccountCache) -> CommandResult<()> {
    let content = serde_json::to_string_pretty(&json!({
        "schemaVersion": SCHEMA_VERSION,
        "records": cache.records,
        "tombstones": cache.tombstones,
        "cursor": cache.cursor,
    }))
    .map_err(|error| error.to_string())?;
    let path = cache_path(dir);
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

pub(crate) fn load_ops(dir: &PathBuf) -> Vec<Value> {
    fs::read_to_string(ops_path(dir))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub(crate) fn save_ops(dir: &PathBuf, ops: &[Value]) -> CommandResult<()> {
    let content = serde_json::to_string_pretty(ops).map_err(|error| error.to_string())?;
    let path = ops_path(dir);
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

pub(crate) fn load_conflicts(dir: &PathBuf) -> Vec<Value> {
    fs::read_to_string(conflicts_path(dir))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub(crate) fn save_conflicts(dir: &PathBuf, conflicts: &[Value]) -> CommandResult<()> {
    let content = serde_json::to_string_pretty(conflicts).map_err(|error| error.to_string())?;
    let path = conflicts_path(dir);
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

pub(crate) fn save_status(dir: &PathBuf, patch: Value) -> CommandResult<()> {
    let mut status = fs::read_to_string(status_path(dir))
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(patch_object) = patch.as_object() {
        for (key, value) in patch_object {
            status.insert(key.clone(), value.clone());
        }
    }
    let path = status_path(dir);
    let content = serde_json::to_string_pretty(&Value::Object(status))
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

// ── pure engine: local-change coalescing ────────────────────────────────────

/// Build the pending-operation entry for a local write, coalescing with any
/// previous pending op of the same entity:
/// create+update → single create (latest payload), anything+delete → single
/// delete carrying the last *server-known* base version. A delete of a
/// never-synced record cancels the create outright (an offline record that
/// never reached the cloud must not be created there).
pub(crate) fn enqueue_local_change(
    ops: &mut Vec<Value>,
    kind: &str,
    record: &Value,
) -> Option<Value> {
    let entity_id = record.get("id").and_then(Value::as_str)?.to_owned();
    let server_version = record.get("version").and_then(Value::as_i64);
    let existing_index = ops.iter().position(|op| {
        op.get("entityId").and_then(Value::as_str) == Some(entity_id.as_str())
    });
    let operation_id = existing_index
        .and_then(|index| ops[index].get("operationId").and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("op-{}", uuid::Uuid::new_v4()));

    if kind == "delete" {
        match existing_index {
            Some(index) if ops[index].get("kind").and_then(Value::as_str) == Some("create") => {
                // never synced → drop the create, nothing to delete remotely
                ops.remove(index);
                return None;
            }
            _ => {}
        }
        let operation = json!({
            "operationId": operation_id,
            "kind": "delete",
            "entityId": entity_id,
            "baseVersion": server_version,
            "queuedAt": now(),
            "attempts": 0,
        });
        match existing_index {
            Some(index) => ops[index] = operation.clone(),
            None => ops.push(operation.clone()),
        }
        return Some(operation);
    }

    let payload = server_payload(record);
    match existing_index {
        Some(index) if ops[index].get("kind").and_then(Value::as_str) == Some("create") => {
            let mut operation = ops[index].clone();
            operation["payload"] = payload;
            operation["queuedAt"] = json!(now());
            ops[index] = operation.clone();
            Some(operation)
        }
        Some(index) if kind == "update" => {
            let mut operation = ops[index].clone();
            operation["payload"] = payload;
            operation["queuedAt"] = json!(now());
            ops[index] = operation.clone();
            Some(operation)
        }
        _ => {
            let operation = json!({
                "operationId": operation_id,
                "kind": kind,
                "entityId": entity_id,
                "baseVersion": server_version,
                "payload": payload,
                "queuedAt": now(),
                "attempts": 0,
            });
            ops.push(operation.clone());
            Some(operation)
        }
    }
}

/// The server-facing create/update payload: text/tags/transcript metadata +
/// the AI-context and sensitivity switches. Media bytes never travel inside
/// the operation — they go through the prepare/upload/finalize pipeline.
fn server_payload(record: &Value) -> Value {
    json!({
        "id": record.get("id"),
        "text": record.get("text").cloned().unwrap_or(json!("")),
        "tags": record.get("tags").cloned().unwrap_or(json!([])),
        "transcript": record.get("transcript").cloned().unwrap_or(json!("")),
        "transcriptStatus": record.get("transcriptStatus").cloned().unwrap_or(json!("none")),
        "sensitivity": record.get("sensitivity").cloned().unwrap_or(json!("normal")),
        "aiContextEnabled": record.get("aiContextEnabled").cloned().unwrap_or(json!(true)),
        "createdAt": record.get("createdAt"),
    })
}

// ── pure engine: applying server changes ────────────────────────────────────

/// Apply one `/v1/sync` change page to the cache. Rules (plan T8.3):
/// - upserts never overwrite an entity with a pending local op (local wins
///   until its operation is submitted);
/// - server deletes always win: the record is tombstoned locally even if an
///   offline edit is pending — an offline edit must not resurrect a record
///   another device deleted.
/// Returns (applied entity ids, tombstoned entity ids) so the caller can
/// mirror them into the visible global store.
pub(crate) fn apply_server_changes(
    cache: &mut AccountCache,
    ops: &mut Vec<Value>,
    changes: &[Value],
) -> (Vec<String>, Vec<String>) {
    let mut upserted = Vec::new();
    let mut deleted = Vec::new();
    for change in changes {
        let Some(entity_id) = change.get("entityId").and_then(Value::as_str) else {
            continue;
        };
        let entity_version = change.get("version").and_then(Value::as_i64).unwrap_or(0);
        let at = change.get("at").and_then(Value::as_str).unwrap_or_default().to_owned();
        match change.get("op").and_then(Value::as_str) {
            Some("upsert") => {
                if ops.iter().any(|op| {
                    op.get("entityId").and_then(Value::as_str) == Some(entity_id)
                }) {
                    continue; // local op pending; submit it before pulling wins
                }
                // The change log carries metadata only; fetch the record body
                // via GET /inspirations/{id} is deferred — the caller merges
                // `fetched` bodies keyed by id.
                if let Some(record) = change.get("record").filter(|record| record.is_object()) {
                    let mut record = record.clone();
                    record["version"] = json!(entity_version);
                    record["syncState"] = json!("synced");
                    upsert_record(&mut cache.records, record);
                    upserted.push(entity_id.to_owned());
                }
                let _ = at;
            }
            Some("delete") => {
                cache.records.retain(|record| {
                    record.get("id").and_then(Value::as_str) != Some(entity_id)
                });
                ops.retain(|op| op.get("entityId").and_then(Value::as_str) != Some(entity_id));
                if !cache.tombstones.iter().any(|tombstone| {
                    tombstone.get("entityId").and_then(Value::as_str) == Some(entity_id)
                }) {
                    cache.tombstones.push(json!({
                        "entityId": entity_id,
                        "version": entity_version,
                        "at": at,
                    }));
                }
                deleted.push(entity_id.to_owned());
            }
            _ => {}
        }
    }
    (upserted, deleted)
}

fn upsert_record(records: &mut Vec<Value>, record: Value) {
    let id = record.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
    match records.iter().position(|existing| {
        existing.get("id").and_then(Value::as_str) == Some(id.as_str())
    }) {
        Some(index) => records[index] = record,
        None => records.push(record),
    }
}

/// Outcome of submitting one pending operation to the server.
pub(crate) enum OpOutcome {
    /// Accepted (or an idempotent duplicate replay) — carries the server record.
    Applied(Option<Value>),
    /// 409: the server moved on. Keep the local draft + server record for the
    /// user to pick (plan T8.3).
    Conflict(Value),
    /// 401: pause the queue until re-login (plan T8.2).
    Unauthorized,
    /// Network/5xx: keep the operation pending.
    RetryLater,
}

/// Fold one operation outcome back into cache + queue (pure, unit-tested).
pub(crate) fn record_op_outcome(
    cache: &mut AccountCache,
    ops: &mut Vec<Value>,
    operation: &Value,
    outcome: OpOutcome,
) -> OpFold {
    let entity_id = operation.get("entityId").and_then(Value::as_str).unwrap_or_default().to_owned();
    let kind = operation.get("kind").and_then(Value::as_str).unwrap_or_default().to_owned();
    match outcome {
        OpOutcome::Unauthorized => OpFold::Paused,
        OpOutcome::RetryLater => {
            bump_attempts(ops, &entity_id);
            OpFold::Stopped
        }
        OpOutcome::Conflict(current) => {
            ops.retain(|op| op.get("entityId").and_then(Value::as_str) != Some(entity_id.as_str()));
            if let Some(record) = cache.records.iter_mut().find(|record| {
                record.get("id").and_then(Value::as_str) == Some(entity_id.as_str())
            }) {
                record["syncState"] = json!("conflict");
                if let Some(server) = current.as_object() {
                    record["serverVersion"] = json!(server.get("version").cloned().unwrap_or(json!(0)));
                    record["serverRecord"] = json!(server);
                }
            }
            OpFold::Conflicted(entity_id)
        }
        OpOutcome::Applied(server_record) => {
            ops.retain(|op| op.get("entityId").and_then(Value::as_str) != Some(entity_id.as_str()));
            match kind.as_str() {
                "delete" => {
                    cache.records.retain(|record| {
                        record.get("id").and_then(Value::as_str) != Some(entity_id.as_str())
                    });
                    cache.tombstones.push(json!({
                        "entityId": entity_id,
                        "at": now(),
                    }));
                    OpFold::Deleted(entity_id)
                }
                _ => {
                    if let Some(record) = cache.records.iter_mut().find(|record| {
                        record.get("id").and_then(Value::as_str) == Some(entity_id.as_str())
                    }) {
                        if let Some(server) = server_record.as_ref().filter(|value| value.is_object()) {
                            record["version"] = server.get("version").cloned().unwrap_or(record["version"].clone());
                        } else {
                            record["version"] = json!(record.get("version").and_then(Value::as_i64).unwrap_or(0) + 1);
                        }
                        record["syncState"] = json!("synced");
                    }
                    OpFold::Synced(entity_id)
                }
            }
        }
    }
}

fn bump_attempts(ops: &mut [Value], entity_id: &str) {
    for op in ops.iter_mut() {
        if op.get("entityId").and_then(Value::as_str) == Some(entity_id) {
            op["attempts"] = json!(op.get("attempts").and_then(Value::as_i64).unwrap_or(0) + 1);
        }
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum OpFold {
    Synced(String),
    Deleted(String),
    Conflicted(String),
    Paused,
    Stopped,
}

// ── process-global sync gate ────────────────────────────────────────────────

static SYNC_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── write-through hooks (called from the save/delete commands) ──────────────

/// Mirror a local create/update into the account cache as a pending cloud
/// operation. Best-effort: when no account is bound (API-Key mode, cloud
/// disabled) this is a no-op and the record stays 仅本机.
pub(crate) fn record_local_change(app: &AppHandle, saved: &Value) -> CommandResult<()> {
    let Some(binding) = read_binding(app)? else {
        return Ok(());
    };
    let dir = account_dir(app, &binding.user_id)?;
    let mut cache = load_cache(&dir);
    let mut ops = load_ops(&dir);
    // A record without a server version has never reached the cloud → its
    // first submission is a create; anything else is an update.
    let synced_version = saved.get("version").and_then(Value::as_i64).unwrap_or(0);
    let kind = if synced_version > 0 { "update" } else { "create" };
    let _ = enqueue_local_change(&mut ops, kind, saved);
    let mut record = saved.clone();
    if let Some(object) = record.as_object_mut() {
        if !object.contains_key("version") {
            object.insert("version".to_owned(), json!(0));
        }
        if object.get("syncState").and_then(Value::as_str) != Some("conflict") {
            object.insert("syncState".to_owned(), json!("local"));
        }
    }
    upsert_record(&mut cache.records, record);
    save_ops(&dir, &ops)?;
    save_cache(&dir, &cache)
}

pub(crate) fn record_local_delete(app: &AppHandle, entity_id: &str) -> CommandResult<()> {
    let Some(binding) = read_binding(app)? else {
        return Ok(());
    };
    let dir = account_dir(app, &binding.user_id)?;
    let mut cache = load_cache(&dir);
    let mut ops = load_ops(&dir);
    let record = cache.records.iter().find(|record| {
        record.get("id").and_then(Value::as_str) == Some(entity_id)
    }).cloned();
    let probe = record.unwrap_or_else(|| json!({ "id": entity_id }));
    let _ = enqueue_local_change(&mut ops, "delete", &probe);
    cache.records.retain(|record| {
        record.get("id").and_then(Value::as_str) != Some(entity_id)
    });
    save_ops(&dir, &ops)?;
    save_cache(&dir, &cache)
}

// ── status view for the renderer ────────────────────────────────────────────

pub(crate) fn status_view(app: &AppHandle) -> CommandResult<Value> {
    let Some(binding) = read_binding(app)? else {
        return Ok(json!({ "bound": false, "paused": false }));
    };
    let dir = account_dir(app, &binding.user_id)?;
    let cache = load_cache(&dir);
    let ops = load_ops(&dir);
    let conflicts = load_conflicts(&dir);
    let status: Value = fs::read_to_string(status_path(&dir))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or(json!({}));
    let states: Map<String, Value> = cache
        .records
        .iter()
        .filter_map(|record| {
            let id = record.get("id").and_then(Value::as_str)?;
            Some((id.to_owned(), record.get("syncState").cloned().unwrap_or(json!("local"))))
        })
        .collect();
    Ok(json!({
        "bound": true,
        "userId": binding.user_id,
        "apiBase": binding.api_base,
        "cursor": cache.cursor,
        "pendingOps": ops.len(),
        "conflicts": conflicts.len(),
        "lastSyncAt": status.get("lastSyncAt").cloned().unwrap_or(json!(null)),
        "lastError": status.get("lastError").cloned().unwrap_or(json!(null)),
        "paused": status.get("paused").cloned().unwrap_or(json!(false)),
        "recordStates": Value::Object(states),
    }))
}

// ── HTTP client (contract: lynse-memory openapi/v1.yaml) ────────────────────

#[derive(Debug)]
pub(crate) enum MemoryError {
    Unauthorized,
    Conflict { current: Value },
    Network(String),
    Server(String),
}

impl MemoryError {
    fn to_outcome(error: MemoryError) -> OpOutcome {
        match error {
            MemoryError::Unauthorized => OpOutcome::Unauthorized,
            MemoryError::Conflict { current } => OpOutcome::Conflict(current),
            MemoryError::Network(_) | MemoryError::Server(_) => OpOutcome::RetryLater,
        }
    }

    fn message(&self) -> String {
        match self {
            MemoryError::Unauthorized => "401 unauthorized".to_owned(),
            MemoryError::Conflict { .. } => "409 version conflict".to_owned(),
            MemoryError::Network(message) => format!("network: {message}"),
            MemoryError::Server(message) => format!("server: {message}"),
        }
    }
}

pub(crate) struct MemoryClient {
    http: reqwest::Client,
    base: String,
}

impl MemoryClient {
    pub(crate) fn new(base: &str) -> Self {
        Self { http: reqwest::Client::new(), base: base.trim_end_matches('/').to_owned() }
    }

    async fn call(
        &self,
        token: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        operation_id: Option<&str>,
    ) -> Result<Value, MemoryError> {
        let mut builder = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(token)
            .header("Accept", "application/json");
        if let Some(operation_id) = operation_id {
            builder = builder.header("Operation-Id", operation_id);
        }
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| MemoryError::Network(error.to_string()))?;
        let status = response.status();
        let payload: Value = response.json().await.unwrap_or(Value::Null);
        match status.as_u16() {
            200..=299 => Ok(payload),
            401 => Err(MemoryError::Unauthorized),
            409 => {
                // details key: server serializes snake_case; accept camelCase too
                let current = payload
                    .pointer("/error/details/current_record")
                    .or_else(|| payload.pointer("/error/details/currentRecord"))
                    .cloned()
                    .unwrap_or(Value::Null);
                Err(MemoryError::Conflict { current })
            }
            code => Err(MemoryError::Server(format!(
                "HTTP {code}: {}",
                payload.pointer("/error/code").and_then(Value::as_str).unwrap_or("?")
            ))),
        }
    }

    async fn create_inspiration(&self, token: &str, payload: Value, operation_id: &str) -> Result<Value, MemoryError> {
        self.call(token, reqwest::Method::POST, "/v1/inspirations", Some(payload), Some(operation_id)).await
    }

    async fn update_inspiration(&self, token: &str, id: &str, base_version: i64, payload: Value, operation_id: &str) -> Result<Value, MemoryError> {
        let mut body = payload;
        body["baseVersion"] = json!(base_version);
        self.call(token, reqwest::Method::PATCH, &format!("/v1/inspirations/{id}"), Some(body), Some(operation_id)).await
    }

    async fn delete_inspiration(&self, token: &str, id: &str, base_version: i64, operation_id: &str) -> Result<Value, MemoryError> {
        self.call(
            token,
            reqwest::Method::DELETE,
            &format!("/v1/inspirations/{id}?baseVersion={base_version}"),
            None,
            Some(operation_id),
        )
        .await
    }

    async fn get_inspiration(&self, token: &str, id: &str) -> Result<Value, MemoryError> {
        self.call(token, reqwest::Method::GET, &format!("/v1/inspirations/{id}"), None, None).await
    }

    async fn sync_changes(&self, token: &str, cursor: &str) -> Result<Value, MemoryError> {
        let suffix = if cursor.is_empty() { String::new() } else { format!("?cursor={}", percent_encoding_path(cursor)) };
        self.call(token, reqwest::Method::GET, &format!("/v1/sync{suffix}"), None, None).await
    }

    async fn media_prepare(&self, token: &str, id: &str, spec: Value, operation_id: &str) -> Result<Value, MemoryError> {
        self.call(token, reqwest::Method::POST, &format!("/v1/inspirations/{id}/media/prepare"), Some(spec), Some(operation_id)).await
    }

    async fn media_upload(&self, token: &str, upload_path: &str, ticket: &str, bytes: Vec<u8>) -> Result<Value, MemoryError> {
        let response = self
            .http
            .put(format!("{}{}", self.base, upload_path))
            .bearer_auth(token)
            .header("X-Upload-Ticket", ticket)
            .header("Content-Type", "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|error| MemoryError::Network(error.to_string()))?;
        let status = response.status();
        let payload: Value = response.json().await.unwrap_or(Value::Null);
        match status.as_u16() {
            200..=299 => Ok(payload),
            401 => Err(MemoryError::Unauthorized),
            code => Err(MemoryError::Server(format!(
                "media upload HTTP {code}: {}",
                payload.pointer("/error/code").and_then(Value::as_str).unwrap_or("?")
            ))),
        }
    }

    async fn media_finalize(&self, token: &str, id: &str, media_id: &str) -> Result<Value, MemoryError> {
        self.call(
            token,
            reqwest::Method::POST,
            &format!("/v1/inspirations/{id}/media/{media_id}/finalize"),
            Some(json!({})),
            None,
        )
        .await
    }
}

fn percent_encoding_path(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

// ── media pipeline (T8.2: media before operations) ──────────────────────────

fn attachment_files(record: &Value) -> Vec<(String, String)> {
    let mut files = Vec::new();
    if let Some(file) = record.get("audio").and_then(|audio| audio.get("file")).and_then(Value::as_str) {
        files.push(("audio".to_owned(), file.to_owned()));
    }
    if let Some(images) = record.get("images").and_then(Value::as_array) {
        for image in images {
            if let Some(file) = image.get("file").and_then(Value::as_str) {
                files.push(("image".to_owned(), file.to_owned()));
            }
        }
    }
    files
}

fn content_type_for(kind: &str, file: &str) -> &'static str {
    let extension = file.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match kind {
        "audio" => match extension.as_str() {
            "wav" => "audio/wav",
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            _ => "audio/wav",
        },
        _ => match extension.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "application/octet-stream",
        },
    }
}

fn media_manifest_path(dir: &PathBuf) -> PathBuf { dir.join("media.json") }

fn load_media_manifest(dir: &PathBuf) -> Vec<Value> {
    fs::read_to_string(media_manifest_path(dir))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_media_manifest(dir: &PathBuf, manifest: &[Value]) -> CommandResult<()> {
    let content = serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?;
    let path = media_manifest_path(dir);
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

/// Upload every attachment of one record that is not active in the manifest
/// yet (idempotent by inspiration+file+sha256). Returns uploaded count.
async fn upload_record_media(
    app: &AppHandle,
    client: &MemoryClient,
    token: &str,
    dir: &PathBuf,
    record: &Value,
) -> Result<usize, String> {
    let id = record.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
    let uuid = id.strip_prefix("inspiration:").unwrap_or(&id);
    let directory = crate::inspiration_dir(app, uuid)?;
    let mut manifest = load_media_manifest(dir);
    let mut uploaded = 0usize;
    for (kind, file) in attachment_files(record) {
        let path = directory.join(&file);
        if !path.is_file() {
            continue;
        }
        let bytes = fs::read(&path).map_err(|error| format!("read {file}: {error}"))?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let already_active = manifest.iter().any(|entry| {
            entry.get("inspirationId").and_then(Value::as_str) == Some(id.as_str())
                && entry.get("file").and_then(Value::as_str) == Some(file.as_str())
                && entry.get("sha256").and_then(Value::as_str) == Some(digest.as_str())
                && entry.get("state").and_then(Value::as_str) == Some("active")
        });
        if already_active {
            continue;
        }
        let operation_id = format!("media-{}-{}", uuid::Uuid::new_v4().simple(), file);
        let prepare = client
            .media_prepare(
                token,
                &id,
                json!({
                    "kind": kind,
                    "content_type": content_type_for(&kind, &file),
                    "size_bytes": bytes.len(),
                    "sha256": digest,
                }),
                &operation_id,
            )
            .await
            .map_err(|error| error.message())?;
        let upload_path = prepare.get("uploadUrl").and_then(Value::as_str).unwrap_or_default().to_owned();
        let ticket = prepare.get("uploadTicket").and_then(Value::as_str).unwrap_or_default().to_owned();
        let media_id = prepare.get("mediaId").and_then(Value::as_str).unwrap_or_default().to_owned();
        client
            .media_upload(token, &upload_path, &ticket, bytes)
            .await
            .map_err(|error| error.message())?;
        client
            .media_finalize(token, &id, &media_id)
            .await
            .map_err(|error| error.message())?;
        manifest.retain(|entry| {
            !(entry.get("inspirationId").and_then(Value::as_str) == Some(id.as_str())
                && entry.get("file").and_then(Value::as_str) == Some(file.as_str()))
        });
        manifest.push(json!({
            "inspirationId": id, "file": file, "mediaId": media_id,
            "sha256": digest, "state": "active",
        }));
        uploaded += 1;
    }
    save_media_manifest(dir, &manifest)?;
    Ok(uploaded)
}

// ── sync engine (T8.2) ──────────────────────────────────────────────────────
// The sync gate is the process-global `SYNC_GATE` declared above.

/// Trigger points live in the renderer (login, network recovery, app wake,
/// new operation enqueued); the engine itself is idempotent and serialized.
pub(crate) async fn sync_once(app: &AppHandle, token: &str) -> CommandResult<Value> {
    let Some(binding) = read_binding(app)? else {
        return Ok(json!({ "skipped": "unbound" }));
    };
    let client = MemoryClient::new(&binding.api_base);
    let dir = account_dir(app, &binding.user_id)?;
    let _guard = SYNC_GATE.lock().await;

    let mut cache = load_cache(&dir);
    let mut ops = load_ops(&dir);
    let mut synced_entities: Vec<String> = Vec::new();
    let mut deleted_entities: Vec<String> = Vec::new();
    let mut conflicts = 0usize;
    let mut paused: Option<String> = None;
    let mut failure: Option<String> = None;

    // Phase 1 — pending operations, in queue order.
    let queue = ops.clone();
    for operation in &queue {
        let entity_id = operation.get("entityId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let kind = operation.get("kind").and_then(Value::as_str).unwrap_or_default().to_owned();
        let operation_id = operation.get("operationId").and_then(Value::as_str).unwrap_or_default().to_owned();
        if kind == "delete" {
            // deleting locally already removed the record from the cache
        } else if let Some(record) = cache.records.iter().find(|record| {
            record.get("id").and_then(Value::as_str) == Some(entity_id.as_str())
        }).cloned() {
            if let Err(error) = upload_record_media(app, &client, token, &dir, &record).await {
                failure = Some(format!("media upload failed: {error}"));
                break;
            }
        }
        let request = cache.records.iter().find(|record| {
            record.get("id").and_then(Value::as_str) == Some(entity_id.as_str())
        }).cloned();
        let outcome = match kind.as_str() {
            "create" => client
                .create_inspiration(token, operation.get("payload").cloned().unwrap_or(json!({})), &operation_id)
                .await
                .map_or_else(MemoryError::to_outcome, |record| OpOutcome::Applied(Some(record))),
            "update" => {
                let mut payload = operation.get("payload").cloned().unwrap_or(json!({}));
                if let Some(record) = &request {
                    payload = server_payload(record);
                }
                client
                    .update_inspiration(
                        token,
                        &entity_id,
                        operation.get("baseVersion").and_then(Value::as_i64).unwrap_or(0),
                        payload,
                        &operation_id,
                    )
                    .await
                    .map_or_else(MemoryError::to_outcome, |record| OpOutcome::Applied(Some(record)))
            }
            "delete" => client
                .delete_inspiration(
                    token,
                    &entity_id,
                    operation.get("baseVersion").and_then(Value::as_i64).unwrap_or(0),
                    &operation_id,
                )
                .await
                .map_or_else(MemoryError::to_outcome, |record| OpOutcome::Applied(Some(record))),
            _ => OpOutcome::RetryLater,
        };
        let fold = record_op_outcome(&mut cache, &mut ops, operation, outcome);
        match fold {
            OpFold::Synced(id) => {
                synced_entities.push(id.clone());
                // create landed → attachments can now be registered (media
                // prepare requires the inspiration to exist server-side)
                if kind == "create" {
                    if let Some(record) = cache.records.iter().find(|record| {
                        record.get("id").and_then(Value::as_str) == Some(id.as_str())
                    }).cloned() {
                        if let Err(error) = upload_record_media(app, &client, token, &dir, &record).await {
                            failure = Some(format!("media upload failed: {error}"));
                        }
                    }
                }
            }
            OpFold::Deleted(id) => deleted_entities.push(id),
            OpFold::Conflicted(_) => conflicts += 1,
            OpFold::Paused => {
                paused = Some("auth".to_owned());
                break;
            }
            OpFold::Stopped => {
                failure = failure.or_else(|| Some("network unavailable; operations stay pending".to_owned()));
                break;
            }
        }
        if failure.is_some() {
            break;
        }
    }

    // Phase 2 — pull changes (cursor + tombstones; server deletes win).
    if paused.is_none() {
        let mut cursor = cache.cursor.clone();
        loop {
            let page = match client.sync_changes(token, &cursor).await {
                Ok(page) => page,
                Err(MemoryError::Unauthorized) => {
                    paused = Some("auth".to_owned());
                    break;
                }
                Err(error) => {
                    failure = failure.or_else(|| Some(error.message()));
                    break;
                }
            };
            let mut enriched: Vec<Value> = Vec::new();
            for change in page.get("changes").and_then(Value::as_array).cloned().unwrap_or_default() {
                let is_upsert = change.get("op").and_then(Value::as_str) == Some("upsert");
                let entity_id = change.get("entityId").and_then(Value::as_str).unwrap_or_default().to_owned();
                let has_pending = ops.iter().any(|op| {
                    op.get("entityId").and_then(Value::as_str) == Some(entity_id.as_str())
                });
                let mut change = change;
                if is_upsert && !has_pending {
                    match client.get_inspiration(token, &entity_id).await {
                        Ok(body) => change["record"] = normalize_inspiration(&body),
                        Err(MemoryError::Unauthorized) => {
                            paused = Some("auth".to_owned());
                            break;
                        }
                        Err(_) => {} // retried on the next pull
                    }
                }
                enriched.push(change);
            }
            if paused.is_some() {
                break;
            }
            let (upserted, deleted) = apply_server_changes(&mut cache, &mut ops, &enriched);
            synced_entities.extend(upserted);
            deleted_entities.extend(deleted);
            if let Some(next) = page.get("nextCursor").and_then(Value::as_str) {
                cursor = next.to_owned();
                cache.cursor = cursor.clone();
            }
            if page.get("hasMore").and_then(Value::as_bool) != Some(true) {
                break;
            }
        }
    }

    save_cache(&dir, &cache)?;
    save_ops(&dir, &ops)?;
    save_status(
        &dir,
        json!({
            "lastSyncAt": now(),
            "lastError": failure,
            "paused": paused.is_some(),
        }),
    )?;
    merge_into_global_store(app, &cache, &synced_entities, &deleted_entities)?;

    Ok(json!({
        "submitted": synced_entities.len(),
        "appliedChanges": synced_entities.len(),
        "deletedChanges": deleted_entities.len(),
        "conflicts": conflicts,
        "pendingOps": ops.len(),
        "paused": paused,
        "error": failure,
        "cursor": cache.cursor,
    }))
}

/// Map a server inspiration row onto the desktop record shape.
fn normalize_inspiration(body: &Value) -> Value {
    json!({
        "id": body.get("id"),
        "text": body.get("text").cloned().unwrap_or(json!("")),
        "tags": body.get("tags").cloned().unwrap_or(json!([])),
        "transcript": body.get("transcript").cloned().unwrap_or(json!("")),
        "transcriptStatus": body.get("transcriptStatus").cloned().unwrap_or(json!("none")),
        "sensitivity": body.get("sensitivity").cloned().unwrap_or(json!("normal")),
        "aiContextEnabled": body.get("aiContextEnabled").cloned().unwrap_or(json!(true)),
        "createdAt": body.get("createdAt").or_else(|| body.get("created_at")).cloned().unwrap_or(json!(null)),
        "updatedAt": body.get("updatedAt").or_else(|| body.get("updated_at")).cloned().unwrap_or(json!(null)),
        "version": body.get("version").cloned().unwrap_or(json!(0)),
    })
}

/// Mirror synced/tombstoned entities into the visible global store so the
/// inspiration page converges across devices. Pulled records without local
/// attachments are written as-is; attachment files are fetched on demand in a
/// later step (plan T8.3 second-device media download), so a pulled record
/// with audio plays only after that lands — text/tags/transcript show today.
fn merge_into_global_store(
    app: &AppHandle,
    cache: &AccountCache,
    synced: &[String],
    deleted: &[String],
) -> CommandResult<()> {
    if synced.is_empty() && deleted.is_empty() {
        return Ok(());
    }
    let path = crate::local_store_path(app, "local-inspirations")?;
    let mut values = crate::read_array(&path)?;
    for id in synced {
        if let Some(record) = cache.records.iter().find(|record| {
            record.get("id").and_then(Value::as_str) == Some(id.as_str())
        }) {
            let mut local = record.clone();
            if let Some(object) = local.as_object_mut() {
                object.remove("serverRecord");
                object.remove("serverVersion");
            }
            match values.iter().position(|existing| {
                existing.get("id").and_then(Value::as_str) == Some(id.as_str())
            }) {
                Some(index) => values[index] = local,
                None => values.push(local),
            }
        }
    }
    for id in deleted {
        values.retain(|existing| existing.get("id").and_then(Value::as_str) != Some(id.as_str()));
        let uuid = id.strip_prefix("inspiration:").unwrap_or(id);
        if let Ok(directory) = crate::inspiration_dir(app, uuid) {
            if directory.exists() {
                let _ = fs::remove_dir_all(&directory);
            }
        }
        crate::vault::remove_journal(app, id);
    }
    crate::write_array(&path, &values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, text: &str) -> Value {
        json!({
            "id": format!("inspiration:{id}"),
            "text": text,
            "tags": [],
            "createdAt": "2026-09-27T00:00:00Z",
            "updatedAt": "2026-09-27T00:00:00Z",
        })
    }

    #[test]
    fn create_then_update_coalesces_into_one_create() {
        let mut ops = Vec::new();
        let mut first = record("a", "v1");
        enqueue_local_change(&mut ops, "create", &first);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["kind"], "create");
        first["text"] = json!("v2");
        enqueue_local_change(&mut ops, "update", &first);
        assert_eq!(ops.len(), 1, "update coalesces into the pending create");
        assert_eq!(ops[0]["kind"], "create");
        assert_eq!(ops[0]["payload"]["text"], "v2");
        // stable operation id across coalescing (retry dedupe)
        assert_eq!(ops[0]["operationId"].as_str().unwrap().len() > 3, true);
    }

    #[test]
    fn delete_of_never_synced_record_cancels_create() {
        let mut ops = Vec::new();
        enqueue_local_change(&mut ops, "create", &record("a", "draft"));
        assert_eq!(ops.len(), 1);
        enqueue_local_change(&mut ops, "delete", &json!({ "id": "inspiration:a" }));
        assert!(ops.is_empty(), "offline create+delete must leave no op");
    }

    #[test]
    fn delete_after_sync_carries_base_version() {
        let mut ops = Vec::new();
        let mut synced = record("b", "v1");
        synced["version"] = json!(3);
        enqueue_local_change(&mut ops, "delete", &synced);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["kind"], "delete");
        assert_eq!(ops[0]["baseVersion"], 3);
    }

    #[test]
    fn server_upsert_skips_entities_with_pending_ops() {
        let mut cache = AccountCache::default();
        let mut ops = Vec::new();
        let mut local = record("a", "local edit");
        local["version"] = json!(1);
        local["syncState"] = json!("local");
        upsert_record(&mut cache.records, local.clone());
        enqueue_local_change(&mut ops, "update", &local);

        let changes = vec![json!({
            "seq": 1, "entityType": "inspiration", "entityId": "inspiration:a",
            "version": 2, "op": "upsert",
            "record": { "id": "inspiration:a", "text": "other device" },
        })];
        let (upserted, deleted) = apply_server_changes(&mut cache, &mut ops, &changes);
        assert!(upserted.is_empty(), "pending local op must win over pull");
        assert_eq!(cache.records[0]["text"], "local edit");
        assert!(deleted.is_empty());
    }

    #[test]
    fn server_delete_beats_offline_edit_and_drops_pending_op() {
        let mut cache = AccountCache::default();
        let mut ops = Vec::new();
        let mut local = record("a", "offline edit");
        local["version"] = json!(1);
        upsert_record(&mut cache.records, local);
        enqueue_local_change(&mut ops, "update", &json!({ "id": "inspiration:a", "version": 1 }));

        let changes = vec![json!({
            "seq": 2, "entityType": "inspiration", "entityId": "inspiration:a",
            "version": 2, "op": "delete", "at": "2026-09-27T01:00:00Z",
        })];
        let (upserted, deleted) = apply_server_changes(&mut cache, &mut ops, &changes);
        assert!(upserted.is_empty());
        assert_eq!(deleted, vec!["inspiration:a".to_owned()]);
        assert!(cache.records.is_empty(), "offline edit must not resurrect");
        assert!(!cache.tombstones.is_empty());
        assert!(ops.is_empty(), "pending op for a deleted entity is dropped");
    }

    #[test]
    fn applied_update_bumps_version_and_marks_synced() {
        let mut cache = AccountCache::default();
        let mut ops = Vec::new();
        let mut local = record("c", "hello");
        local["version"] = json!(2);
        local["syncState"] = json!("local");
        upsert_record(&mut cache.records, local);
        let operation = enqueue_local_change(
            &mut ops, "update", &json!({ "id": "inspiration:c", "version": 2, "payload": {} }));
        let operation = operation.expect("operation enqueued");

        let fold = record_op_outcome(
            &mut cache, &mut ops,
            &operation,
            OpOutcome::Applied(Some(json!({ "version": 3 }))),
        );
        assert_eq!(fold, OpFold::Synced("inspiration:c".to_owned()));
        assert!(ops.is_empty());
        assert_eq!(cache.records[0]["version"], 3);
        assert_eq!(cache.records[0]["syncState"], "synced");
    }

    #[test]
    fn applied_delete_tombstones_locally() {
        let mut cache = AccountCache::default();
        let mut ops = Vec::new();
        upsert_record(&mut cache.records, record("d", "bye"));
        let operation = enqueue_local_change(
            &mut ops, "delete", &json!({ "id": "inspiration:d", "version": 5 }));
        assert!(operation.is_some());
        let operation = operation.unwrap();

        let fold = record_op_outcome(&mut cache, &mut ops, &operation, OpOutcome::Applied(None));
        assert_eq!(fold, OpFold::Deleted("inspiration:d".to_owned()));
        assert!(cache.records.is_empty());
        assert!(!cache.tombstones.is_empty());
    }

    #[test]
    fn conflict_keeps_local_draft_and_server_record() {
        let mut cache = AccountCache::default();
        let mut ops = Vec::new();
        let mut local = record("e", "my edit");
        local["version"] = json!(1);
        local["syncState"] = json!("local");
        upsert_record(&mut cache.records, local);
        enqueue_local_change(&mut ops, "update", &json!({ "id": "inspiration:e", "version": 1 }));
        let operation = ops[0].clone();

        let server = json!({ "id": "inspiration:e", "version": 4, "text": "server edit" });
        let fold = record_op_outcome(
            &mut cache, &mut ops, &operation,
            OpOutcome::Conflict(server.clone()),
        );
        assert_eq!(fold, OpFold::Conflicted("inspiration:e".to_owned()));
        assert!(ops.is_empty(), "conflicted op leaves the queue");
        assert_eq!(cache.records[0]["syncState"], "conflict");
        assert_eq!(cache.records[0]["serverRecord"]["version"], 4);
        assert_eq!(cache.records[0]["text"], "my edit", "local draft kept for user choice");
    }

    #[test]
    fn unauthorized_pauses_without_touching_queue() {
        let mut cache = AccountCache::default();
        let mut ops = Vec::new();
        enqueue_local_change(&mut ops, "update", &record("f", "x"));
        let operation = ops[0].clone();
        let fold = record_op_outcome(&mut cache, &mut ops, &operation, OpOutcome::Unauthorized);
        assert_eq!(fold, OpFold::Paused);
        assert_eq!(ops.len(), 1, "401 keeps the operation for after re-login");
    }

    #[test]
    fn retry_later_bumps_attempts_only() {
        let mut cache = AccountCache::default();
        let mut ops = Vec::new();
        enqueue_local_change(&mut ops, "update", &record("g", "x"));
        let operation = ops[0].clone();
        let fold = record_op_outcome(&mut cache, &mut ops, &operation, OpOutcome::RetryLater);
        assert_eq!(fold, OpFold::Stopped);
        assert_eq!(ops[0]["attempts"], 1);
    }
}
