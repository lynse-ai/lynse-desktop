mod markdown;
mod memory;
mod memory_cloud;
mod sources;
mod store;
mod sync;
pub mod wiki;
pub(crate) use store::SourceRef;

use crate::CommandResult;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
use store::{Document, Manifest};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone)]
pub(super) struct Session {
    pub scope: String,
    pub user_id: String,
    pub base_url: String,
    pub agent_url: String,
    pub model_override: Option<Value>,
    pub token: String,
    pub generation: u64,
    pub locale: String,
}

#[derive(Default)]
pub struct WorkbenchState {
    pub(super) session: Mutex<Option<Session>>,
    pub(super) worker: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub(super) serial: tokio::sync::Mutex<()>,
    sync_requested: tokio::sync::Notify,
    refresh_existing: AtomicBool,
    discovery_requested: tokio::sync::Notify,
    epoch: AtomicU64,
    beta_enabled: AtomicBool,
    gmail_plugin_enabled: AtomicBool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindRequest {
    base_url: String,
    agent_url: Option<String>,
    token: String,
    #[serde(default)]
    locale: String,
    model_override: Option<Value>,
    #[serde(default)]
    beta_enabled: bool,
    #[serde(default)]
    gmail_plugin_enabled: bool,
}

pub(super) fn state_path(app: &AppHandle, session: &Session) -> CommandResult<PathBuf> {
    Ok(crate::app_data_dir(app)?
        .join("workbench")
        .join(&session.scope)
        .join("state.json"))
}
pub(super) fn roots(app: &AppHandle, session: &Session) -> CommandResult<(PathBuf, PathBuf)> {
    let root =
        crate::vault::vault_user_dir(app)?.ok_or("Knowledge-base folder is not configured")?;
    Ok((
        root.join("Meetings").join(&session.scope),
        root.join("Memory").join(&session.scope),
    ))
}
pub(super) fn load_state(app: &AppHandle, session: &Session) -> CommandResult<Manifest> {
    let mut state = store::load(&state_path(app, session)?)?;
    let vault = crate::vault::load_vault_config(app)?;
    let expected_root = roots(app, session)
        .ok()
        .map(|(root, _)| root.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !state.bootstrap_valid(&expected_root) {
        state.initial_complete = false;
    }
    if !vault.enabled
        || !app
            .state::<WorkbenchState>()
            .beta_enabled
            .load(Ordering::SeqCst)
    {
        state.enabled = false;
        state.phase = "disabled".into();
    }
    if let Ok((_, memory)) = roots(app, session) {
        let path = memory.join("derived.json");
        if path.exists() {
            let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|_| "Local memory is unreadable; its file was preserved")?;
            state.memories =
                serde_json::from_value(value["memories"].clone()).map_err(|e| e.to_string())?;
            state.artifacts =
                serde_json::from_value(value["artifacts"].clone()).map_err(|e| e.to_string())?;
        }
    }
    let gmail = sources::config(app, session)?;
    let plugin = app
        .state::<WorkbenchState>()
        .gmail_plugin_enabled
        .load(Ordering::SeqCst);
    for entry in state
        .entries
        .values_mut()
        .filter(|entry| entry.kind == "gmail")
    {
        entry.excluded =
            !gmail.allows(&entry.id, plugin) || state.excluded_sources.contains(&entry.id);
    }
    // Check the current local consent at read time, including while a native
    // background request is in flight. Stored knowledge-base text is retained.
    for (directory, prefix) in [
        ("local-transcriptions", ""),
        ("local-inspirations", "inspiration:"),
        ("local-todos", "task:"),
    ] {
        let rows = crate::list_store(app, directory)?;
        let ids: Vec<String> = state
            .entries
            .values()
            .filter(|entry| {
                if prefix.is_empty() {
                    entry.id.starts_with("local:")
                } else {
                    entry.id.starts_with(prefix)
                }
            })
            .map(|entry| entry.id.clone())
            .collect();
        for id in ids {
            let raw = id.strip_prefix(prefix).unwrap_or(&id);
            let row = rows.iter().find(|row| row["id"].as_str() == Some(raw));
            let allowed = row.is_some_and(|row| {
                row.get("aiContextEnabled").and_then(Value::as_bool) != Some(false)
                    && !matches!(
                        row["sensitivity"].as_str(),
                        Some("private" | "sensitive" | "restricted")
                    )
                    && row["workbenchScope"]
                        .as_str()
                        .is_none_or(|owner| owner == session.scope)
            });
            let excluded = !allowed || state.excluded_sources.contains(&id);
            if let Some(entry) = state.entries.get_mut(&id) {
                entry.excluded = excluded;
            }
            if excluded {
                sync::forget_source(&mut state, &id);
            }
        }
    }
    Ok(state)
}
pub(crate) fn is_beta_active(app: &AppHandle) -> bool {
    app.try_state::<WorkbenchState>()
        .is_some_and(|state| state.beta_enabled.load(Ordering::SeqCst))
}
pub(crate) fn refresh_local_policy(app: &AppHandle) {
    if app.try_state::<WorkbenchState>().is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<WorkbenchState>() else {
            return;
        };
        let _guard = state.serial.lock().await;
        let Ok(session) = current(&state) else {
            return;
        };
        if let Ok(manifest) = load_state(&app, &session) {
            if manifest.enabled {
                let _ = persist(&app, &session, &manifest);
            }
        }
    });
}
pub(super) fn persist(app: &AppHandle, session: &Session, state: &Manifest) -> CommandResult<()> {
    let mut manifest = state.clone();
    manifest.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    manifest.memories.clear();
    manifest.artifacts.clear();
    if let Ok((_, memory)) = roots(app, session) {
        fs::create_dir_all(&memory).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(
            &json!({"memories":state.memories,"artifacts":state.artifacts}),
        )
        .map_err(|e| e.to_string())?;
        if fs::read(memory.join("derived.json")).ok().as_deref() != Some(bytes.as_slice()) {
            crate::atomic_write(&memory.join("derived.json"), &bytes)?;
            store::write_memory_views(&memory, state)?;
        }
    }
    store::save(&state_path(app, session)?, &manifest)?;
    let mut published = state.clone();
    published.updated_at = manifest.updated_at.clone();
    let _ = app.emit("workbench-updated", public_status(session, &published));
    Ok(())
}
pub(super) fn current(state: &WorkbenchState) -> CommandResult<Session> {
    state
        .session
        .lock()
        .map_err(|_| "Workbench session unavailable")?
        .clone()
        .ok_or_else(|| "Sign in to access this account's knowledge base".into())
}
pub(crate) fn current_scope(app: &AppHandle) -> Option<String> {
    let state = app.try_state::<WorkbenchState>()?;
    current(&state).ok().map(|session| session.scope)
}
pub(super) fn is_current(state: &WorkbenchState, session: &Session) -> bool {
    state.epoch.load(Ordering::SeqCst) == session.generation
        && state
            .session
            .lock()
            .ok()
            .and_then(|s| s.clone())
            .is_some_and(|s| s.scope == session.scope && s.generation == session.generation)
}
pub(super) fn require_current(state: &WorkbenchState, session: &Session) -> CommandResult<()> {
    if is_current(state, session) {
        Ok(())
    } else {
        Err("Account or consent changed; result discarded".into())
    }
}
fn public_status(session: &Session, state: &Manifest) -> Value {
    let entries: Vec<&store::Entry> = state.entries.values().collect();
    let meetings: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == "meeting")
        .collect();
    json!({"scope":session.scope,"userId":session.user_id,"enabled":state.enabled,"allowAi":state.allow_ai,
        "initialComplete":state.initial_complete,"phase":state.phase,"updatedAt":state.updated_at,"error":state.error,"wikiProgress":state.wiki_progress,
        "discovered":meetings.len(),"synced":meetings.iter().filter(|e|e.status=="synced").count(),
        "awaitingTranscription":meetings.iter().filter(|e|e.status=="awaiting_transcription").count(),
        "failed":meetings.iter().filter(|e|e.status=="failed").count(),"conflicts":meetings.iter().filter(|e|e.status=="conflict").count(),
        "entries":entries,"memories":if state.enabled {state.memories.clone()}else{vec![]}})
}

