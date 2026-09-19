//! Feishu (Lark) bot integration.
//!
//! The desktop app acts as the bot's connection endpoint: a WebSocket
//! long connection (`ws.rs`) receives `im.message.receive_v1` events and
//! forwards them to the webview, where the headless `FeishuAgent` queries the
//! existing AI backend; replies and summary pushes go out through the
//! standard Open Platform message APIs (`api.rs`).
//!
//! Layout:
//! - `feishu/config.json` under the app data dir — non-secret config
//!   (`app_id`, push-target `chat_id`, switches).
//! - the App Secret never leaves the OS keychain
//!   (`secret_get`/`secret_set`, account `lynse_feishu_app_secret`).
//! - one WS session task at a time; a generation counter invalidates the
//!   running task when the bot is stopped or reconfigured.

mod api;
mod registration;
mod ws;

use registration::{FeishuRegistrationPoll, FeishuRegistrationStart};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::{app_data_dir, now, secret_delete, secret_get, secret_set, CommandResult};

pub(crate) const FEISHU_STATE_EVENT: &str = "feishu-state";

const FEISHU_DIR: &str = "feishu";
pub(crate) const APP_SECRET_ACCOUNT: &str = "lynse_feishu_app_secret";
/// Refresh the cached tenant token this long before its real expiry.
const TOKEN_REFRESH_MARGIN_SECS: u64 = 300;
/// Rough cap for one interactive-card markdown element.
const CARD_MARKDOWN_LIMIT: usize = 9_000;

// ── Config ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FeishuConfig {
    pub app_id: String,
    /// Group chat that summary pushes go to. Empty until the user picks one.
    pub target_chat_id: String,
    /// Keep the WS long connection running (auto-start on launch too).
    pub enabled: bool,
    /// Push a summary card when a transcription/summary finishes.
    pub push_summary: bool,
    /// Read-only mirror of "a secret exists in the keychain" so the UI can
    /// gate the switch without ever reading the secret back.
    pub has_secret: bool,
}

impl Default for FeishuConfig {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            target_chat_id: String::new(),
            enabled: false,
            push_summary: true,
            has_secret: false,
        }
    }
}

fn feishu_dir(app: &AppHandle) -> CommandResult<std::path::PathBuf> {
    let path = app_data_dir(app)?.join(FEISHU_DIR);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn feishu_config_path(app: &AppHandle) -> CommandResult<std::path::PathBuf> {
    Ok(feishu_dir(app)?.join("config.json"))
}

pub(crate) fn load_config(app: &AppHandle) -> CommandResult<FeishuConfig> {
    let path = feishu_config_path(app)?;
    let mut config = match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<FeishuConfig>(&content).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => FeishuConfig::default(),
        Err(error) => return Err(error.to_string()),
    };
    config.has_secret = secret_get(app, APP_SECRET_ACCOUNT)?.is_some();
    Ok(config)
}

pub(crate) fn save_config_file(app: &AppHandle, config: &FeishuConfig) -> CommandResult<()> {
    let path = feishu_config_path(app)?;
    let content = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(&path, content).map_err(|error| error.to_string())
}

/// The stored App Secret. The bot cannot start without one.
pub(crate) fn secret(app: &AppHandle) -> CommandResult<String> {
    secret_get(app, APP_SECRET_ACCOUNT)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Feishu App Secret is not configured".to_owned())
}

// ── Connection state ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FeishuStatusKind {
    Disabled,
    Connecting,
    Online,
    Reconnecting,
    Error,
}

