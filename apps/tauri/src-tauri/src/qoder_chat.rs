use futures_util::StreamExt;
use reqwest::{Client, Response, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use tauri::{AppHandle, Emitter};

use crate::{CommandResult, SECRET_SERVICE};

const QODER_BASE_URL: &str = "https://api.qoder.com.cn/api/v1/cloud";
const QODER_AGENT_ID: &str = "agent_00muvnzup32f4qnrbb5u";
const QODER_ENVIRONMENT_ID: &str = "env_00muvotayheyp3yx77fb";
const QODER_PAT_ACCOUNT: &str = "lynse_qoder_pat";
const QODER_CHAT_EVENT: &str = "qoder-chat-event";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QoderChatConfig {
    configured: bool,
    source: Option<&'static str>,
    agent_id: &'static str,
    environment_id: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QoderChatTurnResult {
    last_event_id: Option<String>,
}

#[derive(Debug, PartialEq)]
struct SseFrame {
    id: Option<String>,
    event: Option<String>,
    data: String,
}

fn stored_pat() -> CommandResult<Option<String>> {
    let entry = keyring::Entry::new(SECRET_SERVICE, QODER_PAT_ACCOUNT)
        .map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn qoder_pat() -> CommandResult<(String, &'static str)> {
    if let Ok(value) = env::var("QODER_PAT") {
        let value = value.trim();
        if !value.is_empty() {
            return Ok((value.to_owned(), "environment"));
        }
    }
    if let Some(value) = stored_pat()? {
        let value = value.trim();
        if !value.is_empty() {
            return Ok((value.to_owned(), "keychain"));
        }
    }
    Err(
        "Qoder PAT is not configured. Add it in Settings or set QODER_PAT before launching Lynse."
            .to_owned(),
    )
}

fn qoder_client() -> CommandResult<Client> {
    Client::builder()
        .user_agent("Lynse Desktop Qoder Cloud Agent")
        .build()
        .map_err(|error| error.to_string())
}

fn error_message(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    parsed
        .get("error")
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| value.as_str())
        })
        .or_else(|| parsed.get("message").and_then(Value::as_str))
        .map(str::to_owned)
}

async fn expect_success(response: Response, action: &str) -> CommandResult<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = error_message(&body).unwrap_or_else(|| body.trim().to_owned());
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    };
    Err(format!("Qoder {action} failed (HTTP {status}){suffix}"))
}

fn emit_chat_event(app: &AppHandle, request_id: &str, payload: Value) -> CommandResult<()> {
    let mut object = payload
        .as_object()
        .cloned()
        .ok_or("Qoder chat event payload must be an object")?;
    object.insert("requestId".to_owned(), json!(request_id));
    app.emit(QODER_CHAT_EVENT, Value::Object(object))
        .map_err(|error| error.to_string())
}

fn parse_sse_frame(raw: &[u8]) -> Option<SseFrame> {
    let text = String::from_utf8_lossy(raw);
    let mut id = None;
    let mut event = None;
    let mut data = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "id" => id = Some(value.to_owned()),
            "event" => event = Some(value.to_owned()),
            "data" => data.push(value),
            _ => {}
        }
    }
    if id.is_none() && event.is_none() && data.is_empty() {
        return None;
    }
    Some(SseFrame {
        id,
        event,
        data: data.join("\n"),
    })
}

fn frame_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
    }
}

fn take_sse_frames(buffer: &mut Vec<u8>) -> Vec<SseFrame> {
    let mut frames = Vec::new();
    while let Some((index, delimiter_len)) = frame_boundary(buffer) {
        let raw = buffer[..index].to_vec();
        buffer.drain(..index + delimiter_len);
        if let Some(frame) = parse_sse_frame(&raw) {
            frames.push(frame);
        }
    }
    frames
}

fn content_text(payload: &Value) -> String {
    match payload.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn stream_url(session_id: &str, after_event_id: Option<&str>) -> CommandResult<Url> {
    let mut url = Url::parse(&format!(
        "{QODER_BASE_URL}/sessions/{session_id}/events/stream"
    ))
    .map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("event_deltas[]", "agent.message");
        query.append_pair("delta_flush_interval_ms", "100");
        if let Some(after_event_id) = after_event_id.filter(|value| !value.is_empty()) {
            query.append_pair("after_id", after_event_id);
        }
    }
    Ok(url)
}