pub(super) fn require_beta(state: &WorkbenchState) -> CommandResult<()> {
    if state.beta_enabled.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err("Wiki is available only in test mode".into())
    }
}
pub(super) fn invalidate_runtime(state: &WorkbenchState) -> CommandResult<Session> {
    state.refresh_existing.store(false, Ordering::SeqCst);
    let generation = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(worker) = state
        .worker
        .lock()
        .map_err(|_| "Worker unavailable")?
        .take()
    {
        worker.abort();
    }
    let mut bound = state.session.lock().map_err(|_| "Session unavailable")?;
    let session = bound.as_mut().ok_or("Sign in first")?;
    session.generation = generation;
    Ok(session.clone())
}

pub(crate) async fn save_vault_config(
    app: &AppHandle,
    config: crate::vault::VaultConfig,
) -> CommandResult<crate::vault::VaultConfig> {
    let state = app.state::<WorkbenchState>();
    // Cancel requests before waiting for disk operations. Their generation can no longer commit.
    let cancelled = invalidate_runtime(&state).ok();
    let _guard = state.serial.lock().await;
    if let Some(ref session) = cancelled {
        require_current(&state, session)?;
    }
    let session = current(&state).ok();
    if let Some(ref session) = session {
        let mut manifest = load_state(app, session)?;
        manifest.initial_complete = false;
        manifest.completed_round.clear();
        manifest.phase = "pending".into();
        persist(app, session, &manifest)?;
    }
    // A disabled vault permanently turns off Wiki for every account, even offline ones.
    let registry = crate::app_data_dir(app)?.join("workbench");
    let previous = crate::vault::load_vault_config(app)?;
    if !config.enabled || !previous.enabled {
        for entry in if registry.exists() {
            Some(fs::read_dir(registry).map_err(|e| e.to_string())?)
        } else {
            None
        }
        .into_iter()
        .flatten()
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().join("state.json");
            if path.is_file() {
                let mut manifest = store::load(&path)?;
                manifest.enabled = false;
                manifest.initial_complete = false;
                manifest.completed_round.clear();
                manifest.phase = "disabled".into();
                store::save(&path, &manifest)?;
            }
        }
    }
    let result = crate::vault::save_config_inner(app, config.clone());
    if let Some(session) = session {
        let mut manifest = load_state(app, &session)?;
        manifest.initial_complete = false;
        manifest.completed_round.clear();
        if result.is_err() {
            manifest.phase = "failed".into();
            manifest.error =
                "Folder configuration failed; processing is paused. Retry the folder change."
                    .into();
        } else {
            manifest.phase = if manifest.enabled {
                "pending"
            } else {
                "disabled"
            }
            .into();
            manifest.error.clear();
        }
        persist(app, &session, &manifest)?;
        if result.is_ok() && config.enabled {
            start_worker(app, &state);
        }
    }
    result
}

