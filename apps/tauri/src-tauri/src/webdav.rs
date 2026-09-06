//! WebDAV sync: two-way merge of the local record stores (todos,
//! inspirations) plus the renderer's settings bundle, and a one-way mirror of
//! meeting-note markdown files.
//!
//! The renderer owns the settings bundle content (it lives in localStorage
//! stores); it passes a fresh bundle into `webdav_sync_now` and applies the
//! returned `settingsToApply` back onto its stores. This module owns the
//! WebDAV transport (Basic + Digest auth), the remote file layout, and the
//! three-way merge with `manifest.json` as the common ancestor.
//!
//! Remote layout (all names are fixed, so no PROPFIND/XML parsing is needed):
//!
//! ```text
//! <base>/<remotePath>/
//!   manifest.json        ancestor snapshot: per-store {id -> hash}, settings fingerprint
//!   settings.json        opaque renderer settings bundle with an `exportedAt` stamp
//!   todos.json           record array
//!   inspirations.json    record array (`audio` stripped — audio never leaves the device)
//!   notes/index.json     { fileId -> { fileName, title, hash, pushedAt } }
//!   notes/<title>.md     note markdown assembled by the renderer
//! ```

use md5::Md5;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use url::Url;

use crate::vault::{sanitize_file_base_name, VaultNote};
use crate::{
    app_data_dir, list_store, local_store_path, now, secret_get, secret_set, write_array,
    CommandResult,
};

const WEBDAV_DIR: &str = "local-webdav";
const PROGRESS_EVENT: &str = "webdav-sync-progress";
const PASSWORD_ACCOUNT: &str = "lynse_webdav_password";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const DEFAULT_REMOTE_PATH: &str = "Lynse";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

// ── Config ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavConfig {
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default = "default_remote_path")]
    pub remote_path: String,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub allow_self_signed: bool,
    #[serde(default)]
    pub last_sync_at: Option<String>,
    /// Read-only mirror of "a password exists in the keychain", so the UI can
    /// gate the enable switch without ever reading the secret back.
    #[serde(default)]
    pub has_password: bool,
}

fn default_remote_path() -> String {
    DEFAULT_REMOTE_PATH.to_owned()
}

impl Default for WebdavConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            username: String::new(),
            remote_path: default_remote_path(),
            auto_sync: false,
            allow_self_signed: false,
            last_sync_at: None,
            has_password: false,
        }
    }
}

fn webdav_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?.join(WEBDAV_DIR);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn webdav_config_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(webdav_dir(app)?.join("config.json"))
}

pub fn load_webdav_config(app: &AppHandle) -> CommandResult<WebdavConfig> {
    let path = webdav_config_path(app)?;
    let mut config = match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<WebdavConfig>(&content).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => WebdavConfig::default(),
        Err(error) => return Err(error.to_string()),
    };
    config.has_password = secret_get(app, PASSWORD_ACCOUNT)?.is_some();
    Ok(config)
}

fn save_webdav_config(app: &AppHandle, config: &WebdavConfig) -> CommandResult<()> {
    let path = webdav_config_path(app)?;
    let content = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(&path, content).map_err(|error| error.to_string())
}

/// Normalize a remote path: trim slashes, fall back to the default when empty.
fn normalize_remote_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        DEFAULT_REMOTE_PATH.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn validate_url(raw: &str) -> CommandResult<Url> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "Server URL is not a valid URL".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Server URL must use http or https".into());
    }
    if parsed.host_str().unwrap_or_default().is_empty() {
        return Err("Server URL is missing a host".into());
    }
    Ok(parsed)
}

// ── HTTP client with Basic + Digest auth ────────────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn md5_hex(input: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Parse a `WWW-Authenticate: Digest k="v", ...` challenge into a plain map.
fn parse_digest_challenge(raw: &str) -> Option<HashMap<String, String>> {
    let rest = raw.trim();
    let rest = if rest.len() >= 6 && rest[..6].eq_ignore_ascii_case("digest") {
        rest[6..].trim()
    } else {
        return None;
    };
    let mut pairs = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for character in rest.chars() {
        match character {
            '"' => {
                in_quotes = !in_quotes;
                current.push(character);
            }
            ',' if !in_quotes => {
                pairs.push(current.trim().to_owned());
                current.clear();
            }
            _ => current.push(character),
        }
    }
    if !current.trim().is_empty() {
        pairs.push(current.trim().to_owned());
    }
    let mut map = HashMap::new();
    for pair in pairs {
        if let Some((key, value)) = pair.split_once('=') {
            map.insert(
                key.trim().to_ascii_lowercase(),
                value.trim().trim_matches('"').to_owned(),
            );
        }
    }
    Some(map)
}

