use crate::{app_data_dir, now, save_store_value, update_store_value, CommandResult};
use futures_util::{SinkExt, StreamExt};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(target_os = "macos")]
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

const LIVE_EVENT: &str = "live-translation-event";
const PCM_FRAME_BYTES: usize = 640;
const AUDIO_HEADER_BYTES: usize = 19;

fn decode_audio_header(
    header: &[u8; AUDIO_HEADER_BYTES],
) -> CommandResult<(AudioSource, u64, u64, usize)> {
    let source = AudioSource::from_byte(header[0]).ok_or("invalid audio source")?;
    let sequence = u64::from_le_bytes(header[1..9].try_into().expect("sequence header"));
    let elapsed_ms = u64::from_le_bytes(header[9..17].try_into().expect("elapsed header"));
    let length = u16::from_le_bytes(header[17..19].try_into().expect("length header")) as usize;
    if length != PCM_FRAME_BYTES {
        return Err(format!("invalid PCM frame length: {length}"));
    }
    Ok((source, sequence, elapsed_ms, length))
}

/// Push one encoded PCM frame (16kHz / mono / 16-bit, 640 bytes) into the
/// per-source route that feeds the translation websocket. Shared by the macOS
/// (Unix socket) and Windows (cpal) audio capture paths so both produce
/// exactly the same on-wire format.
fn enqueue_audio(
    session: &LiveSession,
    source: AudioSource,
    elapsed_ms: u64,
    payload: Vec<u8>,
) {
    session
        .last_elapsed_ms
        .fetch_max(elapsed_ms.saturating_add(20), Ordering::Relaxed);
    if let Some(sender) = session
        .routes
        .read()
        .expect("live routes lock")
        .get(&source)
        .cloned()
    {
        let _ = sender.send(WsCommand::Audio(payload));
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSource {
    Mic,
    System,
}

impl AudioSource {
    fn from_byte(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Mic),
            1 => Some(Self::System),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Mic => "我",
            Self::System => "远端",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDescriptor {
    source: AudioSource,
    url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    session_id: String,
    title: String,
    source_language: String,
    target_language: String,
    epoch: u32,
    connections: Vec<ConnectionDescriptor>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRequest {
    session_id: String,
    epoch: u32,
    connections: Vec<ConnectionDescriptor>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    microphone: String,
    system_audio: String,
    restart_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSegment {
    id: String,
    session_id: String,
    epoch: u32,
    source: AudioSource,
    recognized_text: String,
    translated_text: String,
    start_ms: u64,
    end_ms: Option<u64>,
    is_final: bool,
    provider_stream_id: Option<String>,
    task_id: Option<String>,
    echo_of: Option<String>,
    #[serde(default, skip_serializing)]
    recognized_final: bool,
    #[serde(default, skip_serializing)]
    translated_final: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    state: String,
    session_id: Option<String>,
    epoch: u32,
    source_language: Option<String>,
    target_language: Option<String>,
    started_at: Option<String>,
    elapsed_ms: u64,
    mic_level: f32,
    system_level: f32,
    segments: Vec<LiveSegment>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedSession {
    session_id: String,
    record_id: String,
    playback_path: String,
    playback_url: String,
    transcript_path: String,
    duration_ms: u64,
    segments: Vec<LiveSegment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryManifest {
    session_id: String,
    title: String,
    source_language: String,
    target_language: String,
    started_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    session_id: String,
    title: String,
    started_at: String,
}

enum WsCommand {
    Audio(Vec<u8>),
    VoiceEnd,
}

pub struct LiveTranslationManager {
    session: Mutex<Option<Arc<LiveSession>>>,
}

impl Default for LiveTranslationManager {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

struct LiveSession {
    session_id: String,
    title: String,
    source_language: String,
    target_language: String,
    started_at: String,
    state: Mutex<String>,
    epoch: AtomicU32,
    epoch_offset_ms: AtomicU64,
    last_elapsed_ms: AtomicU64,
    mic_level: AtomicU32,
    system_level: AtomicU32,
    segments: Mutex<Vec<LiveSegment>>,
    routes: RwLock<HashMap<AudioSource, UnboundedSender<WsCommand>>>,
    child: Mutex<Option<Child>>,
    capture_stop: Arc<AtomicBool>,
    directory: PathBuf,
    socket_path: PathBuf,
}

impl LiveSession {
    fn set_state(&self, state: &str) {
        *self.state.lock().expect("live state lock") = state.to_owned();
    }

    fn snapshot(&self) -> LiveSnapshot {
        LiveSnapshot {
            state: self.state.lock().expect("live state lock").clone(),
            session_id: Some(self.session_id.clone()),
            epoch: self.epoch.load(Ordering::Relaxed),
            source_language: Some(self.source_language.clone()),
            target_language: Some(self.target_language.clone()),
            started_at: Some(self.started_at.clone()),
            elapsed_ms: self.last_elapsed_ms.load(Ordering::Relaxed),
            mic_level: f32::from_bits(self.mic_level.load(Ordering::Relaxed)),
            system_level: f32::from_bits(self.system_level.load(Ordering::Relaxed)),
            segments: self.segments.lock().expect("live segments lock").clone(),
        }
    }
}

fn idle_snapshot() -> LiveSnapshot {
    LiveSnapshot {
        state: "idle".to_owned(),
        session_id: None,
        epoch: 0,
        source_language: None,
        target_language: None,
        started_at: None,
        elapsed_ms: 0,
        mic_level: 0.0,
        system_level: 0.0,
        segments: Vec::new(),
    }
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn recovery_root(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(app_data_dir(app)?
        .join("live-translations")
        .join("recovery"))
}

fn emit_snapshot(app: &AppHandle, session: &LiveSession) {
    let _ = app.emit(
        LIVE_EVENT,
        json!({ "type": "state", "snapshot": session.snapshot() }),
    );
}

fn emit_error(app: &AppHandle, source: Option<AudioSource>, message: impl Into<String>) {
    let _ = app.emit(
        LIVE_EVENT,
        json!({ "type": "error", "source": source, "message": message.into() }),
    );
}

fn emit_stream_state(app: &AppHandle, source: AudioSource, state: &str, epoch: u32) {
    let _ = app.emit(
        LIVE_EVENT,
        json!({ "type": "streamState", "source": source, "state": state, "epoch": epoch }),
    );
}

#[cfg(target_os = "macos")]
fn sidecar_command(app: &AppHandle) -> CommandResult<Command> {
    let path = crate::stt::sidecar_path(app, "audio-capture")?;
    let mut command = Command::new(path);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            let _ = libc::setsid();
            Ok(())
        });
    }
    Ok(command)
}

#[cfg(target_os = "macos")]
fn run_permission_command(app: &AppHandle, argument: &str) -> CommandResult<PermissionStatus> {
    let output = sidecar_command(app)?
        .arg(argument)
        .output()
        .map_err(|error| format!("failed to run audio-capture: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or("audio-capture returned no permission status")?;
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("invalid permission status: {error}"))?;
    Ok(PermissionStatus {
        microphone: value
            .get("microphone")
            .and_then(Value::as_str)
            .unwrap_or("denied")
            .to_owned(),
        system_audio: value
            .get("systemAudio")
            .and_then(Value::as_str)
            .unwrap_or("denied")
            .to_owned(),
        restart_required: value
            .get("restartRequired")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

#[tauri::command]
pub fn live_translation_permissions(app: AppHandle) -> CommandResult<PermissionStatus> {
    #[cfg(target_os = "macos")]
    return run_permission_command(&app, "--permission-status");
    #[cfg(target_os = "windows")]
    return Ok(PermissionStatus {
        microphone: "granted".to_owned(),
        system_audio: "denied".to_owned(),
        restart_required: false,
    });
}

#[tauri::command]
pub fn live_translation_request_permission(
    app: AppHandle,
    kind: String,
) -> CommandResult<PermissionStatus> {
    #[cfg(target_os = "macos")]
    match kind.as_str() {
        "microphone" => return run_permission_command(&app, "--request-microphone"),
        "systemAudio" => return run_permission_command(&app, "--request-system-audio"),
        _ => return Err("permission kind must be microphone or systemAudio".to_owned()),
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (app, kind);
        return Ok(PermissionStatus {
            microphone: "granted".to_owned(),
            system_audio: "denied".to_owned(),
            restart_required: false,
        });
    }
}

#[tauri::command]
pub fn live_translation_state(state: State<LiveTranslationManager>) -> CommandResult<LiveSnapshot> {
    Ok(state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .as_ref()
        .map(|session| session.snapshot())
        .unwrap_or_else(idle_snapshot))
}

#[tauri::command]
pub async fn live_translation_start(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
    request: StartRequest,
) -> CommandResult<LiveSnapshot> {
    if !valid_session_id(&request.session_id)
        || request.source_language.trim().is_empty()
        || request.target_language.trim().is_empty()
    {
        return Err("session id and language pair are required".to_owned());
    }
    if request.connections.is_empty() {
        return Err("at least one signed translation connection is required".to_owned());
    }
    validate_connections(&request.connections)?;
    #[cfg(target_os = "macos")]
    if run_permission_command(&app, "--permission-status")?.microphone != "granted" {
        return Err("microphone permission is required before recording".to_owned());
    }
    {
        let guard = state
            .session
            .lock()
            .map_err(|_| "live session lock is poisoned")?;
        if guard.is_some() {
            return Err("a live translation session is already active".to_owned());
        }
    }
    let directory = recovery_root(&app)?.join(&request.session_id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let macos_audio = {
        let socket_path =
            std::env::temp_dir().join(format!("lynse-live-{}.sock", uuid::Uuid::new_v4()));
        let _ = fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path)
            .map_err(|error| format!("bind audio IPC: {error}"))?;
        (socket_path, listener)
    };

    let session = Arc::new(LiveSession {
        session_id: request.session_id.clone(),
        title: request.title.trim().to_owned(),
        source_language: request.source_language.clone(),
        target_language: request.target_language.clone(),
        started_at: now(),
        state: Mutex::new("connecting".to_owned()),
        epoch: AtomicU32::new(request.epoch),
        epoch_offset_ms: AtomicU64::new(0),
        last_elapsed_ms: AtomicU64::new(0),
        mic_level: AtomicU32::new(0.0f32.to_bits()),
        system_level: AtomicU32::new(0.0f32.to_bits()),
        segments: Mutex::new(Vec::new()),
        routes: RwLock::new(HashMap::new()),
        child: Mutex::new(None),
        capture_stop: Arc::new(AtomicBool::new(true)),
        directory,
        socket_path: {
            #[cfg(target_os = "macos")]
            {
                macos_audio.0.clone()
            }
            #[cfg(target_os = "windows")]
            {
                PathBuf::new()
            }
        },
    });
    let manifest = RecoveryManifest {
        session_id: session.session_id.clone(),
        title: session.title.clone(),
        source_language: session.source_language.clone(),
        target_language: session.target_language.clone(),
        started_at: session.started_at.clone(),
    };
    fs::write(
        session.directory.join("session.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    spawn_connections(&app, &session, request.epoch, 0, request.connections)?;

    #[cfg(target_os = "macos")]
    {
        let mut command = sidecar_command(&app)?;
        command
            .arg("--socket")
            .arg(&macos_audio.0)
            .arg("--out")
            .arg(&session.directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                voice_end(&session);
                let _ = fs::remove_file(&macos_audio.0);
                return Err(format!("spawn audio-capture: {error}"));
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or("audio-capture stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("audio-capture stderr unavailable")?;
        *session
            .child
            .lock()
            .map_err(|_| "live child lock is poisoned")? = Some(child);
        spawn_audio_reader(app.clone(), session.clone(), macos_audio.1);
        spawn_control_reader(app.clone(), session.clone(), stdout);
        spawn_stderr_reader(app.clone(), stderr);
    }
    #[cfg(target_os = "windows")]
    {
        if let Err(error) = start_windows_capture(&app, &session) {
            voice_end(&session);
            return Err(error);
        }
    }

    *state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")? = Some(session.clone());
    emit_snapshot(&app, &session);
    Ok(session.snapshot())
}

#[cfg(target_os = "macos")]
fn spawn_audio_reader(app: AppHandle, session: Arc<LiveSession>, listener: UnixListener) {
    thread::spawn(move || {
        let result = (|| -> CommandResult<()> {
            let (mut stream, _) = listener
                .accept()
                .map_err(|error| format!("accept audio IPC: {error}"))?;
            loop {
                let mut header = [0u8; AUDIO_HEADER_BYTES];
                match stream.read_exact(&mut header) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(error) => return Err(format!("read audio IPC header: {error}")),
                }
                let (source, _sequence, elapsed_ms, length) = decode_audio_header(&header)?;
                let mut payload = vec![0u8; length];
                stream
                    .read_exact(&mut payload)
                    .map_err(|error| format!("read audio IPC payload: {error}"))?;
                enqueue_audio(&session, source, elapsed_ms, payload);
            }
            Ok(())
        })();
        let _ = fs::remove_file(&session.socket_path);
        if let Err(error) = result {
            emit_error(&app, None, error);
        }
    });
}

#[cfg(target_os = "macos")]
fn spawn_control_reader(
    app: AppHandle,
    session: Arc<LiveSession>,
    stdout: impl Read + Send + 'static,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match value.get("event").and_then(Value::as_str) {
                Some("ready" | "resumed") => {
                    session.set_state("recording");
                    emit_snapshot(&app, &session);
                }
                Some("paused") => {
                    session.set_state("paused");
                    emit_snapshot(&app, &session);
                }
                Some("levels") => {
                    let mic = value.get("mic").and_then(Value::as_f64).unwrap_or_default() as f32;
                    let system = value
                        .get("system")
                        .and_then(Value::as_f64)
                        .unwrap_or_default() as f32;
                    let elapsed = value
                        .get("elapsedMs")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    session.mic_level.store(mic.to_bits(), Ordering::Relaxed);
                    session
                        .system_level
                        .store(system.to_bits(), Ordering::Relaxed);
                    session
                        .last_elapsed_ms
                        .fetch_max(elapsed, Ordering::Relaxed);
                    let _ = app.emit(LIVE_EVENT, json!({ "type": "levels", "mic": mic, "system": system, "elapsedMs": elapsed }));
                }
                Some("error") => emit_error(
                    &app,
                    None,
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("audio capture failed"),
                ),
                _ => {}
            }
        }
        let current = session.state.lock().expect("live state lock").clone();
        if !matches!(current.as_str(), "stopping" | "idle") {
            session.set_state("failed");
            emit_error(&app, None, "音频采集进程意外退出，录音已保留在恢复目录。")
        }
    });
}

#[cfg(target_os = "macos")]
fn spawn_stderr_reader(app: AppHandle, stderr: impl Read + Send + 'static) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(message) = line.strip_prefix("lynse-error: ") {
                emit_error(&app, None, message);
            } else {
                eprintln!("audio-capture: {line}");
            }
        }
    });
}

fn spawn_connections(
    app: &AppHandle,
    session: &Arc<LiveSession>,
    epoch: u32,
    epoch_offset_ms: u64,
    connections: Vec<ConnectionDescriptor>,
) -> CommandResult<()> {
    validate_connections(&connections)?;
    let mut routes = session
        .routes
        .write()
        .map_err(|_| "live routes lock is poisoned")?;
    for connection in connections {
        let (sender, receiver) = unbounded_channel();
        routes.insert(connection.source, sender);
        let app = app.clone();
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            websocket_loop(
                app,
                session,
                connection.source,
                epoch,
                epoch_offset_ms,
                connection.url,
                receiver,
            )
            .await;
        });
    }
    Ok(())
}

fn validate_connections(connections: &[ConnectionDescriptor]) -> CommandResult<()> {
    let mut sources = HashSet::new();
    for connection in connections {
        if !sources.insert(connection.source) {
            return Err(format!(
                "duplicate {:?} translation connection",
                connection.source
            ));
        }
        if !connection.url.starts_with("wss://")
            && !connection.url.starts_with("ws://127.0.0.1")
            && !connection.url.starts_with("ws://localhost")
        {
            return Err("translation connection must use wss://".to_owned());
        }
    }
    Ok(())
}

async fn websocket_loop(
    app: AppHandle,
    session: Arc<LiveSession>,
    source: AudioSource,
    epoch: u32,
    epoch_offset_ms: u64,
    url: String,
    mut receiver: UnboundedReceiver<WsCommand>,
) {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        emit_stream_state(&app, source, "connecting", epoch);
        match tokio_tungstenite::connect_async(&url).await {
            Ok((socket, _)) => {
                emit_stream_state(&app, source, "connected", epoch);
                let (mut writer, mut reader) = socket.split();
                let mut finishing: Option<tokio::time::Instant> = None;
                loop {
                    tokio::select! {
                        command = receiver.recv(), if finishing.is_none() => {
                            match command {
                                Some(WsCommand::Audio(payload)) => {
                                    if let Err(error) = writer.send(Message::Binary(payload.into())).await {
                                        emit_error(&app, Some(source), format!("发送音频失败：{error}"));
                                        break;
                                    }
                                }
                                Some(WsCommand::VoiceEnd) | None => {
                                    let _ = writer.send(Message::Text(r#"{"method":"voiceEnd"}"#.into())).await;
                                    finishing = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                                }
                            }
                        }
                        incoming = reader.next() => {
                            match incoming {
                                Some(Ok(Message::Text(text))) => handle_provider_message(&app, &session, source, epoch, epoch_offset_ms, text.as_ref()),
                                Some(Ok(Message::Close(_))) | None => {
                                    if finishing.is_some() {
                                        emit_stream_state(&app, source, "closed", epoch);
                                        return;
                                    }
                                    emit_error(&app, Some(source), "翻译连接由服务端关闭，正在重连。");
                                    break;
                                }
                                Some(Ok(_)) => {}
                                Some(Err(error)) => {
                                    emit_error(&app, Some(source), format!("翻译连接中断：{error}"));
                                    break;
                                }
                            }
                        }
                        _ = async {
                            if let Some(deadline) = finishing { tokio::time::sleep_until(deadline).await }
                        }, if finishing.is_some() => {
                            let _ = writer.close().await;
                            emit_stream_state(&app, source, "closed", epoch);
                            return;
                        }
                    }
                }
            }
            Err(error) => emit_error(
                &app,
                Some(source),
                format!("实时翻译连接失败（第 {attempt} 次）：{error}"),
            ),
        }
        if attempt >= 3 {
            emit_stream_state(&app, source, "failed", epoch);
            return;
        }
        tokio::time::sleep(Duration::from_millis(500 * (1u64 << (attempt - 1)))).await;
    }
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn value_u64(value: &Value, key: &str) -> u64 {
    value_string(value, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or_default()
}

enum ProviderEmission {
    Segment(LiveSegment),
    Segments(Vec<LiveSegment>),
}

fn save_recovery_segments(session: &LiveSession, segments: &[LiveSegment]) {
    if let Ok(data) = serde_json::to_vec_pretty(segments) {
        let _ = fs::write(session.directory.join("segments.json"), data);
    }
}

fn handle_provider_message(
    app: &AppHandle,
    session: &LiveSession,
    source: AudioSource,
    epoch: u32,
    epoch_offset_ms: u64,
    text: &str,
) {
    match apply_provider_message(session, source, epoch, epoch_offset_ms, text) {
        Some(ProviderEmission::Segment(segment)) => {
            let _ = app.emit(LIVE_EVENT, json!({ "type": "segment", "segment": segment }));
        }
        Some(ProviderEmission::Segments(segments)) => {
            let _ = app.emit(
                LIVE_EVENT,
                json!({ "type": "segments", "segments": segments }),
            );
        }
        None => {}
    }
}

/// Apply the recognized/translated text from a provider message to a segment,
/// honouring the "final results win, interim results are ignored once final"
/// rule used throughout the live-translation handling.
fn apply_method_text(segment: &mut LiveSegment, method: &str, text: &str) {
    match method {
        "recognizedResult" => {
            segment.recognized_text = text.to_owned();
            segment.recognized_final = true;
        }
        "recognizedTempResult" => {
            if !segment.recognized_final {
                segment.recognized_text = text.to_owned();
            }
        }
        "translatedResult" => {
            segment.translated_text = text.to_owned();
            segment.translated_final = true;
        }
        "translatedTempResult" => {
            if !segment.translated_final {
                segment.translated_text = text.to_owned();
            }
        }
        _ => {}
    }
}

fn apply_provider_message(
    session: &LiveSession,
    source: AudioSource,
    epoch: u32,
    epoch_offset_ms: u64,
    text: &str,
) -> Option<ProviderEmission> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return None;
    };
    if !matches!(
        method,
        "recognizedResult" | "recognizedTempResult" | "translatedResult" | "translatedTempResult"
    ) {
        return None;
    }
    let is_recognized = matches!(method, "recognizedResult" | "recognizedTempResult");
    let is_final_method = matches!(method, "recognizedResult" | "translatedResult");
    let stream_id = value_string(&value, "streamId");
    let start_ms = epoch_offset_ms.saturating_add(value_u64(&value, "startTs"));
    let raw_end = value_u64(&value, "endTs");
    let end_ms = (raw_end > 0).then(|| epoch_offset_ms.saturating_add(raw_end));
    let incoming = value_string(&value, if is_recognized { "asr" } else { "trans" })
        .unwrap_or_default();
    // Utterance key: prefer the provider task id, fall back to the start
    // timestamp (stable per utterance for most providers).
    let task_id = value_string(&value, "taskId")
        .unwrap_or_else(|| value_u64(&value, "startTs").to_string());

    let mut segments = session.segments.lock().expect("live segments lock");

    // The currently open (non-final) utterance being coalesced for this source
    // and stream. Interim results for the same utterance must refresh this block
    // in place rather than spawning a new one — otherwise the provider's rolling
    // buffer (each update echoes the previous sentence) renders as a stack of
    // duplicated cards on the frontend.
    let open_pos = segments.iter().rposition(|segment| {
        !segment.is_final && segment.source == source && segment.provider_stream_id == stream_id
    });

    // Continue the open utterance when the message carries the same task id, or
    // (different task id, e.g. a re-keyed rolling buffer) when its text begins
    // with what we already have. Otherwise it is a genuinely new utterance:
    // close the open block as best-effort and start a fresh one.
    let continues_open = match open_pos {
        None => false,
        Some(pos) => {
            let same_task = segments[pos].task_id.as_deref() == Some(task_id.as_str());
            if same_task {
                true
            } else {
                let current = if is_recognized {
                    segments[pos].recognized_text.as_str()
                } else {
                    segments[pos].translated_text.as_str()
                };
                current.is_empty() || incoming.starts_with(current)
            }
        }
    };

    let index = if continues_open {
        open_pos.expect("open_pos is Some when continues_open")
    } else {
        if let Some(pos) = open_pos {
            // Close the previous open utterance so it stops being the coalescing
            // target. Its text is kept intact.
            segments[pos].is_final = true;
        }
        segments.push(LiveSegment {
            id: format!(
                "{}:{epoch}:{:?}:{}:{}",
                session.session_id,
                source,
                stream_id.as_deref().unwrap_or("unknown"),
                uuid::Uuid::new_v4(),
            ),
            session_id: session.session_id.clone(),
            epoch,
            source,
            recognized_text: String::new(),
            translated_text: String::new(),
            start_ms,
            end_ms,
            is_final: false,
            provider_stream_id: stream_id.clone(),
            task_id: Some(task_id.clone()),
            echo_of: None,
            recognized_final: false,
            translated_final: false,
        });
        segments.len() - 1
    };

    let segment = &mut segments[index];
    segment.start_ms = segment.start_ms.min(start_ms);
    if end_ms.is_some() {
        segment.end_ms = end_ms;
    }
    segment.provider_stream_id = stream_id.clone();
    segment.task_id = Some(task_id);
    apply_method_text(segment, method, &incoming);
    segment.is_final = segment.recognized_final && segment.translated_final;

    if is_final_method {
        deduplicate_echoes(&mut segments);
        segments.sort_by_key(|segment| {
            (
                segment.start_ms,
                matches!(segment.source, AudioSource::System),
            )
        });
        let snapshot = segments.clone();
        save_recovery_segments(session, &snapshot);
        drop(segments);
        Some(ProviderEmission::Segments(snapshot))
    } else {
        let updated = segment.clone();
        drop(segments);
        Some(ProviderEmission::Segment(updated))
    }
}

fn deduplicate_echoes(segments: &mut [LiveSegment]) {
    for segment in segments
        .iter_mut()
        .filter(|segment| segment.source == AudioSource::Mic)
    {
        segment.echo_of = None;
    }
    let systems: Vec<(String, String, u64)> = segments
        .iter()
        .filter(|segment| {
            segment.source == AudioSource::System
                && segment.recognized_final
                && !segment.recognized_text.trim().is_empty()
        })
        .map(|segment| {
            (
                segment.id.clone(),
                segment.recognized_text.clone(),
                segment.start_ms,
            )
        })
        .collect();
    for mic in segments
        .iter_mut()
        .filter(|segment| segment.source == AudioSource::Mic && segment.recognized_final)
    {
        let mic_units = comparison_units(&mic.recognized_text);
        if mic_units.len() < 3 {
            continue;
        }
        let lower = mic.start_ms.saturating_sub(5_000);
        let upper = mic.start_ms.saturating_add(15_000);
        if let Some((id, _, _)) = systems.iter().find(|(_, text, start)| {
            *start >= lower
                && *start <= upper
                && containment(&mic_units, &comparison_units(text)) >= 0.6
        }) {
            mic.echo_of = Some(id.clone());
        }
    }
}

fn comparison_units(text: &str) -> Vec<String> {
    let normalized: Vec<char> = text
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect();
    let has_cjk = normalized.iter().any(|character| matches!(*character as u32, 0x3040..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7af));
    if has_cjk {
        return normalized
            .windows(2)
            .map(|window| window.iter().collect())
            .collect();
    }
    text.to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| token.len() > 1)
        .map(str::to_owned)
        .collect()
}

fn containment(left: &[String], right: &[String]) -> f32 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let left: HashSet<&str> = left.iter().map(String::as_str).collect();
    let right: HashSet<&str> = right.iter().map(String::as_str).collect();
    let denominator = left.len().min(right.len());
    if denominator == 0 {
        return 0.0;
    }
    left.intersection(&right).count() as f32 / denominator as f32
}

#[cfg(target_os = "macos")]
fn signal_child(session: &LiveSession, signal: i32) -> CommandResult<()> {
    let pid = session
        .child
        .lock()
        .map_err(|_| "live child lock is poisoned")?
        .as_ref()
        .map(Child::id)
        .ok_or("audio-capture is not running")?;
    let result = unsafe { libc::kill(pid as i32, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(target_os = "windows")]
fn signal_child(_session: &LiveSession, _signal: i32) -> CommandResult<()> {
    // Windows captures audio in-process via cpal, so there is no sidecar
    // child process to signal. Stop/pause is driven by the `capture_stop`
    // flag instead.
    Ok(())
}

fn voice_end(session: &LiveSession) {
    let mut routes = session.routes.write().expect("live routes lock");
    for sender in routes.values() {
        let _ = sender.send(WsCommand::VoiceEnd);
    }
    routes.clear();
}

#[tauri::command]
pub async fn live_translation_pause(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
) -> CommandResult<LiveSnapshot> {
    let session = state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .clone()
        .ok_or("no live translation session")?;
    if session
        .state
        .lock()
        .map_err(|_| "live state lock is poisoned")?
        .as_str()
        != "recording"
    {
        return Err("session is not recording".to_owned());
    }
    session.set_state("paused");
    signal_child(&session, libc::SIGUSR1)?;
    voice_end(&session);
    emit_snapshot(&app, &session);
    tokio::time::sleep(Duration::from_millis(3_100)).await;
    Ok(session.snapshot())
}

#[tauri::command]
pub async fn live_translation_resume(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
    request: ResumeRequest,
) -> CommandResult<LiveSnapshot> {
    let session = state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .clone()
        .ok_or("no live translation session")?;
    if session.session_id != request.session_id {
        return Err("resume session id does not match".to_owned());
    }
    if session
        .state
        .lock()
        .map_err(|_| "live state lock is poisoned")?
        .as_str()
        != "paused"
    {
        return Err("session is not paused".to_owned());
    }
    validate_connections(&request.connections)?;
    let offset = session.last_elapsed_ms.load(Ordering::Relaxed);
    session.epoch.store(request.epoch, Ordering::Relaxed);
    session.epoch_offset_ms.store(offset, Ordering::Relaxed);
    session.set_state("connecting");
    spawn_connections(&app, &session, request.epoch, offset, request.connections)?;
    signal_child(&session, libc::SIGUSR2)?;
    emit_snapshot(&app, &session);
    Ok(session.snapshot())
}

#[tauri::command]
pub async fn live_translation_stop(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
) -> CommandResult<CompletedSession> {
    let session = state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .take()
        .ok_or("no live translation session")?;
    session.set_state("stopping");
    emit_snapshot(&app, &session);
    session.capture_stop.store(false, Ordering::Relaxed);
    let _ = signal_child(&session, libc::SIGTERM);

    let child = session
        .child
        .lock()
        .map_err(|_| "live child lock is poisoned")?
        .take();
    if let Some(mut child) = child {
        tauri::async_runtime::spawn_blocking(move || {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(50))
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                }
            }
        })
        .await
        .map_err(|error| error.to_string())?;
    }

    voice_end(&session);
    tokio::time::sleep(Duration::from_millis(3_200)).await;
    let completed = persist_session(&app, &session)?;
    session.set_state("idle");
    let _ = app.emit(
        LIVE_EVENT,
        json!({ "type": "completed", "session": completed }),
    );
    let _ = app.emit(
        LIVE_EVENT,
        json!({ "type": "state", "snapshot": idle_snapshot() }),
    );
    Ok(completed)
}

fn persist_session(app: &AppHandle, session: &LiveSession) -> CommandResult<CompletedSession> {
    let mic = session.directory.join("mic.wav");
    let system = session.directory.join("system.wav");
    let playback = session.directory.join("playback.wav");
    build_playback_wav(
        mic.exists().then_some(mic.as_path()),
        system.exists().then_some(system.as_path()),
        &playback,
    )?;

    let mut segments: Vec<LiveSegment> = session
        .segments
        .lock()
        .map_err(|_| "live segments lock is poisoned")?
        .iter()
        .filter(|segment| segment.echo_of.is_none() && !segment.recognized_text.trim().is_empty())
        .cloned()
        .collect();
    segments.sort_by_key(|segment| {
        (
            segment.start_ms,
            matches!(segment.source, AudioSource::System),
        )
    });
    let duration_ms = session.last_elapsed_ms.load(Ordering::Relaxed);
    let transcript_path = session.directory.join("transcript.json");
    fs::write(
        &transcript_path,
        serde_json::to_vec_pretty(&json!({
            "sessionId": session.session_id,
            "sourceLanguage": session.source_language,
            "targetLanguage": session.target_language,
            "durationMs": duration_ms,
            "segments": segments,
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let mut timeline = String::new();
    for segment in &segments {
        timeline.push_str(&serde_json::to_string(segment).map_err(|error| error.to_string())?);
        timeline.push('\n');
    }
    fs::write(session.directory.join("timeline.jsonl"), timeline)
        .map_err(|error| error.to_string())?;

    let transcript_text = segments
        .iter()
        .map(|segment| {
            let translated = if segment.translated_text.trim().is_empty() {
                ""
            } else {
                segment.translated_text.trim()
            };
            if translated.is_empty() {
                format!(
                    "{}：{}",
                    segment.source.label(),
                    segment.recognized_text.trim()
                )
            } else {
                format!(
                    "{}：{}\n{}",
                    segment.source.label(),
                    translated,
                    segment.recognized_text.trim()
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let record_id = format!("local:live:{}", session.session_id);
    let local_segments: Vec<Value> = segments.iter().map(|segment| json!({
        "id": segment.id,
        "text": segment.recognized_text,
        "translatedText": segment.translated_text,
        "source": segment.source,
        "speakerId": match segment.source { AudioSource::Mic => "local", AudioSource::System => "remote" },
        "speakerName": segment.source.label(),
        "startMs": segment.start_ms,
        "endMs": segment.end_ms,
        "isFinal": segment.is_final,
        "sourceLanguage": session.source_language,
        "targetLanguage": session.target_language,
    })).collect();
    let completed_at = now();
    save_store_value(
        app,
        "local-transcriptions",
        json!({
            "id": record_id,
            "title": if session.title.is_empty() { "实时翻译" } else { &session.title },
            "sourcePath": playback,
            "createdAt": session.started_at,
            "updatedAt": completed_at,
            "startedAt": session.started_at,
            "completedAt": completed_at,
            "transcriptText": transcript_text,
            "status": "completed",
            "progressPhase": "completed",
            "durationMs": duration_ms,
            "engine": "ilivedata_rtvt",
            "modelId": "ilivedata-rtvt",
            "language": session.source_language,
            "targetLanguage": session.target_language,
            "liveSessionId": session.session_id,
            "syncStatus": "pending",
            "segments": local_segments,
        }),
    )?;

    Ok(CompletedSession {
        session_id: session.session_id.clone(),
        record_id: record_id.clone(),
        playback_path: playback.to_string_lossy().into_owned(),
        playback_url: format!(
            "local-media://localhost/{}",
            utf8_percent_encode(&record_id, NON_ALPHANUMERIC)
        ),
        transcript_path: transcript_path.to_string_lossy().into_owned(),
        duration_ms,
        segments,
    })
}

fn build_playback_wav(
    mic: Option<&Path>,
    system: Option<&Path>,
    output: &Path,
) -> CommandResult<()> {
    let mic_samples = mic.map(read_pcm16_wav).transpose()?.unwrap_or_default();
    let system_samples = system.map(read_pcm16_wav).transpose()?.unwrap_or_default();
    if mic_samples.is_empty() && system_samples.is_empty() {
        return Err("no captured audio was written".to_owned());
    }
    let length = mic_samples.len().max(system_samples.len());
    let mut mixed = Vec::with_capacity(length);
    for index in 0..length {
        let mic = mic_samples.get(index).copied().unwrap_or(0) as i32;
        let system = system_samples.get(index).copied().unwrap_or(0) as i32;
        let sample = if mic_samples.is_empty() {
            system
        } else if system_samples.is_empty() {
            mic
        } else {
            (mic + system) / 2
        };
        mixed.push(sample.clamp(i16::MIN as i32, i16::MAX as i32) as i16);
    }
    write_pcm16_wav(output, &mixed)
}

fn read_pcm16_wav(path: &Path) -> CommandResult<Vec<i16>> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("invalid WAV: {}", path.display()));
    }
    Ok(bytes[44..]
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect())
}

fn write_pcm16_wav(path: &Path, samples: &[i16]) -> CommandResult<()> {
    let data_bytes = u32::try_from(samples.len().saturating_mul(2))
        .map_err(|_| "recording is too large for WAV")?;
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    file.write_all(b"RIFF").map_err(|error| error.to_string())?;
    file.write_all(&(36 + data_bytes).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(b"WAVEfmt ")
        .map_err(|error| error.to_string())?;
    file.write_all(&16u32.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&1u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&1u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&16_000u32.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&32_000u32.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&2u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&16u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(b"data").map_err(|error| error.to_string())?;
    file.write_all(&data_bytes.to_le_bytes())
        .map_err(|error| error.to_string())?;
    for sample in samples {
        file.write_all(&sample.to_le_bytes())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn live_translation_finalize_local(
    app: AppHandle,
    session_id: String,
    synced: bool,
) -> CommandResult<()> {
    let record_id = format!("local:live:{session_id}");
    let mut patch = Map::new();
    patch.insert(
        "syncStatus".to_owned(),
        json!(if synced { "synced" } else { "pending" }),
    );
    patch.insert("updatedAt".to_owned(), json!(now()));
    update_store_value(&app, "local-transcriptions", &record_id, patch)?
        .ok_or("live translation record not found")?;
    if synced {
        if !valid_session_id(&session_id) {
            return Err("invalid live translation session id".to_owned());
        }
        let directory = recovery_root(&app)?.join(session_id);
        for name in ["mic.wav", "system.wav"] {
            let path = directory.join(name);
            if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn live_translation_recoveries(
    app: AppHandle,
    state: State<LiveTranslationManager>,
) -> CommandResult<Vec<RecoverySummary>> {
    let active_session_id = state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .as_ref()
        .map(|session| session.session_id.clone());
    let root = recovery_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut recoveries = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let directory = entry.map_err(|error| error.to_string())?.path();
        if !directory.is_dir()
            || (!directory.join("mic.wav").exists() && !directory.join("system.wav").exists())
        {
            continue;
        }
        let Ok(data) = fs::read(directory.join("session.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<RecoveryManifest>(&data) else {
            continue;
        };
        if active_session_id.as_deref() == Some(manifest.session_id.as_str()) {
            continue;
        }
        recoveries.push(RecoverySummary {
            session_id: manifest.session_id,
            title: manifest.title,
            started_at: manifest.started_at,
        });
    }
    recoveries.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    Ok(recoveries)
}

#[tauri::command]
pub async fn live_translation_recover(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
    session_id: String,
) -> CommandResult<CompletedSession> {
    if !valid_session_id(&session_id) {
        return Err("invalid live translation session id".to_owned());
    }
    if state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .is_some()
    {
        return Err(
            "finish the active live translation before recovering another session".to_owned(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || recover_session(&app, &session_id))
        .await
        .map_err(|error| error.to_string())?
}

fn recover_session(app: &AppHandle, session_id: &str) -> CommandResult<CompletedSession> {
    let directory = recovery_root(app)?.join(session_id);
    let manifest: RecoveryManifest = serde_json::from_slice(
        &fs::read(directory.join("session.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if manifest.session_id != session_id {
        return Err("recovery manifest does not match its directory".to_owned());
    }
    let mut segments: Vec<LiveSegment> = fs::read(directory.join("segments.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    for segment in &mut segments {
        if segment.is_final {
            segment.recognized_final = true;
            segment.translated_final = true;
        }
    }
    let duration_ms = [directory.join("mic.wav"), directory.join("system.wav")]
        .into_iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len().saturating_sub(44).saturating_mul(1_000) / 32_000)
        .max()
        .unwrap_or_default();
    let session = LiveSession {
        session_id: manifest.session_id,
        title: manifest.title,
        source_language: manifest.source_language,
        target_language: manifest.target_language,
        started_at: manifest.started_at,
        state: Mutex::new("stopping".to_owned()),
        epoch: AtomicU32::new(0),
        epoch_offset_ms: AtomicU64::new(0),
        last_elapsed_ms: AtomicU64::new(duration_ms),
        mic_level: AtomicU32::new(0),
        system_level: AtomicU32::new(0),
        segments: Mutex::new(segments),
        routes: RwLock::new(HashMap::new()),
        child: Mutex::new(None),
        directory,
        socket_path: PathBuf::new(),
        capture_stop: Arc::new(AtomicBool::new(true)),
    };
    persist_session(app, &session)
}

#[tauri::command]
pub fn live_translation_show_subtitles(app: AppHandle, show: bool) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window("live-subtitles") {
        if show {
            window.show().map_err(|error| error.to_string())?;
        } else {
            window.hide().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    if !show {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "live-subtitles",
        WebviewUrl::App("index.html?window=live-subtitles".into()),
    )
    .title("Lynse Live Subtitles")
    .inner_size(720.0, 190.0)
    .min_inner_size(420.0, 140.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(true)
    .skip_taskbar(true)
    .center()
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Windows live-translation audio capture (stage 1: microphone).
//
// On Windows there is no Swift `audio-capture` sidecar. We capture the default
// microphone in-process with `cpal`, resample to the 16 kHz / mono / 16-bit
// format the rest of the pipeline expects, and feed the exact same 640-byte PCM
// frames through `enqueue_audio` so the cloud translation path is identical to
// macOS. System-audio loopback capture is a follow-up (stage 2).
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
fn start_windows_capture(app: &AppHandle, session: &Arc<LiveSession>) -> CommandResult<()> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::Sample;

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "未找到默认麦克风输入设备".to_owned())?;
    let config = device
        .default_input_config()
        .map_err(|error| format!("获取麦克风输入配置失败：{error}"))?;
    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let channels = stream_config.channels as usize;
    let in_rate = stream_config.sample_rate.0;
    let start = Instant::now();
    let leftover = Arc::new(Mutex::new(Vec::<u8>::new()));

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let leftover = leftover.clone();
            let session_ref = session.clone();
            let app_ref = app.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| {
                        feed_samples(data, channels, in_rate, &start, &leftover, &session_ref)
                    },
                    move |error| {
                        emit_error(
                            &app_ref,
                            Some(AudioSource::Mic),
                            format!("麦克风音频流错误：{error}"),
                        )
                    },
                    None,
                )
                .map_err(|error| format!("创建麦克风输入流失败：{error}"))?
        }
        cpal::SampleFormat::I16 => {
            let leftover = leftover.clone();
            let session_ref = session.clone();
            let app_ref = app.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _| {
                        feed_samples(data, channels, in_rate, &start, &leftover, &session_ref)
                    },
                    move |error| {
                        emit_error(
                            &app_ref,
                            Some(AudioSource::Mic),
                            format!("麦克风音频流错误：{error}"),
                        )
                    },
                    None,
                )
                .map_err(|error| format!("创建麦克风输入流失败：{error}"))?
        }
        cpal::SampleFormat::U16 => {
            let leftover = leftover.clone();
            let session_ref = session.clone();
            let app_ref = app.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _| {
                        feed_samples(data, channels, in_rate, &start, &leftover, &session_ref)
                    },
                    move |error| {
                        emit_error(
                            &app_ref,
                            Some(AudioSource::Mic),
                            format!("麦克风音频流错误：{error}"),
                        )
                    },
                    None,
                )
                .map_err(|error| format!("创建麦克风输入流失败：{error}"))?
        }
        _ => return Err("不支持的麦克风采样格式".to_owned()),
    };

    stream
        .play()
        .map_err(|error| format!("启动麦克风输入流失败：{error}"))?;

    // Keep the stream alive (and the device capturing) until the session stops.
    while session.capture_stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn feed_samples<T: Sample>(
    data: &[T],
    channels: usize,
    in_rate: u32,
    start: &Instant,
    leftover: &Arc<Mutex<Vec<u8>>>,
    session: &Arc<LiveSession>,
) {
    if !session.capture_stop.load(Ordering::Relaxed) {
        return;
    }
    let mono: Vec<f32> = data
        .chunks(channels)
        .map(|frame| {
            let sum: f32 = frame.iter().map(|sample| sample.to_f32()).sum();
            sum / channels as f32
        })
        .collect();
    let resampled = resample_linear(&mono, in_rate, 16_000);
    let mut pcm: Vec<u8> = Vec::with_capacity(resampled.len() * 2);
    for sample in resampled {
        let value = (sample.clamp(-1.0, 1.0) * 32_767.0) as i16;
        pcm.extend_from_slice(&value.to_le_bytes());
    }
    let mut buffer = leftover.lock().expect("live audio buffer lock");
    buffer.extend_from_slice(&pcm);
    let elapsed = start.elapsed().as_millis() as u64;
    while buffer.len() >= 640 {
        let frame: Vec<u8> = buffer.drain(..640).collect();
        enqueue_audio(session, AudioSource::Mic, elapsed, frame);
    }
}

#[cfg(target_os = "windows")]
fn resample_linear(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if in_rate == out_rate {
        return input.to_vec();
    }
    let step = in_rate as f64 / out_rate as f64;
    let out_len = (input.len() as f64 / step).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * step;
        let idx = pos as usize;
        let frac = (pos - idx as f64) as f32;
        let a = *input.get(idx).unwrap_or(&0.0);
        let b = *input.get(idx + 1).unwrap_or(&a);
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_session() -> LiveSession {
        LiveSession {
            session_id: "session".to_owned(),
            title: "test".to_owned(),
            source_language: "zh".to_owned(),
            target_language: "en".to_owned(),
            started_at: now(),
            state: Mutex::new("recording".to_owned()),
            epoch: AtomicU32::new(0),
            epoch_offset_ms: AtomicU64::new(0),
            last_elapsed_ms: AtomicU64::new(0),
            mic_level: AtomicU32::new(0),
            system_level: AtomicU32::new(0),
            segments: Mutex::new(Vec::new()),
            routes: RwLock::new(HashMap::new()),
            child: Mutex::new(None),
            capture_stop: Arc::new(AtomicBool::new(true)),
            directory: std::env::temp_dir(),
            socket_path: std::env::temp_dir().join("unused-live-translation-test.sock"),
        }
    }

    fn segment(id: &str, source: AudioSource, text: &str, start_ms: u64) -> LiveSegment {
        LiveSegment {
            id: id.to_owned(),
            session_id: "session".to_owned(),
            epoch: 0,
            source,
            recognized_text: text.to_owned(),
            translated_text: String::new(),
            start_ms,
            end_ms: None,
            is_final: false,
            provider_stream_id: None,
            task_id: None,
            echo_of: None,
            recognized_final: true,
            translated_final: false,
        }
    }

    #[test]
    fn deduplicates_english_system_echo_from_microphone() {
        let mut segments = vec![
            segment(
                "system",
                AudioSource::System,
                "we should ship the release tomorrow",
                1_000,
            ),
            segment("mic", AudioSource::Mic, "ship the release tomorrow", 1_100),
        ];
        deduplicate_echoes(&mut segments);
        assert_eq!(segments[1].echo_of.as_deref(), Some("system"));
    }

    #[test]
    fn decodes_little_endian_audio_ipc_header() {
        let mut header = [0u8; AUDIO_HEADER_BYTES];
        header[0] = 1;
        header[1..9].copy_from_slice(&42u64.to_le_bytes());
        header[9..17].copy_from_slice(&1_234u64.to_le_bytes());
        header[17..19].copy_from_slice(&(PCM_FRAME_BYTES as u16).to_le_bytes());

        let (source, sequence, elapsed_ms, length) = decode_audio_header(&header).unwrap();
        assert_eq!(source, AudioSource::System);
        assert_eq!(sequence, 42);
        assert_eq!(elapsed_ms, 1_234);
        assert_eq!(length, PCM_FRAME_BYTES);
    }

    #[test]
    fn rejects_session_ids_that_can_escape_the_recovery_directory() {
        assert!(valid_session_id("live_2026-07-22.1"));
        assert!(!valid_session_id("../outside"));
        assert!(!valid_session_id("nested/session"));
        assert!(!valid_session_id("session with spaces"));
    }

    #[test]
    fn validates_signed_connection_sources_before_spawning_tasks() {
        let valid = vec![
            ConnectionDescriptor {
                source: AudioSource::Mic,
                url: "wss://example.test/mic".to_owned(),
            },
            ConnectionDescriptor {
                source: AudioSource::System,
                url: "wss://example.test/system".to_owned(),
            },
        ];
        assert!(validate_connections(&valid).is_ok());
        let duplicate = vec![valid[0].clone(), valid[0].clone()];
        assert!(validate_connections(&duplicate).is_err());
        let insecure = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: "ws://example.test/mic".to_owned(),
        }];
        assert!(validate_connections(&insecure).is_err());
    }

    #[test]
    fn replaces_provider_temporary_results_and_offsets_epochs() {
        let session = live_session();
        let recognized_temp = r#"{"method":"recognizedTempResult","streamId":"9","taskId":"3","startTs":"20","endTs":"0","asr":"临时"}"#;
        let translated_temp = r#"{"method":"translatedTempResult","streamId":"9","taskId":"3","startTs":"20","endTs":"0","trans":"temporary"}"#;
        let recognized_final = r#"{"method":"recognizedResult","streamId":"9","taskId":"3","startTs":"20","endTs":"80","asr":"最终"}"#;
        let translated_final = r#"{"method":"translatedResult","streamId":"9","taskId":"3","startTs":"20","endTs":"80","trans":"final"}"#;

        apply_provider_message(&session, AudioSource::Mic, 2, 5_000, recognized_temp).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 2, 5_000, translated_temp).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 2, 5_000, recognized_final).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 2, 5_000, translated_final).unwrap();

        let segments = session.segments.lock().unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].recognized_text, "最终");
        assert_eq!(segments[0].translated_text, "final");
        assert_eq!(segments[0].start_ms, 5_020);
        assert_eq!(segments[0].end_ms, Some(5_080));
        assert!(segments[0].is_final);
        assert!(segments[0].id.contains(":2:Mic:9:"));
    }

    #[test]
    fn coalesces_rolling_buffer_updates_into_one_refreshing_segment() {
        let session = live_session();
        // One utterance streamed as rolling buffers that each re-key with a new
        // task id (the duplication the frontend used to show as separate cards).
        let m1 = r#"{"method":"recognizedTempResult","streamId":"9","taskId":"a1","startTs":"20","endTs":"0","asr":"你好"}"#;
        let m2 = r#"{"method":"recognizedTempResult","streamId":"9","taskId":"a2","startTs":"20","endTs":"0","asr":"你好世界"}"#;
        let m3 = r#"{"method":"recognizedResult","streamId":"9","taskId":"a3","startTs":"20","endTs":"80","asr":"你好世界大家好"}"#;
        apply_provider_message(&session, AudioSource::Mic, 0, 0, m1).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 0, 0, m2).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 0, 0, m3).unwrap();
        let segments = session.segments.lock().unwrap();
        assert_eq!(
            segments.len(),
            1,
            "rolling buffers must coalesce into a single refreshing segment"
        );
        assert_eq!(segments[0].recognized_text, "你好世界大家好");
        assert!(segments[0].recognized_final, "recognized result must finalize");
        assert_eq!(segments[0].translated_text, "", "no translation streamed yet");
        assert!(!segments[0].is_final, "segment stays open until translation finalizes");
    }

    #[test]
    fn splits_into_a_new_segment_when_the_utterance_changes() {
        let session = live_session();
        let u1 = r#"{"method":"recognizedResult","streamId":"9","taskId":"a1","startTs":"20","endTs":"80","asr":"你好世界"}"#;
        let u2 = r#"{"method":"recognizedTempResult","streamId":"9","taskId":"b1","startTs":"200","endTs":"0","asr":"今天天气真好"}"#;
        apply_provider_message(&session, AudioSource::Mic, 0, 0, u1).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 0, 0, u2).unwrap();
        let segments = session.segments.lock().unwrap();
        assert_eq!(segments.len(), 2, "a new utterance must open a new segment");
    }

    #[test]
    fn deduplicates_cjk_echo_but_keeps_short_acknowledgements() {
        let mut segments = vec![
            segment(
                "system",
                AudioSource::System,
                "我们明天下午发布这个版本",
                2_000,
            ),
            segment("echo", AudioSource::Mic, "明天下午发布这个版本", 2_100),
            segment("ack", AudioSource::Mic, "好的", 2_200),
        ];
        deduplicate_echoes(&mut segments);
        assert_eq!(segments[1].echo_of.as_deref(), Some("system"));
        assert_eq!(segments[2].echo_of, None);
    }

    #[test]
    fn writes_and_reads_pcm16_wav() {
        let path =
            std::env::temp_dir().join(format!("lynse-wav-test-{}.wav", uuid::Uuid::new_v4()));
        let samples = vec![i16::MIN, -1, 0, 1, i16::MAX];
        write_pcm16_wav(&path, &samples).unwrap();
        assert_eq!(read_pcm16_wav(&path).unwrap(), samples);
        let _ = fs::remove_file(path);
    }
}