fn normalize_url(raw: &str) -> CommandResult<String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "Invalid server URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid server URL".into());
    }
    Ok(raw.trim().trim_end_matches('/').to_owned())
}

#[tauri::command]
pub async fn workbench_bind(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    request: BindRequest,
) -> CommandResult<Value> {
    let base = normalize_url(&request.base_url)?;
    let agent = normalize_url(request.agent_url.as_deref().unwrap_or(&base))?;
    if request.token.trim().is_empty() {
        return Err("Sign in first".into());
    }
    // Invalidate the previous account before starting identity verification.
    let generation = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(worker) = state
        .worker
        .lock()
        .map_err(|_| "Worker unavailable")?
        .take()
    {
        worker.abort();
    }
    *state.session.lock().map_err(|_| "Session unavailable")? = None;
    state
        .beta_enabled
        .store(request.beta_enabled, Ordering::SeqCst);
    state
        .gmail_plugin_enabled
        .store(request.gmail_plugin_enabled, Ordering::SeqCst);
    let identity_key = store::digest(format!("{}\n{}", base, request.token));
    let identity_path = crate::app_data_dir(&app)?
        .join("workbench")
        .join("identities")
        .join(format!("{identity_key}.json"));
    let verification = sync::verify_identity(&base, &request.token).await;
    let user_id = match verification {
        Ok(id) => {
            if let Some(parent) = identity_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            crate::atomic_write(
                &identity_path,
                &serde_json::to_vec(&json!({"userId":id})).map_err(|e| e.to_string())?,
            )?;
            id
        }
        Err(error) if error.starts_with("Network unavailable") => {
            let cached: Value =
                serde_json::from_slice(&fs::read(&identity_path).map_err(|_| {
                    "Connect once to verify this account before using its offline knowledge base"
                })?)
                .map_err(|_| "Invalid cached identity")?;
            cached["userId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Invalid cached identity")?
                .to_owned()
        }
        Err(error) => return Err(error),
    };
    let _guard = state.serial.lock().await;
    if state.epoch.load(Ordering::SeqCst) != generation {
        return Err("Account changed".into());
    }
    let session = Session {
        scope: store::digest(format!("{base}\n{user_id}")),
        user_id,
        base_url: base,
        agent_url: agent,
        model_override: request.model_override,
        token: request.token,
        generation,
        locale: request.locale,
    };
    let mut manifest = load_state(&app, &session)?;
    for entry in manifest.entries.values_mut() {
        entry.failed_download_revision.clear();
    }
    *state.session.lock().map_err(|_| "Session unavailable")? = Some(session.clone());
    persist(&app, &session, &manifest)?;
    let status = public_status(&session, &manifest);
    if crate::vault::load_vault_config(&app)?.enabled {
        start_worker(&app, &state);
    }
    Ok(status)
}

#[tauri::command]
pub async fn workbench_unbind(state: State<'_, WorkbenchState>) -> CommandResult<()> {
    state.refresh_existing.store(false, Ordering::SeqCst);
    state.beta_enabled.store(false, Ordering::SeqCst);
    state.gmail_plugin_enabled.store(false, Ordering::SeqCst);
    state.epoch.fetch_add(1, Ordering::SeqCst);
    if let Some(worker) = state
        .worker
        .lock()
        .map_err(|_| "Worker unavailable")?
        .take()
    {
        worker.abort();
    }
    let _guard = state.serial.lock().await;
    *state.session.lock().map_err(|_| "Session unavailable")? = None;
    Ok(())
}