fn escape_digest_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Build the `Authorization: Digest ...` header for a challenge (RFC 2617,
/// qop="auth" and the legacy no-qop flow).
fn digest_authorization(
    username: &str,
    password: &str,
    challenge: &HashMap<String, String>,
    method: &str,
    uri: &str,
) -> CommandResult<String> {
    let realm = challenge.get("realm").ok_or("Digest challenge is missing realm")?;
    let nonce = challenge.get("nonce").ok_or("Digest challenge is missing nonce")?;
    let algorithm = challenge
        .get("algorithm")
        .map(String::as_str)
        .unwrap_or("MD5");
    if !algorithm.eq_ignore_ascii_case("MD5") {
        return Err(format!("Unsupported digest algorithm: {algorithm}"));
    }
    let qop_supports_auth = challenge
        .get("qop")
        .map(|raw| {
            raw.split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("auth"))
        })
        .unwrap_or(false);
    let has_qop_field = challenge.contains_key("qop");

    let ha1 = md5_hex(&format!("{username}:{realm}:{password}"));
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let cnonce = uuid::Uuid::new_v4().simple().to_string();
    let mut parts = vec![
        format!("username=\"{}\"", escape_digest_value(username)),
        format!("realm=\"{}\"", escape_digest_value(realm)),
        format!("nonce=\"{}\"", escape_digest_value(nonce)),
        format!("uri=\"{uri}\""),
        "algorithm=MD5".to_owned(),
    ];
    if qop_supports_auth {
        let nc = "00000001";
        let response = md5_hex(&format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}"));
        parts.push("qop=auth".to_owned());
        parts.push(format!("nc={nc}"));
        parts.push(format!("cnonce=\"{cnonce}\""));
        parts.push(format!("response=\"{response}\""));
    } else if has_qop_field {
        return Err("Unsupported digest quality-of-protection".into());
    } else {
        let response = md5_hex(&format!("{ha1}:{nonce}:{ha2}"));
        parts.push(format!("response=\"{response}\""));
    }
    if let Some(opaque) = challenge.get("opaque") {
        parts.push(format!("opaque=\"{}\"", escape_digest_value(opaque)));
    }
    Ok(format!("Digest {}", parts.join(", ")))
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "WebDAV request timed out".to_owned()
    } else if error.is_connect() {
        format!("Cannot connect to the WebDAV server: {error}")
    } else {
        error.to_string()
    }
}

struct WebdavClient {
    http: reqwest::Client,
    base_url: Url,
    remote_path: String,
    username: String,
    password: String,
}

impl WebdavClient {
    fn new(config: &WebdavConfig, password: &str) -> CommandResult<Self> {
        let mut base_url = validate_url(&config.url)?;
        if !base_url.path().ends_with('/') {
            let path = format!("{}/", base_url.path());
            base_url.set_path(&path);
        }
        let mut builder = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT);
        if config.allow_self_signed {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder.build().map_err(|error| error.to_string())?;
        Ok(Self {
            http,
            base_url,
            remote_path: normalize_remote_path(&config.remote_path),
            username: config.username.trim().to_owned(),
            password: password.to_owned(),
        })
    }

    /// URL for path segments under `<base>/<remotePath>/`.
    fn url_for(&self, segments: &[&str]) -> CommandResult<Url> {
        let mut url = self.base_url.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| "Server URL cannot be a base".to_owned())?;
            path.push(&self.remote_path);
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    /// Digest-aware request: send with preemptive Basic auth; on a 401 with a
    /// Digest challenge, recompute the response and send once more.
    async fn send(
        &self,
        method: reqwest::Method,
        url: Url,
        body: Option<Vec<u8>>,
        extra_headers: &[(&str, String)],
    ) -> CommandResult<reqwest::Response> {
        let mut uri = url.path().to_owned();
        if let Some(query) = url.query() {
            uri.push('?');
            uri.push_str(query);
        }
        let mut request = self.http.request(method.clone(), url.clone());
        if !self.username.is_empty() {
            request = request.basic_auth(&self.username, Some(&self.password));
        }
        if let Some(body) = &body {
            request = request.body(body.clone());
        }
        for (name, value) in extra_headers {
            request = request.header(*name, value);
        }
        let response = request.send().await.map_err(request_error)?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        let challenge = response
            .headers()
            .get("WWW-Authenticate")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let Some(challenge) = challenge else {
            return Ok(response);
        };
        let parsed = parse_digest_challenge(&challenge)
            .ok_or_else(|| "Server sent a malformed Digest challenge".to_owned())?;
        let authorization =
            digest_authorization(&self.username, &self.password, &parsed, method.as_str(), &uri)?;
        let mut retry = self.http.request(method, url.clone());
        if let Some(body) = &body {
            retry = retry.body(body.clone());
        }
        retry = retry.header("Authorization", authorization);
        for (name, value) in extra_headers {
            retry = retry.header(*name, value);
        }
        retry.send().await.map_err(request_error)
    }

    /// GET a text file; `None` when it does not exist yet (404).
    async fn get_text(&self, segments: &[&str]) -> CommandResult<Option<String>> {
        let url = self.url_for(segments)?;
        let response = self
            .send(
                reqwest::Method::GET,
                url,
                None,
                &[("Accept", "application/json".to_owned())],
            )
            .await?;
        match response.status().as_u16() {
            200 => Ok(Some(response.text().await.map_err(|error| error.to_string())?)),
            404 => Ok(None),
            status => Err(format!("Download failed with status {status}")),
        }
    }

    async fn put_text(&self, segments: &[&str], content: &str) -> CommandResult<()> {
        let url = self.url_for(segments)?;
        let response = self
            .send(
                reqwest::Method::PUT,
                url,
                Some(content.as_bytes().to_vec()),
                &[("Content-Type", "application/json; charset=utf-8".to_owned())],
            )
            .await?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(format!("Upload failed with status {status}"))
        }
    }

    /// Delete a remote file. Missing files count as already deleted.
    async fn delete_quiet(&self, segments: &[&str]) -> CommandResult<bool> {
        let url = self.url_for(segments)?;
        let response = self.send(reqwest::Method::DELETE, url, None, &[]).await?;
        match response.status().as_u16() {
            200..=299 => Ok(true),
            404 => Ok(false),
            status => Err(format!("Delete failed with status {status}")),
        }
    }

    /// Best-effort MKCOL; failures are ignored (405 already exists, and many
    /// servers auto-create parents on PUT anyway).
    async fn mkcol_quiet(&self, segments: &[&str]) {
        let Ok(url) = self.url_for(segments) else {
            return;
        };
        let _ = self
            .send(reqwest::Method::from_bytes(b"MKCOL").unwrap(), url, None, &[])
            .await;
    }

    /// PROPFIND Depth:0 on the remote root; returns the HTTP status so the
    /// caller can turn it into a friendly message.
    async fn probe(&self) -> CommandResult<u16> {
        let url = self.url_for(&[])?;
        let response = self
            .send(
                reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
                url,
                None,
                &[("Depth", "0".to_owned())],
            )
            .await?;
        Ok(response.status().as_u16())
    }

    async fn ensure_remote_dirs(&self) {
        self.mkcol_quiet(&[]).await;
        self.mkcol_quiet(&["notes"]).await;
    }
}