#[tauri::command]
pub(crate) fn qoder_chat_config() -> CommandResult<QoderChatConfig> {
    match qoder_pat() {
        Ok((_, source)) => Ok(QoderChatConfig {
            configured: true,
            source: Some(source),
            agent_id: QODER_AGENT_ID,
            environment_id: QODER_ENVIRONMENT_ID,
        }),
        Err(message) if message.starts_with("Qoder PAT is not configured") => Ok(QoderChatConfig {
            configured: false,
            source: None,
            agent_id: QODER_AGENT_ID,
            environment_id: QODER_ENVIRONMENT_ID,
        }),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) fn qoder_chat_save_pat(pat: String) -> CommandResult<QoderChatConfig> {
    let pat = pat.trim();
    if pat.is_empty() {
        return Err("Qoder PAT cannot be empty".to_owned());
    }
    let entry = keyring::Entry::new(SECRET_SERVICE, QODER_PAT_ACCOUNT)
        .map_err(|error| error.to_string())?;
    entry.set_password(pat).map_err(|error| error.to_string())?;
    qoder_chat_config()
}

#[tauri::command]
pub(crate) async fn qoder_chat_create_session() -> CommandResult<String> {
    let (pat, _) = qoder_pat()?;
    let response = qoder_client()?
        .post(format!("{QODER_BASE_URL}/sessions"))
        .bearer_auth(pat)
        .json(&json!({
            "agent": QODER_AGENT_ID,
            "environment_id": QODER_ENVIRONMENT_ID,
        }))
        .send()
        .await
        .map_err(|error| format!("Qoder create session failed: {error}"))?;
    let response = expect_success(response, "create session").await?;
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("sess_"))
        .map(str::to_owned)
        .ok_or("Qoder create session response did not include a valid session id".to_owned())
}

#[tauri::command]
pub(crate) async fn qoder_chat_send_message(
    app: AppHandle,
    session_id: String,
    message: String,
    request_id: String,
    after_event_id: Option<String>,
) -> CommandResult<QoderChatTurnResult> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Qoder message cannot be empty".to_owned());
    }
    let (pat, _) = qoder_pat()?;
    let client = qoder_client()?;

    // Subscribe before sending the message so no incremental delta is missed.
    let stream_response = client
        .get(stream_url(&session_id, after_event_id.as_deref())?)
        .bearer_auth(&pat)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
        .map_err(|error| format!("Qoder event stream failed: {error}"))?;
    let stream_response = expect_success(stream_response, "open event stream").await?;

    let send_response = client
        .post(format!("{QODER_BASE_URL}/sessions/{session_id}/events"))
        .bearer_auth(&pat)
        .json(&json!({
            "events": [{
                "type": "user.message",
                "content": [{"type": "text", "text": message}],
            }],
        }))
        .send()
        .await
        .map_err(|error| format!("Qoder send message failed: {error}"))?;
    expect_success(send_response, "send message").await?;

    let mut bytes_stream = stream_response.bytes_stream();
    let mut buffer = Vec::new();
    let mut last_event_id = after_event_id;
    let mut delta_message_ids = std::collections::HashSet::new();

    while let Some(chunk) = bytes_stream.next().await {
        let chunk = chunk.map_err(|error| format!("Qoder event stream failed: {error}"))?;
        buffer.extend_from_slice(&chunk);
        for frame in take_sse_frames(&mut buffer) {
            if let Some(id) = frame.id.as_ref().filter(|value| !value.is_empty()) {
                last_event_id = Some(id.clone());
            }
            let payload: Value = if frame.data.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&frame.data).unwrap_or(Value::Null)
            };
            let event_type = frame
                .event
                .as_deref()
                .or_else(|| payload.get("type").and_then(Value::as_str))
                .unwrap_or_default();

            match event_type {
                "event_start" => match payload.pointer("/event/type").and_then(Value::as_str) {
                    Some("agent.thinking") => emit_chat_event(
                        &app,
                        &request_id,
                        json!({"type": "status", "text": "Qoder Cloud Agent · thinking"}),
                    )?,
                    Some("agent.message") => {
                        if let Some(id) = payload.pointer("/event/id").and_then(Value::as_str) {
                            delta_message_ids.insert(id.to_owned());
                        }
                    }
                    _ => {}
                },
                "event_delta" => {
                    if let Some(text) = payload
                        .pointer("/delta/content/text")
                        .and_then(Value::as_str)
                    {
                        if !text.is_empty() {
                            emit_chat_event(
                                &app,
                                &request_id,
                                json!({"type": "content", "delta": text}),
                            )?;
                        }
                    }
                }
                "session.status_running" => emit_chat_event(
                    &app,
                    &request_id,
                    json!({"type": "status", "text": "Qoder Cloud Agent · running"}),
                )?,
                "agent.thinking" => emit_chat_event(
                    &app,
                    &request_id,
                    json!({"type": "status", "text": "Qoder Cloud Agent · thinking"}),
                )?,
                "agent.tool_use" => {
                    let name = payload
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    emit_chat_event(
                        &app,
                        &request_id,
                        json!({"type": "status", "text": format!("Qoder Cloud Agent · {name}")}),
                    )?;
                }
                "agent.message" => {
                    let frame_id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .or(frame.id.as_deref());
                    if !frame_id.is_some_and(|id| delta_message_ids.contains(id)) {
                        let text = content_text(&payload);
                        if !text.is_empty() {
                            emit_chat_event(
                                &app,
                                &request_id,
                                json!({"type": "content", "delta": text}),
                            )?;
                        }
                    }
                }
                "session.error" => {
                    let message = payload
                        .get("error")
                        .and_then(|value| {
                            value
                                .as_str()
                                .or_else(|| value.get("message").and_then(Value::as_str))
                        })
                        .unwrap_or("Qoder session error");
                    return Err(message.to_owned());
                }
                "session.status_idle" => {
                    emit_chat_event(&app, &request_id, json!({"type": "done"}))?;
                    return Ok(QoderChatTurnResult { last_event_id });
                }
                "terminated" | "session.status_terminated" | "session.deleted" => {
                    return Err("Qoder session terminated before the turn completed".to_owned());
                }
                _ => {}
            }
        }
    }

    Err("Qoder event stream closed before the session became idle".to_owned())
}