impl FeishuStatusKind {
    fn as_str(self) -> &'static str {
        match self {
            FeishuStatusKind::Disabled => "disabled",
            FeishuStatusKind::Connecting => "connecting",
            FeishuStatusKind::Online => "online",
            FeishuStatusKind::Reconnecting => "reconnecting",
            FeishuStatusKind::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuStatus {
    pub state: String,
    pub error: Option<String>,
    /// Why the bot is in this state when it is not the channel's own doing —
    /// e.g. `logged_out` when the auth supervisor paused it on logout.
    pub reason: Option<String>,
    pub updated_at: String,
}

/// Managed handle: connection status for the settings UI, a generation
/// counter that invalidates the running WS session, the cached tenant
/// access token, and the live one-click registration session (if any).
pub struct FeishuHandle {
    status: Mutex<FeishuStatus>,
    generation: AtomicU64,
    token: Mutex<Option<(String, Instant)>>,
    registration: Mutex<Option<registration::RegistrationSession>>,
}

impl Default for FeishuHandle {
    fn default() -> Self {
        Self {
            status: Mutex::new(FeishuStatus {
                state: FeishuStatusKind::Disabled.as_str().to_owned(),
                error: None,
                reason: None,
                updated_at: now(),
            }),
            generation: AtomicU64::new(0),
            token: Mutex::new(None),
            registration: Mutex::new(None),
        }
    }
}

impl FeishuHandle {
    /// Update the status snapshot and broadcast it to the webview. Any
    /// previously set reason is cleared — reasons only stick when set
    /// explicitly via [`Self::set_status_reasoned`].
    fn set_status(&self, app: &AppHandle, kind: FeishuStatusKind, error: Option<String>) {
        self.set_status_reasoned(app, kind, error, None);
    }

    /// [`Self::set_status`] plus a machine-readable reason (e.g.
    /// `logged_out`) the UI can use to explain a paused bot.
    pub(crate) fn set_status_reasoned(
        &self,
        app: &AppHandle,
        kind: FeishuStatusKind,
        error: Option<String>,
        reason: Option<String>,
    ) {
        if let Ok(mut status) = self.status.lock() {
            status.state = kind.as_str().to_owned();
            status.error = error;
            status.reason = reason;
            status.updated_at = now();
        }
        let _ = app.emit(FEISHU_STATE_EVENT, self.status_snapshot());
    }

    pub(crate) fn status_snapshot(&self) -> FeishuStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or(FeishuStatus {
                state: FeishuStatusKind::Disabled.as_str().to_owned(),
                error: Some("status lock is poisoned".to_owned()),
                reason: None,
                updated_at: now(),
            })
    }
}

// ── Tenant access token (cached) ────────────────────────────────────────────

/// Cached tenant access token for the current config; refreshes when missing
/// or within [`TOKEN_REFRESH_MARGIN_SECS`] of expiry.
pub(crate) async fn tenant_token(app: &AppHandle, feishu: &api::FeishuApi) -> CommandResult<String> {
    let handle = app.state::<FeishuHandle>();
    if let Ok(guard) = handle.token.lock() {
        if let Some((token, expires_at)) = guard.as_ref() {
            if *expires_at > Instant::now() {
                return Ok(token.clone());
            }
        }
    }
    let (token, expire_secs) = feishu.fetch_tenant_access_token().await?;
    let expires_at =
        Instant::now() + Duration::from_secs(expire_secs.saturating_sub(TOKEN_REFRESH_MARGIN_SECS));
    if let Ok(mut guard) = handle.token.lock() {
        *guard = Some((token.clone(), expires_at));
    }
    Ok(token)
}

/// Api client + fresh token for one command's network work.
async fn feishu_runtime(app: &AppHandle) -> CommandResult<(api::FeishuApi, String)> {
    let config = load_config(app)?;
    let secret_value = secret(app)?;
    let feishu = api::FeishuApi::new(api::DEFAULT_DOMAIN, &config.app_id, &secret_value)?;
    let token = tenant_token(app, &feishu).await?;
    Ok((feishu, token))
}

// ── Session lifecycle ───────────────────────────────────────────────────────

/// Start (or restart) the WS session. Safe to call repeatedly — the running
/// session is invalidated via the generation counter and a fresh one starts.
pub(crate) fn start_bot(app: &AppHandle) {
    let handle = app.state::<FeishuHandle>();
    let generation = handle.generation.load(Ordering::SeqCst) + 1;
    handle.generation.store(generation, Ordering::SeqCst);
    handle.set_status(app, FeishuStatusKind::Connecting, None);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        ws::run_session(app_handle, generation).await;
    });
}

/// Stop the WS session and flip the status to disabled.
fn stop_bot(app: &AppHandle) {
    stop_bot_reasoned(app, None);
}