// ── Three-way merge engine ──────────────────────────────────────────────────

/// Per-store sync spec: where the data lives locally and remotely, and which
/// fields never leave the device (stripped before hashing/upload; re-attached
/// locally when a remote record wins the merge).
struct StoreSyncSpec {
    name: &'static str,
    local_dir: &'static str,
    remote_file: &'static str,
    strip_fields: &'static [&'static str],
}

const SYNC_STORES: [StoreSyncSpec; 2] = [
    StoreSyncSpec {
        name: "todos",
        local_dir: "local-todos",
        remote_file: "todos.json",
        strip_fields: &[],
    },
    StoreSyncSpec {
        name: "inspirations",
        local_dir: "local-inspirations",
        remote_file: "inspirations.json",
        strip_fields: &["audio"],
    },
];

/// `manifest.json` — the common ancestor of the last successful sync.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifest {
    schema_version: u32,
    /// store name -> id -> content hash (computed on the stripped record, so
    /// device-only fields like `audio` never cause phantom changes).
    stores: HashMap<String, HashMap<String, String>>,
    settings_hash: Option<String>,
    settings_exported_at: Option<String>,
    updated_at: Option<String>,
}

fn strip_fields(value: &Value, fields: &[&str]) -> Value {
    let mut cloned = value.clone();
    if let Some(object) = cloned.as_object_mut() {
        for field in fields {
            object.remove(*field);
        }
    }
    cloned
}

fn record_hash(value: &Value, strip: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(strip_fields(value, strip).to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn ids_and_hashes(records: &[Value], strip: &[&str]) -> HashMap<String, String> {
    records
        .iter()
        .filter_map(|record| {
            let id = record.get("id").and_then(Value::as_str)?;
            Some((id.to_owned(), record_hash(record, strip)))
        })
        .collect()
}

fn hash_maps_equal(left: &HashMap<String, String>, right: &HashMap<String, String>) -> bool {
    left.len() == right.len() && left.iter().all(|(key, value)| right.get(key) == Some(value))
}

fn updated_at(record: &Value) -> &str {
    record
        .get("updatedAt")
        .or_else(|| record.get("createdAt"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

struct MergeInput {
    ancestor: HashMap<String, String>,
    local: Vec<Value>,
    remote: Vec<Value>,
    strip_fields: &'static [&'static str],
}

struct MergeOutcome {
    /// What the local store should hold afterwards (full records, device-only
    /// fields preserved).
    local_records: Vec<Value>,
    /// What the remote file should hold (stripped records).
    remote_records: Vec<Value>,
    /// id -> stripped hash, the next sync's ancestor snapshot for this store.
    manifest_hashes: HashMap<String, String>,
    local_changed: bool,
    remote_changed: bool,
    pushed: usize,
    pulled: usize,
    deletions: usize,
    conflicts: usize,
}

/// Three-way merge of one record store with `ancestor` (last-synced hashes) as
/// the common ancestor. Rules: one-sided changes win; both-sides edits resolve
/// by `updatedAt` (newer wins, ties go to local); a deletion loses against an
/// edit on the other side; a deletion only propagates when the surviving side
/// is unchanged since the ancestor.
fn merge_store(input: &MergeInput) -> MergeOutcome {
    let strip = input.strip_fields;
    let local_map: HashMap<String, &Value> = input
        .local
        .iter()
        .filter_map(|record| {
            record
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), record))
        })
        .collect();
    let remote_map: HashMap<String, &Value> = input
        .remote
        .iter()
        .filter_map(|record| {
            record
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), record))
        })
        .collect();

    // Union of ids, local order first so untouched stores keep their order.
    let mut ordered_ids: Vec<String> = Vec::new();
    for key in local_map.keys().chain(remote_map.keys()) {
        if !ordered_ids.contains(key) {
            ordered_ids.push(key.clone());
        }
    }

    let mut local_records = Vec::with_capacity(ordered_ids.len());
    let mut remote_records = Vec::with_capacity(ordered_ids.len());
    let mut manifest_hashes: HashMap<String, String> = HashMap::new();
    let mut pushed = 0;
    let mut pulled = 0;
    let mut deletions = 0;
    let mut conflicts = 0;

    for id in &ordered_ids {
        let local = local_map.get(id).copied();
        let remote = remote_map.get(id).copied();
        let ancestor_hash = input.ancestor.get(id);
        let local_hash = local.map(|record| record_hash(record, strip));
        let remote_hash = remote.map(|record| record_hash(record, strip));

        let chosen: Option<Value> = match (local, remote) {
            (Some(local), Some(remote)) => {
                if local_hash == remote_hash {
                    Some(local.clone())
                } else {
                    let local_modified = ancestor_hash != local_hash.as_ref();
                    let remote_modified = ancestor_hash != remote_hash.as_ref();
                    if !remote_modified {
                        pushed += 1;
                        Some(local.clone())
                    } else if !local_modified {
                        pulled += 1;
                        Some(with_preserved_fields(remote, local, strip))
                    } else {
                        conflicts += 1;
                        if updated_at(local) >= updated_at(remote) {
                            pushed += 1;
                            Some(local.clone())
                        } else {
                            pulled += 1;
                            Some(with_preserved_fields(remote, local, strip))
                        }
                    }
                }
            }
            (Some(local), None) => match ancestor_hash {
                // Present in the ancestor and unchanged locally: the other
                // device deleted it.
                Some(ancestor) if Some(ancestor.as_str()) == local_hash.as_deref() => {
                    deletions += 1;
                    None
                }
                // Newly added, or edited locally while deleted remotely
                // (edits beat deletions).
                _ => {
                    pushed += 1;
                    Some(local.clone())
                }
            },
            (None, Some(remote)) => match ancestor_hash {
                Some(ancestor) if Some(ancestor.as_str()) == remote_hash.as_deref() => {
                    deletions += 1;
                    None
                }
                _ => {
                    pulled += 1;
                    Some(remote.clone())
                }
            },
            (None, None) => None,
        };

        if let Some(record) = chosen {
            local_records.push(record.clone());
            remote_records.push(strip_fields(&record, strip));
            manifest_hashes.insert(id.clone(), record_hash(&record, strip));
        }
    }

    let local_changed =
        !hash_maps_equal(&ids_and_hashes(&input.local, strip), &ids_and_hashes(&local_records, strip));
    let remote_changed = !hash_maps_equal(
        &ids_and_hashes(&input.remote, strip),
        &ids_and_hashes(&remote_records, strip),
    );

    MergeOutcome {
        local_records,
        remote_records,
        manifest_hashes,
        local_changed,
        remote_changed,
        pushed,
        pulled,
        deletions,
        conflicts,
    }
}

