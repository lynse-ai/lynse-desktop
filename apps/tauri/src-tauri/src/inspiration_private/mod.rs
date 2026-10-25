//! Account-scoped private inspirations. Secrets and decrypt capabilities stay native.
pub(crate) mod cloud;
mod crypto;
pub(crate) mod devices;
pub(crate) mod migration;
pub(crate) mod screen;

use crate::{inspiration_cloud, CommandResult};
use crypto::{Envelope, Sensitive};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use zeroize::{Zeroize, Zeroizing};

pub const KEYCHAIN_SERVICE: &str = "com.lynse.inspiration.e2ee.v1";
pub const IDLE: Duration = Duration::from_secs(300);

pub struct Unlocked {
    pub scope: String,
    pub bundle: Sensitive,
    pub touched: Instant,
}
pub struct Staged {
    pub scope: String,
    pub generation: u64,
    pub key: Zeroizing<Vec<u8>>,
    pub path: PathBuf,
    pub name: String,
    pub mime: String,
}
pub struct Capability {
    scope: String,
    id: String,
    file: String,
    generation: u64,
}
#[derive(Default)]
pub struct PrivateState {
    pub unlocked: Mutex<Option<Unlocked>>,
    pub token: Mutex<Option<Zeroizing<String>>>,
    pub transport: Mutex<Option<(String, Zeroizing<String>)>>,
    pub staged: Mutex<HashMap<String, Staged>>,
    capabilities: Mutex<HashMap<String, Capability>>,
    pub sensitive_seen: std::sync::atomic::AtomicBool,
    pub generation: AtomicU64,
    pub binding_generation: AtomicU64,
    pub serial: Mutex<()>,
    pub sync: tokio::sync::Mutex<()>,
    attempts: Mutex<(u32, Option<Instant>)>,
}

pub fn scope(app: &AppHandle) -> CommandResult<String> {
    let binding = inspiration_cloud::read_binding(app)?.ok_or("verified_account_required")?;
    if !binding.account_scope.is_empty() {
        return Ok(binding.account_scope);
    }
    use sha2::{Digest, Sha256};
    Ok(format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\0{}\0{}",
            binding.api_base, binding.backend_host, binding.user_id
        ))
    ))
}
pub fn storage_scope(app: &AppHandle) -> CommandResult<String> {
    Ok(if inspiration_cloud::read_binding(app)?.is_some() {
        scope(app)?
    } else {
        "unbound".into()
    })
}
pub fn index_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = crate::app_data_dir(app)?
        .join("private-inspirations")
        .join(storage_scope(app)?)
        .join("index.json");
    fs::create_dir_all(path.parent().ok_or("invalid_storage_root")?)
        .map_err(|_| "storage_unavailable")?;
    Ok(path)
}
pub fn directory(app: &AppHandle, id: &str) -> CommandResult<PathBuf> {
    let id = id.strip_prefix("inspiration:").unwrap_or(id);
    uuid::Uuid::parse_str(id).map_err(|_| "invalid_identifier")?;
    Ok(
        crate::vault::content_dir(app, crate::vault::ContentKind::KnowledgeMemory)?
            .join(storage_scope(app)?)
            .join("Inspirations")
            .join(id),
    )
}
pub fn key_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(crate::app_data_dir(app)?
        .join("private-inspirations")
        .join(scope(app)?)
        .join("device.json"))
}
pub fn stored(app: &AppHandle, id: &str) -> CommandResult<Value> {
    crate::read_array(&index_path(app)?)?
        .into_iter()
        .find(|r| r["id"] == id)
        .ok_or("inspiration_not_found".into())
}
pub fn put(app: &AppHandle, row: &Value) -> CommandResult<()> {
    if row["account_scope"]
        .as_str()
        .is_some_and(|owner| Some(owner) != storage_scope(app).ok().as_deref())
    {
        return Err("account_changed".into());
    }
    let path = index_path(app)?;
    let mut rows = crate::read_array(&path)?;
    if let Some(i) = rows.iter().position(|r| r["id"] == row["id"]) {
        rows[i] = row.clone()
    } else {
        rows.push(row.clone())
    }
    crate::write_array(&path, &rows)
}
struct CreatedAssets {
    paths: Vec<PathBuf>,
    committed: bool,
}
impl CreatedAssets {
    fn new() -> Self {
        Self {
            paths: Vec::new(),
            committed: false,
        }
    }
}
impl Drop for CreatedAssets {
    fn drop(&mut self) {
        if !self.committed {
            for path in &self.paths {
                let _ = fs::remove_file(path);
            }
        }
    }
}
struct RevocableReader<'a, R> {
    source: R,
    generation: &'a AtomicU64,
    expected: u64,
}
impl<'a, R> RevocableReader<'a, R> {
    fn new(source: R, generation: &'a AtomicU64, expected: u64) -> Self {
        Self {
            source,
            generation,
            expected,
        }
    }
}
impl<R: Read> Read for RevocableReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.generation.load(Ordering::SeqCst) != self.expected {
            // Interrupted is retried automatically by read_exact; use a terminal error.
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "private read revoked",
            ));
        }
        self.source.read(buffer)
    }
}
pub fn protected(row: &Value) -> bool {
    row["protection"] == "e2ee" || row["transition"].is_object()
}
pub fn lock(app: &AppHandle) {
    let state = app.state::<PrivateState>();
    if let Ok(mut session) = state.unlocked.lock() {
        state.generation.fetch_add(1, Ordering::SeqCst);
        *session = None;
    } else {
        state.generation.fetch_add(1, Ordering::SeqCst);
    }
    if let Ok(mut caps) = state.capabilities.lock() {
        caps.clear();
    }
    if let Ok(mut stages) = state.staged.lock() {
        for stage in stages.values() {
            let _ = fs::remove_file(&stage.path);
        }
        stages.clear();
    }
    let _ = app.emit(
        "inspiration-vault-locked",
        json!({"generation":state.generation.load(Ordering::SeqCst)}),
    );
}
pub fn with_bundle<T>(
    app: &AppHandle,
    f: impl FnOnce(&Value) -> CommandResult<T>,
) -> CommandResult<T> {
    let owner = scope(app)?;
    let state = app.state::<PrivateState>();
    let mut session = state.unlocked.lock().map_err(|_| "vault_unavailable")?;
    let valid = session
        .as_ref()
        .is_some_and(|s| s.scope == owner && s.touched.elapsed() < IDLE);
    if !valid {
        return Err("vault_locked".into());
    }
    let session = session.as_mut().ok_or("vault_locked")?;
    f(&session.bundle.0)
}
pub fn root_key(bundle: &Value, epoch: u64) -> CommandResult<Zeroizing<Vec<u8>>> {
    crypto::decode(
        bundle["root_bundle"]["keys"][epoch.to_string()]
            .as_str()
            .ok_or("key_epoch_unavailable")?,
    )
}
pub fn epoch(bundle: &Value) -> CommandResult<u64> {
    bundle["root_bundle"]["key_epoch"]
        .as_u64()
        .ok_or("invalid_key_bundle".into())
}
pub fn view(app: &AppHandle, row: &Value, reveal: bool) -> CommandResult<Value> {
    if !protected(row) {
        return Ok(row.clone());
    }
    if !reveal || row["transition"].is_object() {
        return Ok(
            json!({"id":row["id"],"createdAt":row["createdAt"],"updatedAt":row["updatedAt"],"protection":"e2ee","locked":true,"text":"","tags":[],"version":row["version"],"aiContextEnabled":false,"transition":row["transition"],"historyCleanup":row["historyCleanup"]}),
        );
    }
    app.state::<PrivateState>()
        .sensitive_seen
        .store(true, Ordering::SeqCst);
    let payload = with_bundle(app, |bundle| {
        crypto::open_record(
            &root_key(bundle, row["key_epoch"].as_u64().ok_or("invalid_record")?)?,
            &scope(app)?,
            row,
        )
    })?;
    let mut result = payload.0.clone();
    if let Some(o) = result.as_object_mut() {
        o.remove("file_keys");
    }
    for field in ["images", "files"] {
        if let Some(items) = result[field].as_array_mut() {
            for item in items {
                if let Some(o) = item.as_object_mut() {
                    o.remove("key");
                }
            }
        }
    }
    if let Some(o) = result["audio"].as_object_mut() {
        o.remove("key");
    }
    for field in [
        "id",
        "createdAt",
        "updatedAt",
        "version",
        "protection",
        "historyCleanup",
    ] {
        result[field] = row[field].clone();
    }
    result["locked"] = json!(false);
    result["aiContextEnabled"] = json!(false);
    Ok(result)
}
pub fn list(app: &AppHandle) -> CommandResult<Vec<Value>> {
    crate::read_array(&index_path(app)?)?
        .iter()
        .filter(|r| r["deletedAt"].is_null())
        .map(|r| view(app, r, false))
        .collect()
}
pub fn read(app: &AppHandle, id: &str) -> CommandResult<Value> {
    let state = app.state::<PrivateState>();
    let generation = state.generation.load(Ordering::SeqCst);
    let result = view(app, &stored(app, id)?, true)?;
    if generation != state.generation.load(Ordering::SeqCst) {
        return Err("vault_locked".into());
    }
    Ok(result)
}