/// Stop the session with a machine-readable reason (e.g. `logged_out`) the
/// settings UI can surface instead of a bare "disabled".
pub(crate) fn stop_bot_reasoned(app: &AppHandle, reason: Option<String>) {
    let handle = app.state::<FeishuHandle>();
    handle.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = handle.token.lock() {
        *guard = None;
    }
    handle.set_status_reasoned(app, FeishuStatusKind::Disabled, None, reason);
}

/// Auto-start at app launch when the bot was left enabled. Modeled on
/// `meeting_detector::spawn` — never blocks setup, only logs.
pub fn spawn(app: AppHandle) {
    let config = match load_config(&app) {
        Ok(config) => config,
        Err(error) => {
            log::error!("[feishu] failed to load config at startup: {error}");
            return;
        }
    };
    if !config.enabled || config.app_id.trim().is_empty() {
        // Observable in the file log so "why didn't my bot connect after a
        // restart" has an answer (the settings card gates on the same flag).
        log::info!("[feishu] bot disabled at startup — not starting");
        return;
    }
    match secret(&app) {
        Ok(_) => {
            log::info!("[feishu] bot enabled at startup — starting WS session");
            start_bot(&app);
        }
        Err(error) => log::warn!("[feishu] enabled but not starting: {error}"),
    }
}

// ── Card builders ───────────────────────────────────────────────────────────

/// Plain-text message content (`{"text": "..."}`).
fn text_content(text: &str) -> Value {
    json!({ "text": text })
}

/// Long text is truncated with a visible marker rather than rejected by the
/// message API.
fn truncate_markdown(markdown: &str) -> String {
    let trimmed = markdown.trim();
    if trimmed.chars().count() <= CARD_MARKDOWN_LIMIT {
        return trimmed.to_owned();
    }
    let mut content: String = trimmed.chars().take(CARD_MARKDOWN_LIMIT).collect();
    content.push_str("\n\n…");
    content
}

/// Interactive card with one markdown element (AI answers).
fn markdown_card(markdown: &str) -> Value {
    json!({
        "config": { "wide_screen_mode": true },
        "elements": [{ "tag": "markdown", "content": truncate_markdown(markdown) }]
    })
}

/// Interactive summary card: bold title line + markdown body. Used by the
/// meeting-summary push.
fn summary_card(title: &str, markdown: &str) -> Value {
    json!({
        "config": { "wide_screen_mode": true },
        "elements": [
            { "tag": "markdown", "content": format!("**{}**", title.trim()) },
            { "tag": "markdown", "content": truncate_markdown(markdown) }
        ]
    })
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn feishu_config_get(app: AppHandle) -> CommandResult<FeishuConfig> {
    load_config(&app)
}

/// Persist the config (and optionally a new App Secret), then reconcile the
/// session: start when enabled + fully configured, otherwise stop. Returns
/// the stored config with `hasSecret` refreshed.
#[tauri::command]
pub fn feishu_config_save(
    app: AppHandle,
    config: FeishuConfig,
    secret: Option<String>,
) -> CommandResult<FeishuConfig> {
    let mut config = config;
    if let Some(secret_value) = secret.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        secret_set(&app, APP_SECRET_ACCOUNT, secret_value)?;
    }
    config.app_id = config.app_id.trim().to_owned();
    save_config_file(&app, &config)?;
    let stored = load_config(&app)?;

    if stored.enabled && !stored.app_id.is_empty() && stored.has_secret {
        start_bot(&app);
    } else {
        stop_bot(&app);
    }
    Ok(stored)
}

/// Wipe the bot setup: stop the WS session, drop the keychain secret, and
/// restore the default config. The settings card then behaves as if no bot
/// was ever configured, so one-click registration can run again.
#[tauri::command]
pub fn feishu_config_reset(app: AppHandle) -> CommandResult<FeishuConfig> {
    stop_bot(&app);
    secret_delete(&app, APP_SECRET_ACCOUNT)?;
    let fresh = FeishuConfig::default();
    save_config_file(&app, &fresh)?;
    Ok(load_config(&app)?)
}

#[tauri::command]
pub fn feishu_bot_start(app: AppHandle) -> CommandResult<FeishuStatus> {
    let config = load_config(&app)?;
    if config.app_id.is_empty() || !config.has_secret {
        return Err("Feishu App ID / Secret is not configured".to_owned());
    }
    start_bot(&app);
    Ok(app.state::<FeishuHandle>().status_snapshot())
}

