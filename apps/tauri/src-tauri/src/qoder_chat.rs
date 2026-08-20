use futures_util::StreamExt;
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::http::{header, Request, Response as HttpResponse, StatusCode};
use tauri::{AppHandle, Emitter, Manager, Runtime, UriSchemeContext};
use tokio::time::{Duration, Instant, MissedTickBehavior};

use crate::{CommandResult, SECRET_SERVICE};

const QODER_BASE_URL: &str = "https://api.qoder.com.cn/api/v1/cloud";
const QODER_AGENT_ID: &str = "agent_00muvnzup32f4qnrbb5u";
const QODER_ENVIRONMENT_ID: &str = "env_00muvotayheyp3yx77fb";
const QODER_PAT_ACCOUNT: &str = "lynse_qoder_pat";
const LYNSE_API_KEY_ACCOUNT: &str = "lynse_api_key";
const DEFAULT_LYNSE_API_HOST: &str = "https://api.lynse.cn";
const QODER_CHAT_EVENT: &str = "qoder-chat-event";
const QODER_ARTIFACT_SCHEME: &str = "qoder-artifact";
const QODER_ARTIFACT_CACHE_DIR: &str = "qoder-chat-artifacts";
const MAX_CACHED_ARTIFACT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QoderChatConfig {
    configured: bool,
    source: Option<&'static str>,
    agent_id: &'static str,
    environment_id: &'static str,
    lynse_api_key_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QoderChatTurnResult {
    last_event_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QoderFileList {
    data: Vec<QoderFile>,
}

#[derive(Debug, Deserialize)]
struct QoderFile {
    id: String,
    filename: String,
    size_bytes: u64,
    downloadable: bool,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct QoderFileContentLink {
    url: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct QoderChatAttachment {
    id: String,
    name: String,
    r#type: String,
    url: String,
    download_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_url: Option<String>,
}

#[derive(Debug, PartialEq)]
struct SseFrame {
    id: Option<String>,
    event: Option<String>,
    data: String,
}

fn stored_secret(account: &str) -> CommandResult<Option<String>> {
    let entry = keyring::Entry::new(SECRET_SERVICE, account).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn qoder_pat() -> CommandResult<(String, &'static str)> {
    if let Some(value) = stored_secret(QODER_PAT_ACCOUNT)? {
        let value = value.trim();
        if !value.is_empty() {
            return Ok((value.to_owned(), "keychain"));
        }
    }
    Err("Qoder PAT is not configured. Add it in Lynse Settings.".to_owned())
}

fn qoder_session_environment(lynse_api_host: Option<&str>) -> CommandResult<String> {
    let api_key = stored_secret(LYNSE_API_KEY_ACCOUNT)?
        .filter(|value| !value.trim().is_empty())
        .ok_or("Lynse API key is not configured. Add it in Lynse Settings.".to_owned())?;
    let api_host = lynse_api_host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_LYNSE_API_HOST);
    format_session_environment(api_key.trim(), api_host)
}

fn format_session_environment(api_key: &str, api_host: &str) -> CommandResult<String> {
    if [api_key, api_host]
        .iter()
        .any(|value| value.contains(';') || value.contains('\n') || value.contains('\r'))
    {
        return Err("Lynse Qoder environment values contain unsupported delimiters".to_owned());
    }
    Ok(format!("LYNSE_API_KEY={api_key};LYNSE_API_HOST={api_host}"))
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

fn completed_turn_payload(final_messages: &[String], attachments: &[QoderChatAttachment]) -> Value {
    let text = final_messages.join("");
    let mut payload = json!({"type": "done"});
    if !text.is_empty() {
        payload["text"] = json!(text);
    }
    if !attachments.is_empty() {
        payload["attachments"] = json!(attachments);
    }
    payload
}

fn artifact_type(filename: &str) -> Option<&'static str> {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Some("image"),
        "pdf" => Some("pdf"),
        "html" | "htm" => Some("html"),
        _ => None,
    }
}

fn artifact_filenames(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut remaining = text;
    while let Some(index) = remaining.find("/data/") {
        let candidate = &remaining[index..];
        let end = candidate
            .char_indices()
            .skip(1)
            .find_map(|(offset, character)| {
                (character.is_whitespace()
                    || matches!(
                        character,
                        '`' | '"' | '\'' | ')' | ']' | '}' | '|' | '<' | '>' | '，' | '。'
                    ))
                .then_some(offset)
            })
            .unwrap_or(candidate.len());
        let path = &candidate[..end];
        if artifact_type(path).is_some() {
            if let Some(name) = Path::new(path).file_name().and_then(|value| value.to_str()) {
                if !names.iter().any(|existing| existing == name) {
                    names.push(name.to_owned());
                }
            }
        }
        remaining = &candidate[end..];
    }
    names
}

fn artifact_cache_filename(file: &QoderFile) -> Option<String> {
    let extension = Path::new(&file.filename)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    artifact_type(&file.filename)?;
    Some(format!("{}.{}", file.id, extension))
}

fn valid_cache_filename(filename: &str) -> bool {
    let Some((file_id, extension)) = filename.rsplit_once('.') else {
        return false;
    };
    file_id.starts_with("file_")
        && file_id[5..]
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        && artifact_type(&format!("file.{extension}")).is_some()
}

fn artifact_content_type(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8".to_owned(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_owned(),
    }
}

async fn list_session_files(
    client: &Client,
    pat: &str,
    session_id: &str,
) -> CommandResult<Vec<QoderFile>> {
    let mut files_url =
        Url::parse(&format!("{QODER_BASE_URL}/files")).map_err(|error| error.to_string())?;
    files_url
        .query_pairs_mut()
        .append_pair("scope_id", session_id)
        .append_pair("limit", "100");
    let response = client
        .get(files_url)
        .bearer_auth(pat)
        .send()
        .await
        .map_err(|error| format!("Qoder list generated files failed: {error}"))?;
    let response = expect_success(response, "list generated files").await?;
    let payload: QoderFileList = response.json().await.map_err(|error| error.to_string())?;
    Ok(payload.data)
}

fn is_turn_artifact(
    file: &QoderFile,
    requested_names: &[String],
    previous_file_ids: Option<&HashSet<String>>,
) -> bool {
    let filename = Path::new(&file.filename)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&file.filename);
    let explicitly_requested = requested_names.iter().any(|name| name == filename);
    let created_this_turn = previous_file_ids.is_some_and(|ids| !ids.contains(&file.id));
    file.downloadable
        && file.size_bytes <= MAX_CACHED_ARTIFACT_BYTES
        && artifact_type(filename).is_some()
        && (explicitly_requested || created_this_turn)
}

async fn cache_turn_artifacts(
    app: &AppHandle,
    client: &Client,
    pat: &str,
    session_id: &str,
    final_text: &str,
    previous_file_ids: Option<&HashSet<String>>,
) -> CommandResult<Vec<QoderChatAttachment>> {
    let requested_names = artifact_filenames(final_text);
    if requested_names.is_empty() && previous_file_ids.is_none() {
        return Ok(Vec::new());
    }

    let mut matched_files = Vec::new();
    let attempts = if requested_names.is_empty() { 1 } else { 3 };
    for attempt in 0..attempts {
        matched_files = list_session_files(client, pat, session_id)
            .await?
            .into_iter()
            .filter(|file| is_turn_artifact(file, &requested_names, previous_file_ids))
            .collect();
        matched_files.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        if !matched_files.is_empty() || attempt + 1 == attempts {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join(QODER_ARTIFACT_CACHE_DIR);
    fs::create_dir_all(&cache_directory).map_err(|error| error.to_string())?;

    let mut attachments = Vec::new();
    let mut cached_names = HashSet::new();
    for file in matched_files {
        let display_name = Path::new(&file.filename)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&file.filename)
            .to_owned();
        if !cached_names.insert(display_name.clone()) {
            continue;
        }
        let Some(cache_filename) = artifact_cache_filename(&file) else {
            continue;
        };
        let cache_path = cache_directory.join(&cache_filename);
        if !cache_path.exists() {
            let response = client
                .get(format!("{QODER_BASE_URL}/files/{}/content", file.id))
                .bearer_auth(pat)
                .send()
                .await
                .map_err(|error| format!("Qoder get generated file link failed: {error}"))?;
            let response = expect_success(response, "get generated file link").await?;
            let link: QoderFileContentLink =
                response.json().await.map_err(|error| error.to_string())?;
            let response = client
                .get(link.url)
                .send()
                .await
                .map_err(|error| format!("Qoder download generated file failed: {error}"))?;
            let response = expect_success(response, "download generated file").await?;
            if response
                .content_length()
                .is_some_and(|size| size > MAX_CACHED_ARTIFACT_BYTES)
            {
                continue;
            }
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            if bytes.len() as u64 > MAX_CACHED_ARTIFACT_BYTES {
                continue;
            }
            fs::write(&cache_path, &bytes).map_err(|error| error.to_string())?;
        }

        let kind = artifact_type(&file.filename).unwrap_or("file").to_owned();
        let url = format!("{QODER_ARTIFACT_SCHEME}://localhost/{cache_filename}");
        attachments.push(QoderChatAttachment {
            id: file.id,
            name: display_name,
            r#type: kind.clone(),
            url: url.clone(),
            download_url: url.clone(),
            thumbnail_url: (kind == "image").then_some(url),
        });
    }
    Ok(attachments)
}

pub(crate) fn qoder_artifact_response<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> HttpResponse<Vec<u8>> {
    let filename = request.uri().path().trim_start_matches('/');
    if !valid_cache_filename(filename) {
        return HttpResponse::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap();
    }
    let Ok(cache_directory) = context.app_handle().path().app_cache_dir() else {
        return HttpResponse::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap();
    };
    let path = cache_directory
        .join(QODER_ARTIFACT_CACHE_DIR)
        .join(filename);
    let Ok(total) = fs::metadata(&path).map(|metadata| metadata.len()) else {
        return HttpResponse::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap();
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.split_once('-'));
    let start = range
        .and_then(|(start, _)| start.parse::<u64>().ok())
        .unwrap_or(0)
        .min(total.saturating_sub(1));
    let end = range
        .and_then(|(_, end)| end.parse::<u64>().ok())
        .unwrap_or_else(|| total.saturating_sub(1))
        .min(total.saturating_sub(1))
        .max(start);
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => {
            return HttpResponse::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Vec::new())
                .unwrap()
        }
    };
    let mut body = vec![0; end.saturating_sub(start).saturating_add(1) as usize];
    if file
        .seek(SeekFrom::Start(start))
        .and_then(|_| file.read_exact(&mut body))
        .is_err()
    {
        return HttpResponse::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .unwrap();
    }
    let partial = range.is_some();
    let mut response = HttpResponse::builder()
        .header(
            header::CONTENT_TYPE,
            artifact_content_type(&path),
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len());
    if partial {
        response = response.status(StatusCode::PARTIAL_CONTENT).header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    response.body(body).unwrap()
}

fn stream_url(session_id: &str) -> CommandResult<Url> {
    let mut url = Url::parse(&format!(
        "{QODER_BASE_URL}/sessions/{session_id}/events/stream"
    ))
    .map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("event_deltas[]", "agent.message");
        query.append_pair("event_deltas[]", "agent.thinking");
        query.append_pair("delta_flush_interval_ms", "100");
    }
    Ok(url)
}