#[tauri::command]
pub async fn workbench_status(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
) -> CommandResult<Value> {
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    Ok(public_status(&session, &load_state(&app, &session)?))
}

pub(super) fn start_worker(app: &AppHandle, state: &WorkbenchState) {
    let Ok(mut worker) = state.worker.lock() else {
        return;
    };
    if worker.is_some() {
        return;
    }
    let app = app.clone();
    *worker = Some(tauri::async_runtime::spawn(async move {
        let sync_loop = async {
            loop {
                let state = app.state::<WorkbenchState>();
                let Ok(session) = current(&state) else {
                    return;
                };
                if let Err(error) = sync::run(&app, &state, &session).await {
                    let _guard = state.serial.lock().await;
                    if is_current(&state, &session) {
                        if let Ok(mut manifest) = load_state(&app, &session) {
                            manifest.phase = "failed".into();
                            manifest.error = error;
                            let _ = persist(&app, &session, &manifest);
                            let _ =
                                app.emit("workbench-updated", public_status(&session, &manifest));
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(120)) => {}
                    _ = state.sync_requested.notified() => {}
                }
                if !is_current(&state, &session) {
                    return;
                }
                if !crate::vault::load_vault_config(&app)
                    .map(|c| c.enabled)
                    .unwrap_or(false)
                {
                    return;
                }
            }
        };
        // Discovery runs alongside Wiki compilation without blocking the source worker.
        // Both futures belong to this worker and are cancelled together on scope changes.
        let discovery_loop = async {
            loop {
                let state = app.state::<WorkbenchState>();
                let Ok(session) = current(&state) else {
                    return;
                };
                let more = match wiki::discover(&app, &state, &session).await {
                    Ok(more) => more,
                    Err(error) => {
                        log::warn!("Wiki discovery paused: {error}");
                        false
                    }
                };
                if more {
                    tokio::task::yield_now().await;
                } else {
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(120)) => {}
                        _ = state.discovery_requested.notified() => {}
                    }
                }
                if !is_current(&state, &session)
                    || !crate::vault::load_vault_config(&app)
                        .map(|c| c.enabled)
                        .unwrap_or(false)
                {
                    return;
                }
            }
        };
        tokio::select! {
            _ = sync_loop => {}
            _ = discovery_loop => {}
        }
    }));
}

#[tauri::command]
pub async fn workbench_configure(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    enabled: bool,
    allow_ai: bool,
) -> CommandResult<Value> {
    if enabled {
        require_beta(&state)?;
    }
    let _guard = state.serial.lock().await;
    let mut session = current(&state)?;
    state.epoch.fetch_add(1, Ordering::SeqCst);
    session.generation = state.epoch.load(Ordering::SeqCst);
    if let Some(worker) = state
        .worker
        .lock()
        .map_err(|_| "Worker unavailable")?
        .take()
    {
        worker.abort();
    }
    *state.session.lock().map_err(|_| "Session unavailable")? = Some(session.clone());
    if enabled {
        let mut config = crate::vault::load_vault_config(&app)?;
        if !config.enabled {
            if config.path.as_deref().unwrap_or_default().is_empty() {
                config.path = Some(crate::vault::vault_default_path(app.clone())?);
            }
            config.enabled = true;
            crate::vault::save_config_inner(&app, config)?;
        }
    }
    let mut manifest = load_state(&app, &session)?;
    manifest.enabled = enabled;
    manifest.initial_complete = false;
    manifest.completed_round.clear();
    manifest.allow_ai = allow_ai;
    manifest.wiki_progress = None;
    manifest.phase = if enabled { "pending" } else { "disabled" }.into();
    manifest.error.clear();
    persist(&app, &session, &manifest)?;
    if enabled {
        wiki::backup_legacy(&app, &session)?;
    }
    if crate::vault::load_vault_config(&app)?.enabled {
        start_worker(&app, &state);
    }
    Ok(public_status(&session, &manifest))
}