pub fn credential(app: &AppHandle, create: bool) -> CommandResult<Zeroizing<Vec<u8>>> {
    let owner = scope(app)?;
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, &owner).map_err(|_| "secure_keychain_unavailable")?;
    match entry.get_password() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            crypto::decode(&value)
        }
        Err(keyring::Error::NoEntry) if create => {
            let key = crypto::random_key()?;
            let value = Zeroizing::new(crypto::encode(&key));
            entry
                .set_password(&value)
                .map_err(|_| "secure_keychain_unavailable")?;
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => Err("device_secret_unavailable".into()),
        Err(_) => Err("secure_keychain_unavailable".into()),
    }
}
pub fn persist_bundle(app: &AppHandle, password: &str, bundle: &Value) -> CommandResult<()> {
    persist_bundle_at(app, password, bundle, &key_path(app)?)
}
pub fn persist_bundle_at(
    app: &AppHandle,
    password: &str,
    bundle: &Value,
    path: &Path,
) -> CommandResult<()> {
    if password.chars().count() < 12 || password.len() > 1024 {
        return Err("password_too_short".into());
    }
    let owner = bundle["device"]["account_scope"]
        .as_str()
        .ok_or("invalid_key_bundle")?
        .to_owned();
    if scope(app)? != owner {
        return Err("account_changed".into());
    }
    let device = credential(app, true)?;
    let mut salt = [0u8; 16];
    libsodium_rs::random::fill_bytes(&mut salt);
    let key = crypto::local_key(password.as_bytes(), &device, &salt, &owner)?;
    let bytes = Zeroizing::new(serde_json::to_vec(bundle).map_err(|_| "invalid_key_bundle")?);
    let envelope = crypto::seal(
        &key,
        &bytes,
        &crypto::aad("device-package", &owner, "", "", 1),
    )?;
    let confirmed_epoch = fs::read(key_path(app)?)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["recoveryConfirmedEpoch"].as_u64())
        .unwrap_or(0);
    let key_epoch = bundle["root_bundle"]["key_epoch"].as_u64().unwrap_or(0);
    let recovery_confirmed =
        bundle["require_recovery_confirmation"] != true || confirmed_epoch >= key_epoch;
    let value = json!({"recoveryConfirmed":recovery_confirmed,"recoveryConfirmedEpoch":if recovery_confirmed {key_epoch} else {confirmed_epoch},"format":1,"account_scope":owner,"paired":bundle["root_bundle"].is_object(),"device_id":bundle["device_id"],"salt":crypto::encode(&salt),"algorithm":"argon2id13","memory":268435456,"passes":3,"envelope":envelope});
    if scope(app)? != owner {
        return Err("account_changed".into());
    }
    crate::atomic_write(
        path,
        &serde_json::to_vec(&value).map_err(|_| "invalid_key_bundle")?,
    )
}
fn install_unlocked(
    state: &PrivateState,
    owner: String,
    bundle: Sensitive,
    expected_generation: u64,
) -> CommandResult<()> {
    let mut session = state.unlocked.lock().map_err(|_| "vault_unavailable")?;
    if state.generation.load(Ordering::SeqCst) != expected_generation {
        return Err("vault_locked".into());
    }
    *session = Some(Unlocked {
        scope: owner,
        bundle,
        touched: Instant::now(),
    });
    Ok(())
}
fn set_unlocked(app: &AppHandle, bundle: Value, expected_generation: u64) -> CommandResult<()> {
    let bundle = Sensitive(bundle);
    let owner = bundle.0["device"]["account_scope"]
        .as_str()
        .ok_or("invalid_key_bundle")?
        .to_owned();
    if scope(app)? != owner {
        return Err("account_changed".into());
    }
    install_unlocked(
        &app.state::<PrivateState>(),
        owner,
        bundle,
        expected_generation,
    )
}
#[tauri::command(async)]
pub fn inspiration_vault_status(app: AppHandle) -> CommandResult<Value> {
    let owner = scope(&app)?;
    let metadata = fs::read(key_path(&app)?)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let initialized = metadata.as_ref().is_some_and(|m| m["paired"] == true);
    let pairing = metadata.as_ref().is_some_and(|m| m["paired"] == false);
    let unlocked = with_bundle(&app, |_| Ok(true)).unwrap_or(false);
    Ok(
        json!({"accountScope":owner,"initialized":initialized,"pairing":pairing,"unlocked":unlocked,"generation":app.state::<PrivateState>().generation.load(Ordering::SeqCst),"recoveryConfirmed":metadata.as_ref().is_none_or(|m|m["recoveryConfirmed"]!=false),"deviceId":metadata.as_ref().map(|m|m["device_id"].clone()),"enabled":inspiration_cloud::read_binding(&app)?.is_some_and(|b|b.private_enabled)}),
    )
}
#[tauri::command(async)]
pub fn inspiration_vault_unlock(app: AppHandle, mut password: String) -> CommandResult<Value> {
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    let result = (|| {
        let state = app.state::<PrivateState>();
        let mut attempts = state.attempts.lock().map_err(|_| "vault_unavailable")?;
        if attempts.1.is_some_and(|until| Instant::now() < until) {
            return Err("unlock_rate_limited".into());
        }
        let raw: Value = serde_json::from_slice(
            &fs::read(key_path(&app)?).map_err(|_| "device_package_unavailable")?,
        )
        .map_err(|_| "invalid_key_bundle")?;
        let owner = scope(&app)?;
        if raw["account_scope"] != owner
            || raw["algorithm"] != "argon2id13"
            || raw["memory"] != 268435456u64
            || raw["passes"] != 3
        {
            return Err("invalid_key_bundle".into());
        }
        let device = credential(&app, false)?;
        let key = crypto::local_key(
            password.as_bytes(),
            &device,
            &crypto::decode(raw["salt"].as_str().ok_or("invalid_key_bundle")?)?,
            &owner,
        )?;
        let env: Envelope =
            serde_json::from_value(raw["envelope"].clone()).map_err(|_| "invalid_key_bundle")?;
        match crypto::open(
            &key,
            &env,
            &crypto::aad("device-package", &owner, "", "", 1),
        ) {
            Ok(bytes) => {
                let bundle = serde_json::from_slice(&bytes).map_err(|_| "invalid_key_bundle")?;
                set_unlocked(&app, bundle, generation)?;
                *attempts = (0, None);
                Ok(json!({"unlocked":true}))
            }
            Err(_) => {
                attempts.0 = attempts.0.saturating_add(1);
                attempts.1 = Some(Instant::now() + Duration::from_secs(1u64 << attempts.0.min(6)));
                Err("wrong_unlock_password".into())
            }
        }
    })();
    password.zeroize();
    result
}
#[tauri::command(async)]
pub fn inspiration_vault_confirm_recovery(app: AppHandle) -> CommandResult<()> {
    let epoch = with_bundle(&app, epoch)?;
    let path = key_path(&app)?;
    let mut metadata: Value =
        serde_json::from_slice(&fs::read(&path).map_err(|_| "device_package_unavailable")?)
            .map_err(|_| "invalid_key_bundle")?;
    if metadata["account_scope"] != scope(&app)? {
        return Err("account_changed".into());
    }
    metadata["recoveryConfirmed"] = json!(true);
    metadata["recoveryConfirmedEpoch"] = json!(epoch);
    crate::atomic_write(
        &path,
        &serde_json::to_vec(&metadata).map_err(|_| "invalid_key_bundle")?,
    )
}
#[tauri::command]
pub fn inspiration_vault_lock(app: AppHandle) {
    lock(&app)
}
#[tauri::command]
pub fn inspiration_vault_touch(app: AppHandle) -> CommandResult<()> {
    let owner = scope(&app)?;
    let state = app.state::<PrivateState>();
    let mut session = state.unlocked.lock().map_err(|_| "vault_unavailable")?;
    let session = session
        .as_mut()
        .filter(|session| session.scope == owner && session.touched.elapsed() < IDLE)
        .ok_or("vault_locked")?;
    session.touched = Instant::now();
    Ok(())
}
#[tauri::command(async)]
pub fn inspiration_private_read(app: AppHandle, id: String) -> CommandResult<Value> {
    read(&app, &id)
}
#[tauri::command(async)]
pub fn inspiration_vault_change_password(
    app: AppHandle,
    mut password: String,
) -> CommandResult<()> {
    let result = with_bundle(&app, |b| persist_bundle(&app, &password, b));
    password.zeroize();
    result
}

