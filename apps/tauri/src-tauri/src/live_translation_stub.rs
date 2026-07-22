use crate::CommandResult;
use serde_json::{json, Value};

const UNSUPPORTED: &str = "live translation is currently supported on macOS only";

#[derive(Default)]
pub struct LiveTranslationManager;

fn unsupported<T>() -> CommandResult<T> {
    Err(UNSUPPORTED.to_owned())
}

#[tauri::command]
pub fn live_translation_permissions() -> CommandResult<Value> {
    unsupported()
}

#[tauri::command]
pub fn live_translation_request_permission(kind: String) -> CommandResult<Value> {
    let _ = kind;
    unsupported()
}

#[tauri::command]
pub fn live_translation_state() -> CommandResult<Value> {
    Ok(json!({
        "state": "idle",
        "sessionId": null,
        "epoch": 0,
        "sourceLanguage": null,
        "targetLanguage": null,
        "startedAt": null,
        "elapsedMs": 0,
        "micLevel": 0.0,
        "systemLevel": 0.0,
        "segments": [],
    }))
}

#[tauri::command]
pub async fn live_translation_start(request: Value) -> CommandResult<Value> {
    let _ = request;
    unsupported()
}

#[tauri::command]
pub async fn live_translation_pause() -> CommandResult<Value> {
    unsupported()
}

#[tauri::command]
pub async fn live_translation_resume(request: Value) -> CommandResult<Value> {
    let _ = request;
    unsupported()
}

#[tauri::command]
pub async fn live_translation_stop() -> CommandResult<Value> {
    unsupported()
}

#[tauri::command]
pub fn live_translation_finalize_local(session_id: String, synced: bool) -> CommandResult<()> {
    let _ = (session_id, synced);
    unsupported()
}

#[tauri::command]
pub fn live_translation_recoveries() -> CommandResult<Vec<Value>> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn live_translation_recover(session_id: String) -> CommandResult<Value> {
    let _ = session_id;
    unsupported()
}

#[tauri::command]
pub fn live_translation_show_subtitles(show: bool) -> CommandResult<()> {
    if show {
        unsupported()
    } else {
        Ok(())
    }
}