#[tauri::command]
pub(crate) fn qoder_chat_config() -> CommandResult<QoderChatConfig> {
    let lynse_api_key_configured =
        stored_secret(LYNSE_API_KEY_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty());
    match qoder_pat() {
        Ok((_, source)) => Ok(QoderChatConfig {
            configured: true,
            source: Some(source),
            agent_id: QODER_AGENT_ID,
            environment_id: QODER_ENVIRONMENT_ID,
            lynse_api_key_configured,
        }),
        Err(message) if message.starts_with("Qoder PAT is not configured") => Ok(QoderChatConfig {
            configured: false,
            source: None,
            agent_id: QODER_AGENT_ID,
            environment_id: QODER_ENVIRONMENT_ID,
            lynse_api_key_configured,
        }),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) async fn qoder_chat_save_pat(pat: String) -> CommandResult<QoderChatConfig> {
    let pat = pat.trim();
    if pat.is_empty() {
        return Err("Qoder PAT cannot be empty".to_owned());
    }
    let response = qoder_client()?
        .get(format!("{QODER_BASE_URL}/agents?limit=1"))
        .bearer_auth(pat)
        .send()
        .await
        .map_err(|error| format!("Qoder PAT validation failed: {error}"))?;
    expect_success(response, "validate PAT").await?;
    let entry = keyring::Entry::new(SECRET_SERVICE, QODER_PAT_ACCOUNT)
        .map_err(|error| error.to_string())?;
    entry.set_password(pat).map_err(|error| error.to_string())?;
    let config = qoder_chat_config()?;
    if !config.configured {
        return Err("Qoder PAT could not be read after saving".to_owned());
    }
    Ok(config)
}

#[tauri::command]
pub(crate) async fn qoder_chat_create_session(
    share_lynse_api_key: bool,
    lynse_api_host: Option<String>,
) -> CommandResult<String> {
    let (pat, _) = qoder_pat()?;
    let mut body = json!({
        "agent": QODER_AGENT_ID,
        "environment_id": QODER_ENVIRONMENT_ID,
    });
    if share_lynse_api_key {
        body["environment_variables"] =
            json!(qoder_session_environment(lynse_api_host.as_deref())?);
    }
    let response = qoder_client()?
        .post(format!("{QODER_BASE_URL}/sessions"))
        .bearer_auth(pat)
        .json(&body)
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
    let previous_file_ids = match list_session_files(&client, &pat, &session_id).await {
        Ok(files) => Some(
            files
                .into_iter()
                .map(|file| file.id)
                .collect::<HashSet<_>>(),
        ),
        Err(error) => {
            eprintln!("Failed to snapshot Qoder session files before turn: {error}");
            None
        }
    };
    emit_chat_event(
        &app,
        &request_id,
        json!({"type": "status", "text": "小灵助手 · 正在连接事件流"}),
    )?;

    // Subscribe before sending the message so no incremental delta is missed.
    let mut stream_request = client
        .get(stream_url(&session_id)?)
        .bearer_auth(&pat)
        .header(reqwest::header::ACCEPT, "text/event-stream");
    if let Some(after_event_id) = after_event_id.as_deref().filter(|value| !value.is_empty()) {
        stream_request = stream_request.header("Last-Event-ID", after_event_id);
    }
    let stream_response = stream_request
        .send()
        .await
        .map_err(|error| format!("Qoder event stream failed: {error}"))?;
    let stream_response = expect_success(stream_response, "open event stream").await?;
    emit_chat_event(
        &app,
        &request_id,
        json!({"type": "status", "text": "小灵助手 · 正在发送请求"}),
    )?;

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
    emit_chat_event(
        &app,
        &request_id,
        json!({"type": "status", "text": "小灵助手 · 已发送，正在等待回复"}),
    )?;

    let mut bytes_stream = stream_response.bytes_stream();
    let mut buffer = Vec::new();
    let mut last_event_id = after_event_id;
    let mut delta_message_ids = std::collections::HashSet::new();
    let mut final_messages = Vec::new();
    let started_at = Instant::now();
    let mut current_activity = "小灵助手 · 正在处理".to_owned();
    let mut progress_tick = tokio::time::interval(Duration::from_secs(8));
    progress_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    progress_tick.tick().await;

    loop {
        let chunk = tokio::select! {
            chunk = bytes_stream.next() => match chunk {
                Some(chunk) => chunk,
                None => break,
            },
            _ = progress_tick.tick() => {
                emit_chat_event(
                    &app,
                    &request_id,
                    json!({
                        "type": "status",
                        "text": format!("{} · 已用时 {} 秒", current_activity, started_at.elapsed().as_secs()),
                    }),
                )?;
                continue;
            }
        };
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
                    Some("agent.thinking") => {
                        current_activity = "小灵助手 · 正在思考".to_owned();
                        emit_chat_event(
                            &app,
                            &request_id,
                            json!({"type": "status", "text": current_activity}),
                        )?;
                    }
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
                "session.status_running" => {
                    current_activity = "小灵助手 · 正在运行".to_owned();
                    emit_chat_event(
                        &app,
                        &request_id,
                        json!({"type": "status", "text": current_activity}),
                    )?;
                }
                "agent.thinking" => {
                    current_activity = "小灵助手 · 正在思考".to_owned();
                    emit_chat_event(
                        &app,
                        &request_id,
                        json!({"type": "status", "text": current_activity}),
                    )?;
                }
                "agent.tool_use" | "agent.mcp_tool_use" | "agent.custom_tool_use" => {
                    let name = payload
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    current_activity = format!("小灵助手 · 正在调用 {name}");
                    emit_chat_event(
                        &app,
                        &request_id,
                        json!({"type": "status", "text": current_activity}),
                    )?;
                }
                "agent.tool_result" | "agent.mcp_tool_result" => {
                    current_activity = "小灵助手 · 正在整理工具结果".to_owned();
                    emit_chat_event(
                        &app,
                        &request_id,
                        json!({"type": "status", "text": current_activity}),
                    )?;
                }
                "span.model_request_start" => {
                    current_activity = "小灵助手 · 正在组织内容".to_owned();
                    emit_chat_event(
                        &app,
                        &request_id,
                        json!({"type": "status", "text": current_activity}),
                    )?;
                }
                "agent.message" => {
                    let frame_id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .or(frame.id.as_deref());
                    let text = content_text(&payload);
                    if !text.is_empty() {
                        final_messages.push(text.clone());
                        if !frame_id.is_some_and(|id| delta_message_ids.contains(id)) {
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
                    let final_text = final_messages.join("");
                    let artifact_names = artifact_filenames(&final_text);
                    let attachments = if artifact_names.is_empty() && previous_file_ids.is_none() {
                        Vec::new()
                    } else {
                        emit_chat_event(
                            &app,
                            &request_id,
                            json!({"type": "status", "text": "小灵助手 · 正在检查生成的附件"}),
                        )?;
                        match cache_turn_artifacts(
                            &app,
                            &client,
                            &pat,
                            &session_id,
                            &final_text,
                            previous_file_ids.as_ref(),
                        )
                        .await
                        {
                            Ok(attachments) => attachments,
                            Err(error) => {
                                eprintln!("Failed to cache Qoder generated attachments: {error}");
                                Vec::new()
                            }
                        }
                    };
                    emit_chat_event(
                        &app,
                        &request_id,
                        completed_turn_payload(&final_messages, &attachments),
                    )?;
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
    fn builds_incremental_stream_url() {
        let url = stream_url("sess_test").unwrap();
        let query = url.query_pairs().collect::<Vec<_>>();
        assert!(query.contains(&("event_deltas[]".into(), "agent.message".into())));
        assert!(query.contains(&("event_deltas[]".into(), "agent.thinking".into())));
        assert!(query.contains(&("delta_flush_interval_ms".into(), "100".into())));
        assert!(!query.iter().any(|(key, _)| key == "after_id"));
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
    fn uses_buffered_agent_messages_as_the_completed_turn_text() {
        assert_eq!(
            completed_turn_payload(
                &[
                    "first complete message".to_owned(),
                    " and final answer".to_owned(),
                ],
                &[]
            ),
            json!({"type": "done", "text": "first complete message and final answer"})
        );
        assert_eq!(completed_turn_payload(&[], &[]), json!({"type": "done"}));
    }

    #[test]
    fn extracts_supported_qoder_artifact_paths() {
        assert_eq!(
            artifact_filenames(
                "| PNG | `/data/card_0805_meeting.png` (659 KB) |\n| PDF | /data/report.pdf |\n| HTML | `/data/report.html` |"
            ),
            vec!["card_0805_meeting.png", "report.pdf", "report.html"]
        );
    }

    #[test]
    fn only_accepts_safe_cached_artifact_names() {
        assert!(valid_cache_filename("file_019e3bb8.png"));
        assert!(valid_cache_filename("file_019e3bb8.pdf"));
        assert!(valid_cache_filename("file_019e3bb8.html"));
        assert!(!valid_cache_filename("../file_019e3bb8.png"));
        assert!(!valid_cache_filename("file_019e3bb8.exe"));
    }

    #[test]
    fn serves_html_artifacts_as_utf8() {
        assert_eq!(
            artifact_content_type(Path::new("meeting-report.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(artifact_content_type(Path::new("meeting-card.png")), "image/png");
    }

    #[test]
    fn detects_new_session_artifacts_when_the_reply_omits_a_path() {
        let previous_file_ids = HashSet::from(["file_old".to_owned()]);
        let new_png = QoderFile {
            id: "file_new".to_owned(),
            filename: "meeting-report.png".to_owned(),
            size_bytes: 659_000,
            downloadable: true,
            created_at: "2026-08-20T01:00:00Z".to_owned(),
        };
        let old_png = QoderFile {
            id: "file_old".to_owned(),
            filename: "previous-report.png".to_owned(),
            size_bytes: 512_000,
            downloadable: true,
            created_at: "2026-08-19T01:00:00Z".to_owned(),
        };
        let new_html = QoderFile {
            id: "file_new_html".to_owned(),
            filename: "meeting-report.html".to_owned(),
            size_bytes: 128_000,
            downloadable: true,
            created_at: "2026-08-20T01:00:01Z".to_owned(),
        };

        assert!(is_turn_artifact(&new_png, &[], Some(&previous_file_ids)));
        assert!(is_turn_artifact(&new_html, &[], Some(&previous_file_ids)));
        assert!(!is_turn_artifact(&old_png, &[], Some(&previous_file_ids)));
    }

    #[test]
    fn extracts_qoder_error_message() {
        assert_eq!(
            error_message(r#"{"error":{"type":"authentication_error","message":"PAT expired"}}"#)
                .as_deref(),
            Some("PAT expired")
        );
    }

    #[test]
    fn formats_lynse_cli_session_environment() {
        assert_eq!(
            format_session_environment("dk_test", "https://api.lynse.cn").unwrap(),
            "LYNSE_API_KEY=dk_test;LYNSE_API_HOST=https://api.lynse.cn"
        );
        assert!(format_session_environment("dk_test;bad", "https://api.lynse.cn").is_err());
    }
}