fn local_url(path: &str) -> String {
    let scheme = if cfg!(target_os = "windows") {
        "http://local-media.localhost/"
    } else {
        "local-media://localhost/"
    };
    format!(
        "{scheme}{}",
        percent_encoding::utf8_percent_encode(path, percent_encoding::NON_ALPHANUMERIC)
    )
}
pub fn stage_bytes(app: &AppHandle, bytes: &[u8], name: &str, mime: &str) -> CommandResult<Value> {
    stage_reader(app, &mut &bytes[..], name, mime)
}
fn stage_reader(
    app: &AppHandle,
    source: &mut impl Read,
    name: &str,
    mime: &str,
) -> CommandResult<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let owner = storage_scope(app)?;
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    let key = crypto::random_key()?;
    let path = crate::app_data_dir(app)?
        .join("private-staging")
        .join(format!("{id}.bin"));
    fs::create_dir_all(path.parent().ok_or("invalid_storage_root")?)
        .map_err(|_| "storage_unavailable")?;
    let mut created = CreatedAssets::new();
    created.paths.push(path.clone());
    let mut target = File::create(&path).map_err(|_| "storage_unavailable")?;
    let size = crypto::encrypt_file(
        source,
        &mut target,
        &key,
        &crypto::aad("staging", &owner, &id, "", 1),
    )?;
    target.sync_all().map_err(|_| "storage_unavailable")?;
    if generation
        != app
            .state::<PrivateState>()
            .generation
            .load(Ordering::SeqCst)
        || owner != storage_scope(app)?
    {
        let _ = fs::remove_file(&path);
        return Err("account_changed".into());
    }
    let state = app.state::<PrivateState>();
    let mut stages = state.staged.lock().map_err(|_| "staging_unavailable")?;
    if generation != state.generation.load(Ordering::SeqCst) || owner != storage_scope(app)? {
        return Err("account_changed".into());
    }
    stages.insert(
        id.clone(),
        Staged {
            scope: owner,
            generation,
            key,
            path: path.clone(),
            name: name.into(),
            mime: mime.into(),
        },
    );
    created.committed = true;
    Ok(
        json!({"path":format!("private-stage:{id}"),"url":local_url(&format!("private-stage:{id}")),"name":name,"size":size,"mime":mime}),
    )
}
#[tauri::command(async)]
pub fn inspiration_stage_file(app: AppHandle, path: String) -> CommandResult<Value> {
    let path = Path::new(&path);
    let size = fs::metadata(path)
        .map_err(|_| "attachment_unavailable")?
        .len();
    if size > crypto::MAX_FILE {
        return Err("attachment_too_large".into());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid_attachment_name")?;
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    let mut source = File::open(path).map_err(|_| "attachment_read_failed")?;
    stage_reader(&app, &mut source, name, &mime)
}

fn stage_plain(
    app: &AppHandle,
    source: &str,
) -> CommandResult<(Zeroizing<Vec<u8>>, String, String)> {
    if let Some(id) = source.strip_prefix("private-stage:") {
        let state = app.state::<PrivateState>();
        let stages = state.staged.lock().map_err(|_| "staging_unavailable")?;
        let stage = stages.get(id).ok_or("staged_attachment_expired")?;
        if stage.scope != storage_scope(app)?
            || stage.generation != state.generation.load(Ordering::SeqCst)
        {
            return Err("attachment_scope_mismatch".into());
        }
        let mut bytes = Zeroizing::new(Vec::new());
        crypto::decrypt_file(
            &mut RevocableReader::new(
                File::open(&stage.path).map_err(|_| "attachment_unavailable")?,
                &state.generation,
                stage.generation,
            ),
            &mut *bytes,
            &stage.key,
            &crypto::aad("staging", &stage.scope, id, "", 1),
        )?;
        if stage.generation != state.generation.load(Ordering::SeqCst) {
            return Err("staged_attachment_expired".into());
        }
        return Ok((bytes, stage.name.clone(), stage.mime.clone()));
    }
    // Native voice capture paths are restricted to the app's capture directory.
    let path = Path::new(source)
        .canonicalize()
        .map_err(|_| "attachment_unavailable")?;
    let root = crate::inspiration_staging_dir(app)?
        .canonicalize()
        .map_err(|_| "attachment_unavailable")?;
    if !path.starts_with(&root) {
        return Err("untrusted_attachment_path".into());
    }
    let bytes = Zeroizing::new(fs::read(&path).map_err(|_| "attachment_read_failed")?);
    if bytes.len() as u64 > crypto::MAX_FILE {
        return Err("attachment_too_large".into());
    }
    Ok((
        bytes,
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("attachment")
            .into(),
        mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string(),
    ))
}
fn payload(app: &AppHandle, row: &Value) -> CommandResult<Sensitive> {
    if row["protection"] == "e2ee" {
        with_bundle(app, |b| {
            crypto::open_record(
                &root_key(b, row["key_epoch"].as_u64().ok_or("invalid_record")?)?,
                &scope(app)?,
                row,
            )
        })
    } else {
        let mut content = row.clone();
        for key in ["_sync_op", "transition", "syncState", "serverRecord"] {
            content.as_object_mut().ok_or("invalid_record")?.remove(key);
        }
        Ok(Sensitive(content))
    }
}
pub fn save(app: &AppHandle, input: Value) -> CommandResult<Value> {
    let state = app.state::<PrivateState>();
    let _sync = state
        .sync
        .try_lock()
        .map_err(|_| "inspiration_operation_busy")?;
    let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
    let requested = input["id"].as_str();
    let id = requested
        .map(str::to_owned)
        .unwrap_or_else(|| format!("inspiration:{}", uuid::Uuid::new_v4()));
    uuid::Uuid::parse_str(
        id.strip_prefix("inspiration:")
            .ok_or("invalid_identifier")?,
    )
    .map_err(|_| "invalid_identifier")?;
    let old = if requested.is_some() {
        match stored(app, &id) {
            Ok(row) => Some(row),
            Err(error) if error == "inspiration_not_found" => None,
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    if old.as_ref().is_some_and(|r| r["transition"].is_object()) {
        return Err("protection_transition_pending".into());
    }
    let protection = input["protection"]
        .as_str()
        .or_else(|| old.as_ref().and_then(|r| r["protection"].as_str()))
        .unwrap_or("plain");
    if !["plain", "e2ee"].contains(&protection) {
        return Err("invalid_protection".into());
    }
    if old
        .as_ref()
        .is_some_and(|r| r["protection"].as_str().unwrap_or("plain") != protection)
    {
        return Err("use_protection_toggle".into());
    }
    if protection == "e2ee" {
        if !inspiration_cloud::read_binding(app)?.is_some_and(|binding| binding.private_enabled) {
            return Err("private_storage_unavailable".into());
        }
        let metadata: Value = serde_json::from_slice(
            &fs::read(key_path(app)?).map_err(|_| "device_package_unavailable")?,
        )
        .map_err(|_| "invalid_key_bundle")?;
        if metadata["recoveryConfirmed"] == false {
            return Err("recovery_confirmation_required".into());
        }
        if input["aiContextEnabled"] == true {
            return Err("encrypted_ai_forbidden".into());
        }
        if key_path(app)?.with_file_name("bootstrap.json").exists() {
            return Err("vault_cloud_initialization_pending".into());
        }
        with_bundle(app, |b| {
            if b["root_bundle"].is_null() {
                Err("pairing_not_approved".into())
            } else {
                Ok(())
            }
        })?;
    }
    let mut content = if let Some(r) = &old {
        payload(app, r)?
    } else {
        Sensitive(
            json!({"text":"","tags":[],"images":[],"files":[],"transcriptStatus":"none","aiContextEnabled":false}),
        )
    };
    for field in ["text", "tags", "sensitivity", "aiContextEnabled"] {
        if let Some(v) = input.get(field) {
            content.0[field] = v.clone();
        }
    }
    if content.0["text"].as_str().unwrap_or("").chars().count() > 20000 {
        return Err("text_too_long".into());
    }
    let directory = directory(app, &id)?;
    fs::create_dir_all(&directory).map_err(|_| "storage_unavailable")?;
    for (pending, field, kind, limit) in [
        ("pendingImages", "images", "image", 9),
        ("pendingFiles", "files", "file", 20),
    ] {
        let mut keep = content.0[field].as_array().cloned().unwrap_or_default();
        if let Some(ids) = input[field].as_array() {
            keep.retain(|i| ids.iter().any(|k| k["file"] == i["file"]));
        }
        for item in input[pending].as_array().into_iter().flatten() {
            let source = item["sourcePath"].as_str().ok_or("invalid_attachment")?;
            let (mut bytes, name, mime) = stage_plain(app, source)?;
            let asset = uuid::Uuid::new_v4().to_string();
            let path = directory.join(format!("{asset}.bin"));
            let mut metadata =
                json!({"file":asset,"name":name,"mime":mime,"size":bytes.len(),"kind":kind});
            for dimension in ["width", "height"] {
                if let Some(v) = item.get(dimension) {
                    metadata[dimension] = v.clone();
                }
            }
            if protection == "e2ee" {
                let key = crypto::random_key()?;
                let mut file = File::create(&path).map_err(|_| "attachment_write_failed")?;
                crypto::encrypt_file(
                    &mut bytes.as_slice(),
                    &mut file,
                    &key,
                    &crypto::aad("file", &scope(app)?, &id, &asset, 1),
                )?;
                file.sync_all().map_err(|_| "attachment_write_failed")?;
                metadata["key"] = json!(crypto::encode(&key));
            } else {
                crate::atomic_write(&path, &bytes)?;
            }
            bytes.zeroize();
            keep.push(metadata);
        }
        if keep.len() > limit {
            return Err("too_many_attachments".into());
        }
        content.0[field] = json!(keep);
    }
    if let Some(source) = input["pendingAudioPath"].as_str() {
        if protection == "e2ee" {
            return Err("encrypted_voice_capture_disabled".into());
        }
        let (bytes, _, _) = stage_plain(app, source)?;
        let asset = uuid::Uuid::new_v4().to_string();
        crate::atomic_write(&directory.join(format!("{asset}.bin")), &bytes)?;
        content.0["audio"] = json!({"file":asset,"name":"audio.wav","mime":"audio/wav","kind":"audio","size":bytes.len(),"durationMs":input["pendingAudioDurationMs"]});
    }
    let now = crate::now();
    let created = old
        .as_ref()
        .and_then(|r| r["createdAt"].as_str())
        .unwrap_or(&now);
    content.0["id"] = json!(id);
    content.0["createdAt"] = json!(created);
    content.0["updatedAt"] = json!(now);
    content.0["protection"] = json!(protection);
    let mut row = if protection == "e2ee" {
        content.0["aiContextEnabled"] = json!(false);
        let mut encrypted = with_bundle(app, |b| {
            crypto::seal_record(
                &root_key(b, epoch(b)?)?,
                &scope(app)?,
                &id,
                epoch(b)?,
                &content.0,
            )
        })?;
        encrypted["protection"] = json!("e2ee");
        encrypted["aiContextEnabled"] = json!(false);
        encrypted
    } else {
        content.0.clone()
    };
    row["id"] = json!(id);
    row["account_scope"] = json!(storage_scope(app)?);
    row["createdAt"] = json!(created);
    row["updatedAt"] = json!(now);
    row["version"] = old
        .as_ref()
        .map(|r| r["version"].clone())
        .unwrap_or(json!(0));
    row["syncState"] = json!("local");
    if old.as_ref().is_some_and(|r| r["legacyImported"] == true) {
        row["legacyImported"] = json!(true);
    }
    if let (Some(v), Some(previous)) = (input.get("version"), old.as_ref()) {
        if v != &previous["version"] {
            return Err("version_conflict".into());
        }
    }
    // Cleartext asset manifests never enter the encrypted row or its operation queue.
    row["media_ids"] = json!(asset_entries(&content.0)
        .iter()
        .filter_map(|a| a["file"].as_str())
        .collect::<Vec<_>>());
    put(app, &row)?;
    cloud::queue(app, &row)?;
    if protection == "plain" {
        crate::vault::sync_journal(app, &row)
    }
    prune_assets(app, &row, &content.0)?;
    if let Ok(mut stages) = state.staged.lock() {
        for field in ["pendingImages", "pendingFiles"] {
            for source in input[field]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["sourcePath"].as_str())
                .filter_map(|path| path.strip_prefix("private-stage:"))
            {
                if let Some(stage) = stages.remove(source) {
                    let _ = fs::remove_file(stage.path);
                }
            }
        }
    }
    view(app, &row, false)
}
pub fn asset_entries(content: &Value) -> Vec<Value> {
    let mut entries = Vec::new();
    for field in ["images", "files"] {
        entries.extend(content[field].as_array().cloned().unwrap_or_default())
    }
    if content["audio"].is_object() {
        entries.push(content["audio"].clone())
    }
    entries
}
fn prune_assets(app: &AppHandle, row: &Value, content: &Value) -> CommandResult<()> {
    let keep = asset_entries(content);
    let dir = directory(app, row["id"].as_str().ok_or("invalid_record")?)?;
    for file in fs::read_dir(dir)
        .map_err(|_| "attachment_read_failed")?
        .flatten()
    {
        let name = file.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".bin") {
            if uuid::Uuid::parse_str(id).is_ok() && !keep.iter().any(|a| a["file"] == id) {
                fs::remove_file(file.path()).map_err(|_| "attachment_cleanup_failed")?;
            }
        }
    }
    Ok(())
}
pub fn media_url(app: &AppHandle, id: &str, file: &str) -> CommandResult<Option<String>> {
    let state = app.state::<PrivateState>();
    let generation = state.generation.load(Ordering::SeqCst);
    let owner = storage_scope(app)?;
    let row = stored(app, id)?;
    if row["transition"].is_object() {
        return Err("protection_transition_pending".into());
    }
    let content = payload(app, &row)?;
    if !asset_entries(&content.0).iter().any(|a| a["file"] == file) {
        return Err("attachment_not_found".into());
    }
    if generation != state.generation.load(Ordering::SeqCst) || owner != storage_scope(app)? {
        return Err("read_capability_expired".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    state
        .capabilities
        .lock()
        .map_err(|_| "vault_unavailable")?
        .insert(
            token.clone(),
            Capability {
                scope: owner,
                id: id.into(),
                file: file.into(),
                generation,
            },
        );
    Ok(Some(local_url(&format!("private-cap:{token}"))))
}
pub fn media_bytes(app: &AppHandle, path: &str) -> CommandResult<(Zeroizing<Vec<u8>>, String)> {
    if let Some(id) = path.strip_prefix("private-stage:") {
        let (data, _, mime) = stage_plain(app, &format!("private-stage:{id}"))?;
        return Ok((data, mime));
    }
    let token = path
        .strip_prefix("private-cap:")
        .ok_or("invalid_read_capability")?;
    let state = app.state::<PrivateState>();
    let generation = state.generation.load(Ordering::SeqCst);
    let owner = storage_scope(app)?;
    let (id, file) = {
        let caps = state.capabilities.lock().map_err(|_| "vault_unavailable")?;
        let cap = caps.get(token).ok_or("read_capability_expired")?;
        if cap.scope != storage_scope(app)?
            || cap.generation != state.generation.load(Ordering::SeqCst)
        {
            return Err("read_capability_expired".into());
        }
        (cap.id.clone(), cap.file.clone())
    };
    let row = stored(app, &id)?;
    if row["transition"].is_object() {
        return Err("protection_transition_pending".into());
    }
    let content = payload(app, &row)?;
    let entries = asset_entries(&content.0);
    let asset = entries
        .iter()
        .find(|a| a["file"] == file)
        .ok_or("attachment_not_found")?;
    let path = directory(app, &id)?.join(format!("{file}.bin"));
    let mut bytes = Zeroizing::new(Vec::new());
    if row["protection"] == "e2ee" {
        crypto::decrypt_file(
            &mut RevocableReader::new(
                File::open(path).map_err(|_| "attachment_not_downloaded")?,
                &state.generation,
                generation,
            ),
            &mut *bytes,
            &crypto::decode(asset["key"].as_str().ok_or("invalid_file_key")?)?,
            &crypto::aad("file", &scope(app)?, &id, &file, 1),
        )?;
    } else {
        bytes.extend_from_slice(&fs::read(path).map_err(|_| "attachment_not_downloaded")?);
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("preview_too_large_use_export".into());
    }
    let mime = asset["mime"].as_str().unwrap_or("application/octet-stream");
    let safe = if [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "audio/wav",
        "audio/mpeg",
        "audio/mp4",
    ]
    .contains(&mime)
    {
        mime
    } else {
        "application/octet-stream"
    };
    if protected(&row)
        && state
            .capabilities
            .lock()
            .map_err(|_| "vault_unavailable")?
            .get(token)
            .is_none()
    {
        return Err("read_capability_expired".into());
    }
    if generation != state.generation.load(Ordering::SeqCst) || owner != storage_scope(app)? {
        return Err("read_capability_expired".into());
    }
    Ok((bytes, safe.into()))
}
#[tauri::command(async)]
pub fn inspiration_export_file(
    app: AppHandle,
    id: String,
    file: String,
    destination: String,
) -> CommandResult<()> {
    let state = app.state::<PrivateState>();
    let row = stored(&app, &id)?;
    if row["transition"].is_object() {
        return Err("protection_transition_pending".into());
    }
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    let content = payload(&app, &row)?;
    let entries = asset_entries(&content.0);
    let asset = entries
        .iter()
        .find(|a| a["file"] == file)
        .ok_or("attachment_not_found")?;
    let source = directory(&app, &id)?.join(format!("{file}.bin"));
    let target = PathBuf::from(destination);
    if !target.is_absolute() {
        return Err("invalid_export_path".into());
    }
    let temporary = target.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "export_failed")?;
        if protected(&row) {
            crypto::decrypt_file(
                &mut RevocableReader::new(
                    File::open(source).map_err(|_| "attachment_not_downloaded")?,
                    &state.generation,
                    generation,
                ),
                &mut out,
                &crypto::decode(asset["key"].as_str().ok_or("invalid_file_key")?)?,
                &crypto::aad("file", &scope(&app)?, &id, &file, 1),
            )?;
        } else {
            std::io::copy(
                &mut File::open(source).map_err(|_| "attachment_not_downloaded")?,
                &mut out,
            )
            .map_err(|_| "export_failed")?;
        }
        out.sync_all().map_err(|_| "export_failed")?;
        if protected(&row)
            && generation
                != app
                    .state::<PrivateState>()
                    .generation
                    .load(Ordering::SeqCst)
        {
            return Err("vault_locked".into());
        }
        fs::rename(&temporary, &target).map_err(|_| "export_failed".to_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub async fn bind(
    app: &AppHandle,
    base: &str,
    token: &str,
    backend: &str,
    _claimed_user: &str,
) -> CommandResult<Value> {
    let state = app.state::<PrivateState>();
    let epoch = state.binding_generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let _guard = state.serial.lock().map_err(|_| "session_unavailable")?;
        lock(app);
        let previous = inspiration_cloud::read_binding(app)?;
        use sha2::{Digest, Sha256};
        let fingerprint = format!("{:x}", Sha256::digest(token.as_bytes()));
        if !previous.as_ref().is_some_and(|b| {
            b.token_fingerprint == fingerprint
                && b.backend_host == backend
                && b.api_base.trim_end_matches('/') == base.trim_end_matches('/')
        }) {
            inspiration_cloud::clear_binding(app)?;
            *state.token.lock().map_err(|_| "session_unavailable")? = None;
            *state.transport.lock().map_err(|_| "session_unavailable")? = None;
        }
    }
    let base = reqwest::Url::parse(base).map_err(|_| "invalid_server_url")?;
    if base.scheme() != "https"
        && !(base.scheme() == "http" && matches!(base.host_str(), Some("localhost" | "127.0.0.1")))
    {
        return Err("invalid_server_url".into());
    }
    if !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("invalid_server_url".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "network_unavailable")?;
    let mut request = client
        .get(format!("{}/v2/me", base.as_str().trim_end_matches('/')))
        .bearer_auth(token);
    if !backend.is_empty() {
        request = request.header("X-Lynse-Backend-Host", backend)
    }
    let mut response = request.send().await.map_err(|_| "identity_unavailable")?;
    let mut v2 = true;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        v2 = false;
        let mut request = client
            .get(format!("{}/v1/me", base.as_str().trim_end_matches('/')))
            .bearer_auth(token);
        if !backend.is_empty() {
            request = request.header("X-Lynse-Backend-Host", backend)
        }
        response = request.send().await.map_err(|_| "identity_unavailable")?;
    }
    if !response.status().is_success() {
        return Err("identity_verification_failed".into());
    }
    let identity: Value = response
        .json()
        .await
        .map_err(|_| "identity_verification_failed")?;
    let user = identity["user_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("identity_verification_failed")?;
    let account_scope = if v2 {
        let value = identity["account_scope"]
            .as_str()
            .ok_or("invalid_account_scope")?;
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid_account_scope".into());
        }
        value.to_owned()
    } else {
        String::new()
    };
    let _guard = state.serial.lock().map_err(|_| "session_unavailable")?;
    if state.binding_generation.load(Ordering::SeqCst) != epoch {
        return Err("account_changed".into());
    }
    let binding = inspiration_cloud::AccountBinding {
        user_id: user.into(),
        api_base: base.as_str().trim_end_matches('/').into(),
        verified_at: crate::now(),
        token_fingerprint: {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(token.as_bytes()))
        },
        account_scope,
        backend_host: backend.into(),
        private_v2: v2,
        private_enabled: identity["private_enabled"].as_bool().unwrap_or(false),
    };
    inspiration_cloud::write_binding(app, &binding)?;
    *state.token.lock().map_err(|_| "session_unavailable")? = Some(Zeroizing::new(token.into()));
    lock(app);
    if v2 {
        cloud_status(app)
    } else {
        let mut status = inspiration_cloud::status_view(app)?;
        status["accountScope"] = json!(scope(app)?);
        Ok(status)
    }
}
pub fn cloud_status(app: &AppHandle) -> CommandResult<Value> {
    let binding = inspiration_cloud::read_binding(app)?.ok_or("verified_account_required")?;
    let pending = cloud::ops(app)?;
    let rows = crate::read_array(&index_path(app)?)?;
    let states: serde_json::Map<String, Value> = rows
        .iter()
        .filter_map(|r| Some((r["id"].as_str()?.to_owned(), r["syncState"].clone())))
        .collect();
    Ok(
        json!({"bound":true,"userId":binding.user_id,"accountScope":binding.account_scope,"privateEnabled":binding.private_enabled,"privateV2":binding.private_v2,"pendingOps":pending.len(),"conflicts":rows.iter().filter(|r|r["syncState"]=="conflict").count(),"recordStates":states}),
    )
}
pub fn delete(app: &AppHandle, id: &str) -> CommandResult<()> {
    let state = app.state::<PrivateState>();
    let _sync = state
        .sync
        .try_lock()
        .map_err(|_| "inspiration_operation_busy")?;
    let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
    let row = stored(app, id)?;
    let version = row["version"].as_u64().unwrap_or(0);
    let mut pending = cloud::ops(app)?;
    pending.retain(|o| o["id"] != id);
    if version > 0 {
        let mut body = json!({"base_version":version});
        if protected(&row) {
            body = cloud::sign_body(app, "delete", body)?;
        }
        pending.push(json!({"id":id,"kind":"delete","operation_id":uuid::Uuid::new_v4().to_string(),"body":body}));
    }
    crate::write_array(&index_path(app)?.with_file_name("ops.json"), &pending)?;
    let tombstone = json!({"id":id,"createdAt":row["createdAt"],"updatedAt":crate::now(),"deletedAt":crate::now(),"version":version,"protection":row["protection"],"account_scope":storage_scope(app)?});
    put(app, &tombstone)?;
    let dir = directory(app, id)?;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|_| "attachment_cleanup_failed")?;
    }
    crate::vault::remove_journal(app, id);
    Ok(())
}
pub fn has_session(app: &AppHandle) -> bool {
    app.try_state::<PrivateState>()
        .is_some_and(|state| state.unlocked.lock().map(|s| s.is_some()).unwrap_or(false))
}
pub fn has_unlocked(app: &AppHandle) -> bool {
    app.try_state::<PrivateState>().is_some_and(|s| {
        s.sensitive_seen.load(Ordering::SeqCst)
            || s.unlocked.lock().map(|s| s.is_some()).unwrap_or(false)
    })
}