/// A remote record won the merge: copy device-only fields (e.g. `audio`) from
/// the local record back so the local store never loses them.
fn with_preserved_fields(remote: &Value, local: &Value, strip: &[&str]) -> Value {
    let mut merged = remote.clone();
    let (Some(merged_object), Some(local_object)) = (merged.as_object_mut(), local.as_object()) else {
        return merged;
    };
    for field in strip {
        if !merged_object.contains_key(*field) {
            if let Some(value) = local_object.get(*field) {
                merged_object.insert((*field).to_owned(), value.clone());
            }
        }
    }
    merged
}

// ── Settings bundle decision ────────────────────────────────────────────────

struct SettingsDecision {
    push_local: bool,
    apply_remote: bool,
    conflict: bool,
}

/// The bundle carries a fresh `exportedAt` on every collect, so fingerprints
/// are taken over the bundle *without* it.
fn settings_core(bundle: &Value) -> Value {
    let mut cloned = bundle.clone();
    if let Some(object) = cloned.as_object_mut() {
        object.remove("exportedAt");
    }
    cloned
}

fn decide_settings(
    local_hash: Option<&str>,
    remote_hash: Option<&str>,
    ancestor_hash: Option<&str>,
) -> SettingsDecision {
    let local_changed = local_hash != ancestor_hash;
    let remote_changed = remote_hash != ancestor_hash;
    match (local_changed, remote_changed) {
        // First sync against a server that already has settings: adopt them
        // (the "restore onto a new device" path).
        (true, true) if ancestor_hash.is_none() => SettingsDecision {
            push_local: false,
            apply_remote: true,
            conflict: false,
        },
        // Both edited since the last sync: the active device wins.
        (true, true) => SettingsDecision {
            push_local: true,
            apply_remote: false,
            conflict: true,
        },
        (true, false) => SettingsDecision {
            push_local: true,
            apply_remote: false,
            conflict: false,
        },
        (false, true) => SettingsDecision {
            push_local: false,
            apply_remote: true,
            conflict: false,
        },
        (false, false) => SettingsDecision {
            push_local: false,
            apply_remote: false,
            conflict: false,
        },
    }
}

// ── Sync summary ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub pushed: usize,
    pub pulled: usize,
    pub deletions: usize,
    pub conflicts: usize,
    pub settings_applied: bool,
    pub settings_to_apply: Option<Value>,
    pub synced_at: String,
}

async fn read_remote_array(client: &WebdavClient, file: &str) -> CommandResult<Vec<Value>> {
    match client.get_text(&[file]).await? {
        Some(content) => {
            serde_json::from_str(&content).map_err(|_| format!("Remote {file} is not valid JSON"))
        }
        None => Ok(Vec::new()),
    }
}

async fn sync_store(
    app: &AppHandle,
    client: &WebdavClient,
    spec: &StoreSyncSpec,
    ancestor: HashMap<String, String>,
) -> CommandResult<MergeOutcome> {
    let local = list_store(app, spec.local_dir)?;
    let remote = read_remote_array(client, spec.remote_file).await?;
    let outcome = merge_store(&MergeInput {
        ancestor,
        local,
        remote,
        strip_fields: spec.strip_fields,
    });
    if outcome.remote_changed {
        let content =
            serde_json::to_string(&outcome.remote_records).map_err(|error| error.to_string())?;
        client.put_text(&[spec.remote_file], &content).await?;
    }
    if outcome.local_changed {
        write_array(&local_store_path(app, spec.local_dir)?, &outcome.local_records)?;
    }
    Ok(outcome)
}