#[tauri::command]
pub fn feishu_bot_stop(app: AppHandle) -> CommandResult<FeishuStatus> {
    stop_bot(&app);
    Ok(app.state::<FeishuHandle>().status_snapshot())
}

#[tauri::command]
pub fn feishu_state(app: AppHandle) -> CommandResult<FeishuStatus> {
    Ok(app.state::<FeishuHandle>().status_snapshot())
}

/// Validates the credentials by fetching a tenant access token; also returns
/// the bot's identity for the settings UI.
#[tauri::command(async)]
pub async fn feishu_test_connection(app: AppHandle) -> CommandResult<Value> {
    let config = load_config(&app)?;
    let secret_value = secret(&app)?;
    let feishu = api::FeishuApi::new(api::DEFAULT_DOMAIN, &config.app_id, &secret_value)?;
    let (token, _expire) = feishu.fetch_tenant_access_token().await?;
    let bot = feishu.bot_info(&token).await?;
    Ok(json!({
        "ok": true,
        "botName": bot.get("app_name").and_then(Value::as_str).unwrap_or(""),
        "openId": bot.get("open_id").and_then(Value::as_str).unwrap_or(""),
    }))
}

/// Chats the bot is a member of — the push-target picker.
#[tauri::command(async)]
pub async fn feishu_list_chats(app: AppHandle) -> CommandResult<Vec<Value>> {
    let (feishu, token) = feishu_runtime(&app).await?;
    feishu.list_chats(&token).await
}

/// Send a plain text message. `chat_id` falls back to the configured push
/// target so the settings card can fire a quick self-test.
#[tauri::command(async)]
pub async fn feishu_send_text(
    app: AppHandle,
    text: String,
    chat_id: Option<String>,
) -> CommandResult<Value> {
    let target = match chat_id.filter(|value| !value.trim().is_empty()) {
        Some(chat_id) => chat_id,
        None => load_config(&app)?.target_chat_id,
    };
    if target.is_empty() {
        return Err("No target chat configured".to_owned());
    }
    let (feishu, token) = feishu_runtime(&app).await?;
    feishu
        .send_message(&token, &target, "text", &text_content(&text))
        .await
}

/// Reply to a specific message in plain text (the agent's ack).
#[tauri::command(async)]
pub async fn feishu_reply_text(
    app: AppHandle,
    message_id: String,
    text: String,
) -> CommandResult<Value> {
    let (feishu, token) = feishu_runtime(&app).await?;
    feishu
        .reply_message(&token, &message_id, "text", &text_content(&text))
        .await
}

/// Reply to a specific message with a markdown card (AI answers).
#[tauri::command(async)]
pub async fn feishu_reply_markdown(
    app: AppHandle,
    message_id: String,
    markdown: String,
) -> CommandResult<Value> {
    let (feishu, token) = feishu_runtime(&app).await?;
    let card = markdown_card(&markdown);
    feishu
        .reply_message(&token, &message_id, "interactive", &card)
        .await
}

/// Streaming "typewriter": replace the markdown card on a previously sent
/// interactive message (the agent's ack card grows into the full answer).
/// The card goes through the same builder as replies, so truncation applies.
#[tauri::command(async)]
pub async fn feishu_update_markdown_card(
    app: AppHandle,
    message_id: String,
    markdown: String,
) -> CommandResult<Value> {
    let (feishu, token) = feishu_runtime(&app).await?;
    let card = markdown_card(&markdown);
    feishu.update_card(&token, &message_id, &card).await
}

// ── Official Cardkit streaming (the agent's primary answer strategy) ────────

const STREAM_ELEMENT_ID: &str = "markdown_1";

/// Streaming card JSON 2.0 with the typewriter tuned to the client default
/// (70ms/char). `update_multi` must not be false in streaming mode.
fn streaming_card(markdown: &str) -> Value {
    json!({
        "schema": "2.0",
        "config": {
            "streaming_mode": true,
            "summary": { "content": "" },
            "streaming_config": {
                "print_frequency_ms": { "default": 70 },
                "print_step": { "default": 1 },
                "print_strategy": "fast"
            }
        },
        "body": {
            "elements": [
                { "tag": "markdown", "content": truncate_markdown(markdown), "element_id": STREAM_ELEMENT_ID }
            ]
        }
    })
}

