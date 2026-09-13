//! Generic bot-channel command surface.
//!
//! One stable set of `bot_*` commands the frontend agent, supervisor, and
//! settings UI call, dispatching by channel id to per-channel implementations
//! (Feishu today; DingTalk plugs in as another match arm). Channel-specific
//! capabilities (Feishu's device-grant registration, Cardkit streaming, chat
//! listing) stay behind their own `feishu_*` commands.

use serde_json::Value;
use tauri::AppHandle;

use crate::{feishu, CommandResult};

/// Unified webview event every channel emits inbound messages on; the
/// payload always carries a `channel` field.
pub const BOT_EVENT: &str = "bot-event";

pub const CHANNEL_FEISHU: &str = "feishu";

/// Channels the settings UI and the auth supervisor iterate. Keep in sync
/// with [`dispatch`].
pub const CHANNELS: &[&str] = &[CHANNEL_FEISHU];

fn dispatch(channel: &str) -> Result<(), String> {
    match channel {
        CHANNEL_FEISHU => Ok(()),
        other => Err(format!("Unknown bot channel: {other}")),
    }
}

/// `CommandResult` is stringly-typed; serialize with a mapped error.
fn json<T: serde::Serialize>(value: T) -> CommandResult<Value> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn bot_config_get(app: AppHandle, channel: String) -> CommandResult<Value> {
    dispatch(&channel)?;
    json(feishu::feishu_config_get(app)?)
}

#[tauri::command]
pub fn bot_config_save(
    app: AppHandle,
    channel: String,
    config: Value,
    secret: Option<String>,
) -> CommandResult<Value> {
    dispatch(&channel)?;
    let config: feishu::FeishuConfig =
        serde_json::from_value(config).map_err(|error| error.to_string())?;
    json(feishu::feishu_config_save(
        app, config, secret,
    )?)
}

/// Wipe the channel's setup (stop, drop secrets, restore defaults) so its
/// first-run flow can run again.
#[tauri::command]
pub fn bot_reset(app: AppHandle, channel: String) -> CommandResult<Value> {
    dispatch(&channel)?;
    json(feishu::feishu_config_reset(app)?)
}

#[tauri::command]
pub fn bot_start(app: AppHandle, channel: String) -> CommandResult<Value> {
    dispatch(&channel)?;
    json(feishu::feishu_bot_start(app)?)
}

/// Stop the channel. `reason` marks supervisor-driven pauses (currently
/// `logged_out`) so the UI can explain why an enabled bot is offline.
#[tauri::command]
pub fn bot_stop(app: AppHandle, channel: String, reason: Option<String>) -> CommandResult<Value> {
    dispatch(&channel)?;
    match reason.as_deref() {
        Some("logged_out") => {
            feishu::stop_bot_reasoned(&app, reason.clone());
            json(feishu::feishu_state(app)?)
        }
        _ => json(feishu::feishu_bot_stop(app)?),
    }
}

#[tauri::command]
pub fn bot_state(app: AppHandle, channel: String) -> CommandResult<Value> {
    dispatch(&channel)?;
    json(feishu::feishu_state(app)?)
}