async fn run_sync(
    app: &AppHandle,
    config: &WebdavConfig,
    settings_bundle: &Value,
) -> CommandResult<SyncSummary> {
    let Some(password) = secret_get(app, PASSWORD_ACCOUNT)? else {
        return Err("WebDAV password is not configured".into());
    };
    let client = WebdavClient::new(config, &password)?;
    client.ensure_remote_dirs().await;

    // Ancestor manifest.
    let manifest: SyncManifest = match client.get_text(&["manifest.json"]).await? {
        Some(content) => serde_json::from_str(&content)
            .map_err(|_| "Remote manifest.json is not valid JSON".to_owned())?,
        None => SyncManifest::default(),
    };

    // Record stores.
    let mut pushed = 0;
    let mut pulled = 0;
    let mut deletions = 0;
    let mut conflicts = 0;
    let mut store_hashes: HashMap<String, HashMap<String, String>> = HashMap::new();
    let total = SYNC_STORES.len();
    for (index, spec) in SYNC_STORES.iter().enumerate() {
        let ancestor = manifest.stores.get(spec.name).cloned().unwrap_or_default();
        let outcome = sync_store(app, &client, spec, ancestor).await?;
        pushed += outcome.pushed;
        pulled += outcome.pulled;
        deletions += outcome.deletions;
        conflicts += outcome.conflicts;
        store_hashes.insert(spec.name.to_owned(), outcome.manifest_hashes.clone());
        let _ = app.emit(
            PROGRESS_EVENT,
            json!({ "type": "records", "done": index + 1, "total": total, "store": spec.name }),
        );
    }

    // Settings bundle. An empty bundle means "nothing to sync yet".
    let bundle_is_empty = !settings_bundle.as_object().is_some_and(|object| !object.is_empty());
    let local_exported_at = settings_bundle
        .get("exportedAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let local_hash = if bundle_is_empty {
        None
    } else {
        Some(sha256_hex(settings_core(settings_bundle).to_string().as_bytes()))
    };
    let remote_settings: Option<Value> = match client.get_text(&["settings.json"]).await? {
        Some(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|_| "Remote settings.json is not valid JSON".to_owned())?,
        None => None,
    };
    let remote_hash = remote_settings
        .as_ref()
        .map(|bundle| sha256_hex(settings_core(bundle).to_string().as_bytes()));
    let decision = decide_settings(
        local_hash.as_deref(),
        remote_hash.as_deref(),
        manifest.settings_hash.as_deref(),
    );
    let mut settings_to_apply = None;
    let mut settings_exported_at = manifest.settings_exported_at.clone();
    if decision.apply_remote {
        if let Some(remote) = &remote_settings {
            settings_to_apply = Some(remote.clone());
            settings_exported_at = remote
                .get("exportedAt")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(settings_exported_at);
        }
    } else if decision.push_local && !bundle_is_empty {
        let content = serde_json::to_string(settings_bundle).map_err(|error| error.to_string())?;
        client.put_text(&["settings.json"], &content).await?;
        settings_exported_at = Some(local_exported_at);
    }
    if decision.conflict {
        conflicts += 1;
    }

    // Refresh the ancestor manifest for the next sync.
    let next_manifest = SyncManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        stores: store_hashes,
        settings_hash: if decision.apply_remote {
            remote_hash.clone()
        } else {
            local_hash.clone()
        },
        settings_exported_at,
        updated_at: Some(now()),
    };
    let manifest_content = serde_json::to_string(&next_manifest).map_err(|error| error.to_string())?;
    client
        .put_text(&["manifest.json"], &manifest_content)
        .await?;

    let synced_at = now();
    let _ = app.emit(
        PROGRESS_EVENT,
        json!({ "type": "done", "pushed": pushed, "pulled": pulled, "deletions": deletions, "conflicts": conflicts }),
    );
    Ok(SyncSummary {
        pushed,
        pulled,
        deletions,
        conflicts,
        settings_applied: settings_to_apply.is_some(),
        settings_to_apply,
        synced_at,
    })
}

// ── Notes mirror (one-way push) ─────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavBatchSummary {
    pub written: usize,
    pub failed: usize,
    pub removed: usize,
    pub errors: Vec<String>,
}

/// In-memory view of `notes/index.json`: fileId -> { fileName, ... }.
type NotesIndex = Map<String, Value>;