/// Start a streaming answer: create the streaming card entity and reply in
/// thread with it. Returns `cardId` (for later pushes) and `messageId`.
#[tauri::command(async)]
pub async fn feishu_stream_start(
    app: AppHandle,
    reply_to: String,
    markdown: String,
) -> CommandResult<Value> {
    let config = load_config(&app)?;
    let secret_value = secret(&app)?;
    let feishu = api::FeishuApi::new(api::DEFAULT_DOMAIN, &config.app_id, &secret_value)?;
    let token = tenant_token(&app, &feishu).await?;
    let card_id = feishu.create_card_entity(&token, &streaming_card(&markdown)).await?;
    let content = json!({ "type": "card", "data": { "card_id": card_id } });
    let reply = feishu
        .reply_message(&token, &reply_to, "interactive", &content)
        .await?;
    let message_id = reply
        .pointer("/data/message_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok(json!({ "cardId": card_id, "messageId": message_id }))
}

/// Typewriter step: push the current full text to the streaming card's
/// markdown element. `sequence` must strictly increase per card.
#[tauri::command(async)]
pub async fn feishu_stream_push(
    app: AppHandle,
    card_id: String,
    markdown: String,
    sequence: i64,
) -> CommandResult<()> {
    let (feishu, token) = feishu_runtime(&app).await?;
    feishu
        .stream_card_content(&token, &card_id, STREAM_ELEMENT_ID, &truncate_markdown(&markdown), sequence)
        .await
}

/// Deliver the final text and close streaming mode (content at `sequence`,
/// settings at `sequence + 1`) so the preview unfreezes and the card can be
/// forwarded.
#[tauri::command(async)]
pub async fn feishu_stream_finish(
    app: AppHandle,
    card_id: String,
    markdown: String,
    sequence: i64,
) -> CommandResult<()> {
    let (feishu, token) = feishu_runtime(&app).await?;
    feishu
        .stream_card_content(&token, &card_id, STREAM_ELEMENT_ID, &truncate_markdown(&markdown), sequence)
        .await?;
    feishu
        .finish_streaming_card(&token, &card_id, sequence + 1)
        .await
}

/// Push the meeting-summary card to the configured target chat.
#[tauri::command(async)]
pub async fn feishu_send_summary_card(
    app: AppHandle,
    title: String,
    summary: String,
    file_id: Option<String>,
) -> CommandResult<Value> {
    let target = load_config(&app)?.target_chat_id;
    if target.is_empty() {
        return Err("No target chat configured".to_owned());
    }
    let mut card = summary_card(&title, &summary);
    // When the note id is known, append a footer line so group members know
    // where the note lives.
    if let Some(file_id) = file_id.filter(|value| !value.trim().is_empty()) {
        if let Some(elements) = card.get_mut("elements").and_then(Value::as_array_mut) {
            elements.push(json!({
                "tag": "markdown",
                "content": format!("---\n文件 ID：`{file_id}`（Lynse → 笔记中查看全文）"),
            }));
        }
    }
    let (feishu, token) = feishu_runtime(&app).await?;
    feishu
        .send_message(&token, &target, "interactive", &card)
        .await
}

// ── One-click registration (device grant; logic in `registration`) ─────────

/// Start the one-click flow: returns the confirmation URL for the QR code.
#[tauri::command(async)]
pub async fn feishu_register_begin(
    app: AppHandle,
    name: Option<String>,
    desc: Option<String>,
) -> CommandResult<FeishuRegistrationStart> {
    registration::begin(&app, name, desc).await
}

/// One registration poll; `success` returns the saved config.
#[tauri::command(async)]
pub async fn feishu_register_poll(app: AppHandle) -> CommandResult<FeishuRegistrationPoll> {
    registration::poll(&app).await
}

/// Drop the active registration when the dialog closes.
#[tauri::command]
pub fn feishu_register_cancel(app: AppHandle) -> CommandResult<()> {
    registration::cancel(&app);
    Ok(())
}