#[tauri::command]
pub(crate) async fn qoder_chat_cancel(session_id: String) -> CommandResult<()> {
    let (pat, _) = qoder_pat()?;
    let response = qoder_client()?
        .post(format!("{QODER_BASE_URL}/sessions/{session_id}/cancel"))
        .bearer_auth(pat)
        .send()
        .await
        .map_err(|error| format!("Qoder cancel session failed: {error}"))?;
    expect_success(response, "cancel session").await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_frames_split_across_chunks() {
        let mut buffer =
            b"id: evt_1\nevent: event_delta\ndata: {\"delta\":{\"content\":{\"text\":\"hello\"}}}"
                .to_vec();
        assert!(take_sse_frames(&mut buffer).is_empty());

        buffer.extend_from_slice(b"\n\nid: evt_2\r\nevent: session.status_idle\r\ndata: {\"type\":\"session.status_idle\"}\r\n\r\n");
        let frames = take_sse_frames(&mut buffer);

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].id.as_deref(), Some("evt_1"));
        assert_eq!(frames[0].event.as_deref(), Some("event_delta"));
        assert_eq!(frames[1].event.as_deref(), Some("session.status_idle"));
        assert!(buffer.is_empty());
    }

    #[test]
    fn builds_incremental_stream_url_with_resume_cursor() {
        let url = stream_url("sess_test", Some("evt_previous")).unwrap();
        let query = url.query_pairs().collect::<Vec<_>>();
        assert!(query.contains(&("event_deltas[]".into(), "agent.message".into())));
        assert!(query.contains(&("delta_flush_interval_ms".into(), "100".into())));
        assert!(query.contains(&("after_id".into(), "evt_previous".into())));
    }

    #[test]
    fn extracts_text_content_blocks() {
        assert_eq!(
            content_text(&json!({
                "content": [
                    {"type": "text", "text": "hello "},
                    {"type": "text", "text": "world"},
                ]
            })),
            "hello world"
        );
    }

    #[test]
    fn extracts_qoder_error_message() {
        assert_eq!(
            error_message(r#"{"error":{"type":"authentication_error","message":"PAT expired"}}"#)
                .as_deref(),
            Some("PAT expired")
        );
    }
}