fn parse_notes_index(content: Option<String>) -> NotesIndex {
    content
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn resolve_note_file_name(index: &NotesIndex, note: &VaultNote) -> String {
    let base = sanitize_file_base_name(&note.title);
    let file_name = format!("{}.md", base);
    let taken_by_other = index.iter().any(|(id, entry)| {
        id != &note.file_id
            && entry.get("fileName").and_then(Value::as_str) == Some(file_name.as_str())
    });
    if taken_by_other {
        let suffix: String = note
            .file_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(6)
            .collect();
        format!("{}-{}.md", base, suffix)
    } else {
        file_name
    }
}

async fn put_notes_impl(app: &AppHandle, notes: &[VaultNote]) -> CommandResult<WebdavBatchSummary> {
    let config = load_webdav_config(app)?;
    if !config.enabled {
        return Err("WebDAV sync is disabled".into());
    }
    let Some(password) = secret_get(app, PASSWORD_ACCOUNT)? else {
        return Err("WebDAV password is not configured".into());
    };
    let client = WebdavClient::new(&config, &password)?;
    client.ensure_remote_dirs().await;

    let old_index = parse_notes_index(client.get_text(&["notes", "index.json"]).await?);

    let mut next_index: NotesIndex = Map::new();
    let mut written = 0;
    let mut failed = 0;
    let mut errors = Vec::new();
    let total = notes.len();
    for (done, note) in notes.iter().enumerate() {
        let file_name = resolve_note_file_name(&old_index, note);
        let hash = sha256_hex(note.markdown.as_bytes());
        let previous = old_index.get(&note.file_id);
        let unchanged = previous
            .and_then(|entry| entry.get("hash"))
            .and_then(Value::as_str)
            == Some(hash.as_str())
            && previous
                .and_then(|entry| entry.get("fileName"))
                .and_then(Value::as_str)
                == Some(file_name.as_str());
        if unchanged {
            // Keep the old pushedAt so unchanged notes are visible as such.
            next_index.insert(note.file_id.clone(), previous.cloned().unwrap());
        } else if let Err(error) = client
            .put_text(&["notes", file_name.as_str()], &note.markdown)
            .await
        {
            failed += 1;
            errors.push(format!("{}: {}", note.title, error));
            // Keep the stale entry so the mirror cleanup below does not
            // delete a note whose update merely failed.
            if let Some(previous) = previous.cloned() {
                next_index.insert(note.file_id.clone(), previous);
            }
        } else {
            next_index.insert(
                note.file_id.clone(),
                json!({
                    "fileName": file_name,
                    "title": note.title,
                    "hash": hash,
                    "pushedAt": now(),
                }),
            );
            written += 1;
        }
        let _ = app.emit(
            PROGRESS_EVENT,
            json!({ "type": "notes", "done": done + 1, "total": total, "title": note.title }),
        );
    }

    // Mirror semantics: drop remote files that this batch no longer covers
    // (deleted notes, renamed titles).
    let mut removed = 0;
    for entry in old_index.values() {
        let Some(file_name) = entry.get("fileName").and_then(Value::as_str) else {
            continue;
        };
        let still_used = next_index
            .values()
            .any(|fresh| fresh.get("fileName").and_then(Value::as_str) == Some(file_name));
        if !still_used {
            match client.delete_quiet(&["notes", file_name]).await {
                Ok(_) => removed += 1,
                Err(error) => errors.push(format!("{file_name}: {error}")),
            }
        }
    }

    let index_content = serde_json::to_string(&next_index).map_err(|error| error.to_string())?;
    client
        .put_text(&["notes", "index.json"], &index_content)
        .await?;
    let _ = app.emit(
        PROGRESS_EVENT,
        json!({ "type": "notes-done", "written": written, "failed": failed, "removed": removed }),
    );
    Ok(WebdavBatchSummary {
        written,
        failed,
        removed,
        errors,
    })
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn webdav_config_get(app: AppHandle) -> CommandResult<WebdavConfig> {
    load_webdav_config(&app)
}

#[tauri::command]
pub fn webdav_config_save(app: AppHandle, config: WebdavConfig) -> CommandResult<WebdavConfig> {
    let mut config = config;
    config.url = config.url.trim().to_owned();
    config.username = config.username.trim().to_owned();
    config.remote_path = normalize_remote_path(&config.remote_path);
    if config.enabled {
        if config.url.is_empty() {
            return Err("Server URL is required".into());
        }
        validate_url(&config.url)?;
    }
    save_webdav_config(&app, &config)?;
    config.has_password = secret_get(&app, PASSWORD_ACCOUNT)?.is_some();
    Ok(config)
}

#[tauri::command]
pub fn webdav_set_password(app: AppHandle, password: String) -> CommandResult<()> {
    if password.is_empty() {
        crate::secret_delete(&app, PASSWORD_ACCOUNT)
    } else {
        secret_set(&app, PASSWORD_ACCOUNT, &password)
    }
}

/// Validate server URL + credentials before saving. An empty `password`
/// argument falls back to the stored one so "test" works after re-entering
/// just the URL.
#[tauri::command(async)]
pub async fn webdav_test_connection(
    app: AppHandle,
    config: WebdavConfig,
    password: Option<String>,
) -> CommandResult<()> {
    validate_url(&config.url)?;
    let password = match password.filter(|value| !value.is_empty()) {
        Some(value) => value,
        None => secret_get(&app, PASSWORD_ACCOUNT)?.ok_or("WebDAV password is not configured")?,
    };
    let client = WebdavClient::new(&config, &password)?;
    match client.probe().await? {
        207 | 200 => Ok(()),
        401 => Err("Authentication failed: check the username and app password".into()),
        404 => {
            // Some servers only expose the directory after MKCOL.
            client.mkcol_quiet(&[]).await;
            match client.probe().await? {
                207 | 200 => Ok(()),
                _ => Err(format!(
                    "Remote directory /{} does not exist and could not be created",
                    client.remote_path
                )),
            }
        }
        status => Err(format!("Server responded with status {status}")),
    }
}

#[tauri::command(async)]
pub async fn webdav_sync_now(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    settings_bundle: Value,
) -> CommandResult<SyncSummary> {
    {
        let mut busy = state
            .webdav_sync_in_progress
            .lock()
            .map_err(|_| "WebDAV sync lock is poisoned")?;
        if *busy {
            return Err("A WebDAV sync is already running".into());
        }
        *busy = true;
    }
    let result = async {
        let config = load_webdav_config(&app)?;
        if !config.enabled {
            return Err("WebDAV sync is disabled".into());
        }
        run_sync(&app, &config, &settings_bundle).await
    }
    .await;
    if let Ok(mut busy) = state.webdav_sync_in_progress.lock() {
        *busy = false;
    }
    let summary = result?;
    if let Ok(mut config) = load_webdav_config(&app) {
        config.last_sync_at = Some(summary.synced_at.clone());
        let _ = save_webdav_config(&app, &config);
    }
    Ok(summary)
}

#[tauri::command(async)]
pub async fn webdav_put_notes(
    app: AppHandle,
    notes: Vec<VaultNote>,
) -> CommandResult<WebdavBatchSummary> {
    put_notes_impl(&app, &notes).await
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::MAX_FILE_NAME_CHARS;
    use serde_json::json;

    fn record(id: &str, updated_at: &str, text: &str) -> Value {
        json!({ "id": id, "updatedAt": updated_at, "text": text })
    }

    fn hashes<'a>(records: impl IntoIterator<Item = &'a Value>) -> HashMap<String, String> {
        records
            .into_iter()
            .map(|record| {
                (
                    record.get("id").and_then(Value::as_str).unwrap().to_owned(),
                    record_hash(record, &[]),
                )
            })
            .collect()
    }

    fn merge(ancestor: HashMap<String, String>, local: Vec<Value>, remote: Vec<Value>) -> MergeOutcome {
        merge_store(&MergeInput {
            ancestor,
            local,
            remote,
            strip_fields: &[],
        })
    }

    #[test]
    fn digest_challenge_parses_quoted_pairs() {
        let challenge = parse_digest_challenge(
            r#"Digest realm="testrealm", nonce="abc123", qop="auth", opaque="0000", stale=FALSE, algorithm=MD5"#,
        )
        .unwrap();
        assert_eq!(challenge.get("realm").map(String::as_str), Some("testrealm"));
        assert_eq!(challenge.get("nonce").map(String::as_str), Some("abc123"));
        assert_eq!(challenge.get("qop").map(String::as_str), Some("auth"));
        assert_eq!(challenge.get("algorithm").map(String::as_str), Some("MD5"));
        assert!(parse_digest_challenge("Basic realm=\"x\"").is_none());
    }

    #[test]
    fn digest_authorization_covers_qop_and_legacy_flows() {
        let mut challenge = HashMap::new();
        challenge.insert("realm".to_owned(), "r".to_owned());
        challenge.insert("nonce".to_owned(), "n".to_owned());
        challenge.insert("qop".to_owned(), "auth".to_owned());
        let with_qop = digest_authorization("user", "pass", &challenge, "GET", "/dav/").unwrap();
        assert!(with_qop.contains("qop=auth"));
        assert!(with_qop.contains("nc=00000001"));
        assert!(with_qop.contains("cnonce=\""));

        challenge.remove("qop");
        let legacy = digest_authorization("user", "pass", &challenge, "GET", "/dav/").unwrap();
        assert!(!legacy.contains("qop="));
        assert!(legacy.contains("response=\""));
    }

    #[test]
    fn merge_local_addition_is_pushed() {
        let local = vec![record("a", "2026-01-01T00:00:00Z", "hello")];
        let outcome = merge(HashMap::new(), local.clone(), Vec::new());
        assert_eq!(outcome.pushed, 1);
        assert!(outcome.remote_changed);
        assert!(!outcome.local_changed);
        assert_eq!(outcome.local_records, local);
    }

    #[test]
    fn merge_remote_addition_is_pulled() {
        let remote = vec![record("r", "2026-01-01T00:00:00Z", "from afar")];
        let outcome = merge(HashMap::new(), Vec::new(), remote);
        assert_eq!(outcome.pulled, 1);
        assert!(outcome.local_changed);
        assert_eq!(outcome.local_records.len(), 1);
    }

    #[test]
    fn merge_both_modified_uses_last_write_wins() {
        let base = record("x", "2026-01-01T00:00:00Z", "base");
        let ancestor = hashes([&base]);
        let local = vec![record("x", "2026-01-02T00:00:00Z", "local edit")];
        let remote = vec![record("x", "2026-01-03T00:00:00Z", "remote edit")];
        let outcome = merge(ancestor.clone(), local, remote);
        assert_eq!(outcome.conflicts, 1);
        assert_eq!(outcome.pulled, 1);
        assert_eq!(
            outcome.local_records[0].get("text").and_then(Value::as_str),
            Some("remote edit")
        );

        // Local newer: local wins and is pushed.
        let local = vec![record("x", "2026-01-04T00:00:00Z", "local newer")];
        let remote = vec![record("x", "2026-01-03T00:00:00Z", "remote edit")];
        let outcome = merge(ancestor, local, remote);
        assert_eq!(outcome.conflicts, 1);
        assert_eq!(outcome.pushed, 1);
        assert_eq!(
            outcome.local_records[0].get("text").and_then(Value::as_str),
            Some("local newer")
        );
    }

    #[test]
    fn merge_tie_goes_to_local() {
        let base = record("x", "2026-01-01T00:00:00Z", "base");
        let ancestor = hashes([&base]);
        let local = vec![record("x", "2026-01-02T00:00:00Z", "local tie")];
        let remote = vec![record("x", "2026-01-02T00:00:00Z", "remote tie")];
        let outcome = merge(ancestor, local, remote);
        assert_eq!(outcome.conflicts, 1);
        assert_eq!(outcome.pushed, 1);
        assert_eq!(
            outcome.local_records[0].get("text").and_then(Value::as_str),
            Some("local tie")
        );
    }

    #[test]
    fn merge_remote_deletion_propagates_when_local_unchanged() {
        let base = record("x", "2026-01-01T00:00:00Z", "base");
        let ancestor = hashes([&base]);
        let outcome = merge(ancestor, vec![base.clone()], Vec::new());
        assert_eq!(outcome.deletions, 1);
        assert!(outcome.local_records.is_empty());
        assert!(outcome.local_changed);
    }

    #[test]
    fn merge_local_edit_beats_remote_deletion() {
        let base = record("x", "2026-01-01T00:00:00Z", "base");
        let ancestor = hashes([&base]);
        let local = vec![record("x", "2026-01-02T00:00:00Z", "edited locally")];
        let outcome = merge(ancestor, local.clone(), Vec::new());
        assert_eq!(outcome.local_records, local);
        assert_eq!(outcome.pushed, 1);
        assert_eq!(outcome.deletions, 0);
    }

    #[test]
    fn merge_ignores_stripped_fields_for_changes() {
        // Same text, but only the local side carries the device-only `audio`
        // field: no phantom change should be detected.
        let base = json!({ "id": "i1", "updatedAt": "2026-01-01T00:00:00Z", "text": "idea" });
        let ancestor = HashMap::from([("i1".to_owned(), record_hash(&base, &["audio"]))]);
        let local = vec![json!({ "id": "i1", "updatedAt": "2026-01-01T00:00:00Z", "text": "idea", "audio": { "file": "a.wav" } })];
        let remote = vec![json!({ "id": "i1", "updatedAt": "2026-01-01T00:00:00Z", "text": "idea" })];
        let outcome = merge_store(&MergeInput {
            ancestor,
            local: local.clone(),
            remote,
            strip_fields: &["audio"],
        });
        assert!(!outcome.local_changed);
        assert!(!outcome.remote_changed);
        // And the audio field survives on the local side.
        assert!(outcome.local_records[0].get("audio").is_some());
        // Remote copy is stripped.
        assert!(outcome.remote_records[0].get("audio").is_none());
    }

    #[test]
    fn merge_remote_win_reattaches_audio() {
        let base = json!({ "id": "i1", "updatedAt": "2026-01-01T00:00:00Z", "text": "old" });
        let ancestor = HashMap::from([("i1".to_owned(), record_hash(&base, &["audio"]))]);
        let local = vec![json!({ "id": "i1", "updatedAt": "2026-01-01T00:00:00Z", "text": "old", "audio": { "file": "a.wav" } })];
        let remote = vec![json!({ "id": "i1", "updatedAt": "2026-01-02T00:00:00Z", "text": "newer from other device" })];
        let outcome = merge_store(&MergeInput {
            ancestor,
            local,
            remote,
            strip_fields: &["audio"],
        });
        assert_eq!(outcome.pulled, 1);
        assert_eq!(
            outcome.local_records[0].get("text").and_then(Value::as_str),
            Some("newer from other device")
        );
        assert!(outcome.local_records[0].get("audio").is_some());
    }

    #[test]
    fn settings_first_sync_adopts_remote_bundle() {
        let decision = decide_settings(Some("local-hash"), Some("remote-hash"), None);
        assert!(decision.apply_remote);
        assert!(!decision.push_local);
    }

    #[test]
    fn settings_both_changed_prefers_local_after_first_sync() {
        let decision = decide_settings(Some("local-hash"), Some("remote-hash"), Some("ancestor"));
        assert!(decision.push_local);
        assert!(decision.conflict);
        assert!(!decision.apply_remote);
    }

    #[test]
    fn settings_one_sided_changes_apply_cleanly() {
        let remote_only = decide_settings(Some("same"), Some("changed"), Some("same"));
        assert!(remote_only.apply_remote);

        let local_only = decide_settings(Some("changed"), Some("same"), Some("same"));
        assert!(local_only.push_local);
        assert!(!local_only.apply_remote);

        let idle = decide_settings(Some("same"), Some("same"), Some("same"));
        assert!(!idle.push_local && !idle.apply_remote);
    }

    #[test]
    fn normalize_remote_path_trims_and_falls_back() {
        assert_eq!(normalize_remote_path(" /My Notes/ "), "My Notes");
        assert_eq!(normalize_remote_path(""), DEFAULT_REMOTE_PATH);
        assert_eq!(normalize_remote_path("/"), DEFAULT_REMOTE_PATH);
    }

    #[test]
    fn sanitize_file_base_name_matches_vault_behavior() {
        assert_eq!(sanitize_file_base_name("产品评审会"), "产品评审会");
        assert_eq!(
            sanitize_file_base_name("a/b\\c:d*e?f\"g<h>i|j"),
            "abcdefghij"
        );
        let long = "长".repeat(200);
        assert_eq!(
            sanitize_file_base_name(&long).chars().count(),
            MAX_FILE_NAME_CHARS
        );
    }

    #[test]
    fn notes_index_collision_appends_id_suffix() {
        let note = VaultNote {
            file_id: "file:abcd1234".to_owned(),
            title: "评审会".to_owned(),
            markdown: "# 评审会".to_owned(),
        };
        let mut index = NotesIndex::new();
        index.insert(
            "file:other".to_owned(),
            json!({ "fileName": "评审会.md", "title": "评审会" }),
        );
        let name = resolve_note_file_name(&index, &note);
        assert_eq!(name, "评审会-fileab.md");

        // Same note re-resolving against its own entry keeps the plain name.
        let mut own_index = NotesIndex::new();
        own_index.insert(
            "file:abcd1234".to_owned(),
            json!({ "fileName": "评审会.md", "title": "评审会" }),
        );
        assert_eq!(resolve_note_file_name(&own_index, &note), "评审会.md");
    }
}