pub fn source_is_protected(app: &AppHandle, source: &str) -> bool {
    let mut source = source;
    if let Some(raw) = source.strip_prefix("meeting:") {
        source = raw;
    }
    if !source.starts_with("inspiration:") {
        return false;
    }
    while let Some(raw) = source.strip_prefix("inspiration:") {
        source = raw;
    }
    if let Some((owner, _)) = source.rsplit_once(':') {
        if owner.len() == 64 && scope(app).ok().as_deref() != Some(owner) {
            return true;
        }
    }
    let source = source.rsplit(':').next().unwrap_or(source);
    stored(app, &format!("inspiration:{source}"))
        .map(|row| {
            protected(&row) || row["aiContextEnabled"] == false || row["deletedAt"].is_string()
        })
        .unwrap_or(true)
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn an_unlock_started_before_lock_cannot_restore_key_memory() {
        let state = PrivateState::default();
        let old = state.generation.load(Ordering::SeqCst);
        {
            let mut session = state.unlocked.lock().unwrap();
            state.generation.fetch_add(1, Ordering::SeqCst);
            *session = None;
        }
        assert!(install_unlocked(
            &state,
            "owner".into(),
            Sensitive(json!({"synthetic":"secret"})),
            old
        )
        .is_err());
        assert!(state.unlocked.lock().unwrap().is_none());
        assert!(install_unlocked(
            &state,
            "owner".into(),
            Sensitive(json!({"synthetic":"secret"})),
            old + 1
        )
        .is_ok());
    }
    #[test]
    fn lock_generation_cancels_stream_reads_without_retrying_forever() {
        let generation = AtomicU64::new(7);
        let mut reader = RevocableReader::new(&b"secret"[..], &generation, 7);
        let mut bytes = [0u8; 2];
        reader.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"se");
        generation.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            reader.read_exact(&mut bytes).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }
}