#[tauri::command]
pub async fn workbench_sync(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    retry_failed: Option<bool>,
    refresh_existing: Option<bool>,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    if retry_failed == Some(false) {
        current(&state)?;
        if !crate::vault::load_vault_config(&app)?.enabled {
            return Err("Local knowledge-base sync is disabled".into());
        }
        start_worker(&app, &state);
        state.sync_requested.notify_one();
        return Ok(());
    }
    let session = invalidate_runtime(&state)?;
    let mut manifest = load_state(&app, &session)?;
    if !crate::vault::load_vault_config(&app)?.enabled {
        return Err("Local knowledge-base sync is disabled".into());
    }
    state
        .refresh_existing
        .store(refresh_existing.unwrap_or(false), Ordering::SeqCst);
    if retry_failed.unwrap_or(true) {
        for entry in manifest.entries.values_mut() {
            entry.failed_synthesis_revision.clear();
            entry.failed_download_revision.clear();
        }
    }
    persist(&app, &session, &manifest)?;
    if let Some(worker) = state
        .worker
        .lock()
        .map_err(|_| "Worker unavailable")?
        .take()
    {
        worker.abort();
    }
    start_worker(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn workbench_search(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    query: String,
    ai_only: Option<bool>,
) -> CommandResult<Value> {
    let session = current(&state)?;
    let (mut items, complete, semantic) = {
        let _guard = state.serial.lock().await;
        require_current(&state, &session)?;
        let manifest = load_state(&app, &session)?;
        if ai_only.unwrap_or(false) && wiki::ready(&manifest).is_err() {
            return Ok(json!({"items":[],"initialComplete":false}));
        }
        let (root, _) = roots(&app, &session)?;
        (
            if ai_only.unwrap_or(false) {
                store::search(&root, &manifest, &query, 30)
            } else {
                store::browse(&root, &manifest, &query, 100)
            },
            manifest.initial_complete,
            wiki::ready(&manifest).is_ok(),
        )
    };
    if semantic {
        if let Ok(matches) = wiki::semantic_search(&app, &state, &session, &query).await {
            for row in matches {
                if !items.iter().any(|r| r["id"] == row["id"]) {
                    items.push(row);
                }
            }
        }
    }
    require_current(&state, &session)?;
    Ok(json!({"items":items,"initialComplete":complete}))
}

#[tauri::command]
pub async fn workbench_read(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    id: String,
) -> CommandResult<Value> {
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    if id.starts_with("wiki:") {
        require_beta(&state)?;
        return wiki::read_page(&app, &session, &id);
    }

    let manifest = load_state(&app, &session)?;
    let actual = manifest.aliases.get(&id).unwrap_or(&id);
    let entry = manifest
        .entries
        .get(actual)
        .ok_or("Meeting is not in this account's knowledge base")?;
    let (root, _) = roots(&app, &session)?;
    let (markdown, source) = store::paths(&root, actual);
    let document = if entry.status == "conflict" {
        serde_json::from_slice::<Document>(&fs::read(source).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        store::read_document(&root, entry)?
    };
    Ok(
        json!({"document":document,"markdown":fs::read_to_string(markdown).map_err(|e|e.to_string())?,
        "artifacts":if manifest.enabled {manifest.artifacts.get(actual).cloned().unwrap_or(Value::Null)}else{Value::Null}}),
    )
}

#[tauri::command]
pub async fn workbench_review(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    query: String,
) -> CommandResult<Value> {
    let session = current(&state)?;
    let documents = {
        let _guard = state.serial.lock().await;
        let manifest = load_state(&app, &session)?;
        if !manifest.enabled || !manifest.allow_ai || !manifest.initial_complete {
            return Err("Finish knowledge-base sync and enable AI processing first".into());
        }
        let (root, _) = roots(&app, &session)?;
        let mut documents = store::search(&root, &manifest, &query, 18)
            .iter()
            .filter_map(|row| manifest.entries.get(row["id"].as_str()?))
            .filter_map(|entry| store::read_document(&root, entry).ok())
            .collect::<Vec<_>>();
        // Only reviewed Wiki pages join automatic context; legacy memory remains editable.
        for document in &mut documents {
            document.transcript = store::evidence_excerpt(&document.text(), &query, 12_000);
            document.outline.clear();
            document.conclusions.clear();
            document.todos.clear();
            document.segments.retain(|segment| {
                document
                    .transcript
                    .contains(segment["text"].as_str().unwrap_or_default())
            });
        }
        documents
    };
    if documents.is_empty() {
        return Ok(
            json!({"summary":"","memoryItems":[],"todoSuggestions":[],"citations":[],"insufficientEvidence":true}),
        );
    }
    let result =
        wiki::synthesize(&app, &session, "project_review", &documents, Some(&query)).await?;
    let _guard = state.serial.lock().await;
    require_current(&state, &session)?;
    let manifest = load_state(&app, &session)?;
    let (root, _) = roots(&app, &session)?;
    if documents
        .iter()
        .any(|document| !store::is_current_document(&root, &manifest, document))
    {
        return Err("Sources changed; prepare the brief again".into());
    }
    sync::validate_result(&documents, &manifest, &result)?;
    Ok(result)
}

#[tauri::command]
pub async fn workbench_exclude(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    id: String,
    excluded: bool,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    let mut manifest = load_state(&app, &session)?;
    let entry = manifest.entries.get_mut(&id).ok_or("Source not found")?;
    entry.excluded = excluded;
    entry.synthesis_revision.clear();
    manifest.excluded_sources.retain(|source| source != &id);
    if excluded {
        manifest.excluded_sources.push(id.clone());
    }
    if excluded {
        sync::forget_source(&mut manifest, &id);
    }
    persist(&app, &session, &manifest)
}

#[tauri::command]
pub async fn workbench_memory_edit(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    id: String,
    text: String,
    pinned: bool,
    excluded: bool,
) -> CommandResult<()> {
    if text.trim().is_empty() || text.chars().count() > 4000 {
        return Err("Memory text must contain 1–4000 characters".into());
    }
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    let mut manifest = load_state(&app, &session)?;
    if !manifest.enabled {
        return Err("Meeting memory is disabled".into());
    }
    let item = manifest
        .memories
        .iter_mut()
        .find(|m| m["id"] == id)
        .ok_or("Memory not found")?;
    item["text"] = json!(text.trim());
    item["pinned"] = json!(pinned);
    item["excluded"] = json!(excluded);
    item["userEdited"] = json!(true);
    item["updatedAt"] = json!(crate::now());
    persist(&app, &session, &manifest)
}

#[tauri::command]
pub async fn workbench_memory_files(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    request: memory::MemoryRequest,
    scope: String,
) -> CommandResult<Value> {
    require_beta(&state)?;
    let session = current(&state)?;
    if session.scope != scope { return Err("Account changed; reopen memory files".into()); }
    memory_cloud::handle(&app, &session, request).await
}

#[tauri::command]
pub async fn workbench_summary_save(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    id: String,
    summary_id: String,
    markdown: String,
) -> CommandResult<()> {
    if markdown.chars().count() > 100_000 {
        return Err("Summary is too long".into());
    }
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    let mut manifest = load_state(&app, &session)?;
    if !manifest.enabled {
        return Err("Meeting workbench is disabled".into());
    }
    let summary = manifest
        .artifacts
        .get_mut(&id)
        .and_then(|a| a["summaries"].as_array_mut())
        .and_then(|items| items.iter_mut().find(|s| s["id"] == summary_id))
        .ok_or("Summary version not found")?;
    summary["markdown"] = json!(markdown);
    summary["userEdited"] = json!(true);
    persist(&app, &session, &manifest)
}

#[tauri::command]
pub async fn workbench_regenerate(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    id: String,
) -> CommandResult<()> {
    let session = current(&state)?;
    let document = {
        let _guard = state.serial.lock().await;
        let manifest = load_state(&app, &session)?;
        wiki::ready(&manifest)?;
        let entry = manifest
            .entries
            .get(&id)
            .filter(|e| store::eligible(e))
            .ok_or("Meeting is excluded or unavailable")?;
        store::read_document(&roots(&app, &session)?.0, entry)?
    };
    let result =
        wiki::synthesize(&app, &session, "meeting_summary", &[document.clone()], None).await?;
    let _guard = state.serial.lock().await;
    require_current(&state, &session)?;
    let mut manifest = load_state(&app, &session)?;
    wiki::ready(&manifest)?;
    if !store::is_current_document(&roots(&app, &session)?.0, &manifest, &document) {
        return Err("Source changed; retry the summary".into());
    }
    sync::validate_result(&[document.clone()], &manifest, &result)?;
    let artifact = manifest
        .artifacts
        .entry(document.id)
        .or_insert_with(|| json!({"summaries":[],"todoSuggestions":[]}));
    artifact["summaries"].as_array_mut().ok_or("Invalid summaries")?.push(json!({"id":uuid::Uuid::new_v4().to_string(),"markdown":result["summary"],"createdAt":crate::now(),"sourceRevision":document.revision}));
    persist(&app, &session, &manifest)
}

#[tauri::command]
pub async fn workbench_remove_source(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    id: String,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    let mut manifest = load_state(&app, &session)?;
    let actual = manifest.aliases.get(&id).cloned().unwrap_or(id);
    if !manifest.entries.contains_key(&actual) {
        return Ok(());
    }
    if let Some(entry) = manifest.entries.get_mut(&actual) {
        entry.excluded = true;
        entry.status = "deleted".into();
    }
    sync::forget_source(&mut manifest, &actual);
    persist(&app, &session, &manifest)?;
    let (root, _) = roots(&app, &session)?;
    let (md, source) = store::paths(&root, &actual);
    for path in [md, source] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    manifest.entries.remove(&actual);
    persist(&app, &session, &manifest)
}

#[tauri::command]
pub async fn workbench_resolve_conflict(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    id: String,
    keep_local: bool,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    let mut manifest = load_state(&app, &session)?;
    let entry = manifest
        .entries
        .get(&id)
        .cloned()
        .filter(|e| e.status == "conflict")
        .ok_or("No conflict for this meeting")?;
    let (root, _) = roots(&app, &session)?;
    let (md, source) = store::paths(&root, &id);
    let incoming = source.with_extension("incoming.json");
    let mut document: Document =
        serde_json::from_slice(&fs::read(&incoming).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let local = fs::read(&md).map_err(|e| e.to_string())?;
    crate::atomic_write(&md.with_extension("local-backup.md"), &local)?;
    let mut next = if keep_local {
        let accepted_revision = document.revision.clone();
        document.transcript =
            String::from_utf8(local.clone()).map_err(|_| "Local document must be UTF-8")?;
        document.segments.clear();
        document.outline.clear();
        document.conclusions.clear();
        document.refresh_revision();
        crate::atomic_write(
            &source,
            &serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?,
        )?;
        store::Entry {
            revision: document.revision.clone(),
            accepted_revision,
            markdown_hash: store::digest(&local),
            status: "synced".into(),
            synthesis_revision: String::new(),
            failed_synthesis_revision: String::new(),
            ..entry
        }
    } else {
        store::write_document(&root, &document, None)?
    };
    next.excluded = manifest.excluded_sources.contains(&id)
        || manifest.entries.get(&id).is_some_and(|e| e.excluded);
    next.remote_revision = manifest
        .entries
        .get(&id)
        .map(|e| e.remote_revision.clone())
        .unwrap_or_default();
    manifest.entries.insert(id, next);
    manifest.initial_complete = !manifest
        .entries
        .values()
        .any(|e| matches!(e.status.as_str(), "failed" | "pending" | "conflict"));
    persist(&app, &session, &manifest)?;
    let _ = fs::remove_file(incoming);
    let _ = fs::remove_file(md.with_extension("incoming.md"));
    Ok(())
}

#[tauri::command]
pub async fn workbench_clear(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    let mut session = current(&state)?;
    session.generation = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *state.session.lock().map_err(|_| "Session unavailable")? = Some(session.clone());
    if let Some(worker) = state
        .worker
        .lock()
        .map_err(|_| "Worker unavailable")?
        .take()
    {
        worker.abort();
    }
    let mut manifest = load_state(&app, &session)?;
    manifest.enabled = false;
    manifest.phase = "disabled".into();
    manifest.memories.clear();
    manifest.artifacts.clear();
    for entry in manifest.entries.values_mut() {
        entry.synthesis_revision.clear();
    }
    let (documents, memory) = roots(&app, &session)?;
    let _ = fs::remove_file(documents.join(".search-index.json"));
    if memory.exists() {
        fs::remove_dir_all(memory).map_err(|e| e.to_string())?;
    }
    persist(&app, &session, &manifest)
}

#[tauri::command]
pub async fn workbench_confirm_todos(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    id: String,
    suggestions: Vec<Value>,
) -> CommandResult<Vec<Value>> {
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    let mut manifest = load_state(&app, &session)?;
    if !manifest.enabled {
        return Err("Meeting workbench is disabled".into());
    }
    let entry = manifest
        .entries
        .get(&id)
        .filter(|e| store::eligible(e))
        .ok_or("Source is unavailable")?;
    let (root, _) = roots(&app, &session)?;
    let document = store::read_document(&root, entry)?;
    let artifact = manifest
        .artifacts
        .get(&id)
        .cloned()
        .ok_or("Suggestions not found")?;
    let proposals = artifact["todoSuggestions"]
        .as_array()
        .ok_or("Suggestions not found")?;
    let mut saved = Vec::new();
    for suggestion in suggestions {
        let proposal_id = suggestion["id"]
            .as_str()
            .ok_or("Suggestion ID is required")?;
        let original = proposals
            .iter()
            .find(|p| p["id"] == proposal_id)
            .ok_or("Suggestion does not belong to this meeting")?;
        let title = suggestion["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.chars().count() <= 500)
            .ok_or("Todo title is required")?;
        let source = original["citations"]
            .as_array()
            .and_then(|v| v.first())
            .cloned()
            .unwrap_or_else(|| json!(document.reference()));
        saved.push(save_confirmed_todo(&app, &session, &document, proposal_id, title, suggestion.get("dueDate").cloned().unwrap_or(Value::Null), source)?);
    }
    if let Some(array) = manifest
        .artifacts
        .get_mut(&id)
        .and_then(|v| v.get_mut("todoSuggestions"))
        .and_then(Value::as_array_mut)
    {
        for proposal in array {
            let pid = proposal["id"].as_str().unwrap_or_default();
            let tid = format!(
                "todo:workbench:{}",
                store::digest(format!("{}\n{}\n{}", session.scope, id, pid))
            );
            if saved.iter().any(|t| t["id"] == tid) {
                proposal["accepted"] = json!(true);
            }
        }
    }
    persist(&app, &session, &manifest)?;
    Ok(saved)
}

pub(super) fn confirmed_todo_id(session: &Session, source_id: &str, proposal_id: &str) -> String {
    format!("todo:workbench:{}", store::digest(format!("{}\n{}\n{}", session.scope, source_id, proposal_id)))
}
pub(super) fn save_confirmed_todo(app: &AppHandle, session: &Session, document: &Document, proposal_id: &str, title: &str, due_date: Value, source: Value) -> CommandResult<Value> {
    if title.trim().is_empty() || title.chars().count() > 500 { return Err("Todo title is required".into()); }
    let todo_id = confirmed_todo_id(session, &document.id, proposal_id);
    // The durable todo is the idempotency record, even when recording the graph link fails.
    if let Some(existing) = crate::get_store_value(app, "local-todos", &todo_id)? { return Ok(existing); }
    crate::save_todo(app, json!({"id":todo_id,"title":title.trim(),"completed":false,"createdAt":crate::now(),"updatedAt":crate::now(),"sourceFileId":document.id,"sourceTitle":document.title,"sourceRef":source,"workbenchScope":session.scope,"dueDate":due_date}))
}

#[tauri::command]
pub async fn workbench_context(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    query: String,
) -> CommandResult<Value> {
    let _guard = state.serial.lock().await;
    let session = current(&state)?;
    let manifest = load_state(&app, &session)?;
    if !manifest.enabled || !manifest.allow_ai || !manifest.initial_complete {
        return Ok(Value::Null);
    }
    let (root, _) = roots(&app, &session)?;
    let mut sources = store::search(&root, &manifest, &query, 3);
    sources.extend(wiki::context(&app, &session, &manifest, &query)?);
    Ok(json!({"version":1,"sources":sources,"scope":session.scope}))
}

#[cfg(test)]
mod wiki_lifecycle_tests {
    use super::*;
    #[test]
    fn status_exposes_processing_progress_with_skipped_meeting_counts() {
        let mut manifest = Manifest::default();
        manifest.wiki_progress = Some(store::WikiProgress {
            stage: "analyzing".into(),
            completed: 12,
            total: 30,
            current_title: "Meeting Alpha".into(),
            topic_title: "Launch".into(),
            failed: 0,
        });
        for (id, status) in [
            ("ready", "synced"),
            ("waiting", "awaiting_transcription"),
            ("failed", "failed"),
        ] {
            manifest.entries.insert(
                id.into(),
                store::Entry {
                    id: id.into(),
                    kind: "meeting".into(),
                    status: status.into(),
                    ..Default::default()
                },
            );
        }
        let status = public_status(&session("account", 1), &manifest);
        assert_eq!(status["wikiProgress"]["completed"], 12);
        assert_eq!(status["wikiProgress"]["currentTitle"], "Meeting Alpha");
        assert_eq!(status["synced"], 1);
        assert_eq!(status["awaitingTranscription"], 1);
        assert_eq!(status["failed"], 1);
    }
    fn session(scope: &str, generation: u64) -> Session {
        Session {
            scope: scope.into(),
            generation,
            user_id: "verified-user".into(),
            base_url: "https://example.test".into(),
            agent_url: "https://agent.test".into(),
            model_override: None,
            token: "synthetic-token".into(),
            locale: "en".into(),
        }
    }
    #[test]
    fn wiki_requires_explicit_runtime_beta_access() {
        let state = WorkbenchState::default();
        assert!(require_beta(&state).is_err());
        state.beta_enabled.store(true, Ordering::SeqCst);
        assert!(require_beta(&state).is_ok());
        state.beta_enabled.store(false, Ordering::SeqCst);
        assert!(require_beta(&state).is_err());
    }
    #[test]
    fn late_results_are_rejected_after_configuration_and_account_changes() {
        let state = WorkbenchState::default();
        let old = session("account-a", 0);
        *state.session.lock().unwrap() = Some(old.clone());
        let updated = invalidate_runtime(&state).unwrap();
        assert!(require_current(&state, &old).is_err());
        assert!(require_current(&state, &updated).is_ok());
        let another = session("account-b", updated.generation);
        *state.session.lock().unwrap() = Some(another);
        assert!(require_current(&state, &updated).is_err());
    }
    #[test]
    fn completion_is_bound_to_directory_and_sync_round() {
        let mut m = Manifest::default();
        m.initial_complete = true;
        m.sync_root = "/old/Meetings/account-a".into();
        m.sync_round = "one".into();
        m.completed_round = "one".into();
        assert!(m.bootstrap_valid("/old/Meetings/account-a"));
        assert!(!m.bootstrap_valid("/new/Meetings/account-a"));
        assert!(!m.bootstrap_valid("/old/Meetings/account-b"));
        m.sync_round = "two".into();
        assert!(!m.bootstrap_valid("/old/Meetings/account-a"));
        m.completed_round = "two".into();
        assert!(m.bootstrap_valid("/old/Meetings/account-a"));
    }
}
