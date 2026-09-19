use crate::tencent_asr;
use crate::volc_ast;
use crate::{now, remove_store_value, save_store_value, update_store_value, CommandResult};
use futures_util::{SinkExt, StreamExt};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
#[cfg(target_os = "macos")]
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime::JoinHandle;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;

// `Sample` is needed as a trait bound on `feed_samples` (a function signature),
// so the import must be at module scope — a `use` inside the function body is
// not visible to the generic parameter bound. Gated to Windows because cpal is
// a Windows-only dependency.
#[cfg(target_os = "windows")]
use cpal::Sample;

const LIVE_EVENT: &str = "live-translation-event";
pub(crate) const PCM_FRAME_BYTES: usize = 640;
pub(crate) const AUDIO_HEADER_BYTES: usize = 19;

/// Silence watchdog: while a session is recording, a microphone that carries
/// neither recognized speech nor audible level for this long ends the session
/// and saves it — a recording started by accident (or left running after
/// everyone left) still lands in the library instead of growing a silent file.
const SILENCE_AUTO_STOP: Duration = Duration::from_secs(60);
/// How often the watchdog re-checks the silence clock.
const SILENCE_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// Mic peak amplitude (0..1, measured per 200 ms window) below which the room
/// counts as silent. Speech and ordinary handling noise sit well above this.
const MIC_SILENCE_LEVEL: f32 = 0.02;

/// A healthy realtime stream carries provider traffic constantly (interim
/// results during speech, keepalive frames otherwise). After this long without
/// any inbound frame the stream is probed with a websocket ping.
const LIVE_STREAM_PING_AFTER: Duration = Duration::from_secs(15);
/// If the ping probe (or any other traffic) still hasn't arrived this long
/// after it was sent, the TCP path is silently dead — typical after the
/// machine slept through a connection teardown — and the stream reconnects.
const LIVE_STREAM_PONG_GRACE: Duration = Duration::from_secs(10);
/// Upper bound on the reconnect backoff so a long outage keeps probing
/// steadily instead of waiting longer and longer.
const LIVE_RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(15);
/// A single connect attempt is bounded so a half-up network (SYN blackhole,
/// Wi-Fi still re-associating after wake) fails fast into the retry path
/// instead of hanging for the OS default (~75 s).
const LIVE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn decode_audio_header(
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

/// The running live session, reachable from other modules (the recording-card
/// audio feed). Kept in sync with the managed session at start/stop.
static CARD_FEED_TARGET: Mutex<Option<Arc<LiveSession>>> = Mutex::new(None);

fn set_card_feed_target(session: &Arc<LiveSession>) {
    *CARD_FEED_TARGET.lock().expect("card feed lock") = Some(session.clone());
}

fn clear_card_feed_target() {
    *CARD_FEED_TARGET.lock().expect("card feed lock") = None;
}

/// Route decoded recording-card PCM (16 kHz mono Int16) into the active live
/// session as the mic ("我") source, chunked to the same 640-byte frame size
/// the capture sidecar produces. Returns false when no session is running.
pub fn feed_recording_card_pcm(pcm: &[i16], elapsed_ms: u64) -> bool {
    let Some(session) = CARD_FEED_TARGET.lock().expect("card feed lock").clone() else {
        return false;
    };
    for chunk in pcm.chunks(PCM_FRAME_BYTES / 2) {
        if chunk.len() < PCM_FRAME_BYTES / 2 {
            break;
        }
        let mut frame = Vec::with_capacity(PCM_FRAME_BYTES);
        for sample in chunk {
            frame.extend_from_slice(&sample.to_le_bytes());
        }
        enqueue_audio(&session, AudioSource::Mic, elapsed_ms, frame);
    }
    // Mirror the sidecar's mic-level behaviour so the UI meter reacts to the
    // card audio even while the macOS capture sidecar is not feeding "我".
    let sum: f64 = pcm.iter().map(|sample| (*sample as f64 / 32768.0).powi(2)).sum();
    if !pcm.is_empty() {
        let level = ((sum / pcm.len() as f64).sqrt()).min(1.0) as f32;
        session.mic_level.store(level.to_bits(), Ordering::Relaxed);
    }
    true
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
            Self::Mic => "本机",
            Self::System => "远端",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDescriptor {
    source: AudioSource,
    url: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    /// Provider-specific credentials that don't fit the single-key model —
    /// the Tencent ASR provider carries secretId/secretKey/engineType here.
    #[serde(default)]
    extra: Option<HashMap<String, String>>,
}

/// Which on-the-wire protocol a translation connection speaks. All providers
/// converge on the same `LiveSegment` model; only framing and auth differ.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LiveProvider {
    /// iLiveData-style JSON with a `method` discriminator. Also used by the
    /// Lynse backend relay, which mirrors that protocol.
    Direct,
    /// Qwen Live Translate (DashScope) JSON event stream.
    Qwen,
    /// Volcengine AST v4: protobuf over binary websocket frames.
    Volc,
    /// Tencent Cloud real-time ASR: raw PCM frames over a URL-signed
    /// websocket, JSON result frames back. Recognition only — the service
    /// has no translation leg.
    Tencent,
}

impl LiveProvider {
    fn from_name(name: Option<&str>) -> Self {
        match name {
            Some("qwen") => Self::Qwen,
            Some("volc") => Self::Volc,
            Some("tencent") => Self::Tencent,
            _ => Self::Direct,
        }
    }
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
    /// Which capture sources the sidecar should record: "mic" and/or
    /// "system". Absent or empty means both.
    #[serde(default)]
    audio_sources: Vec<String>,
    /// Windows: pin the microphone to this WASAPI endpoint id. Absent
    /// follows the default communications input device.
    #[serde(default)]
    mic_device_id: Option<String>,
    /// Windows: pin the system mixdown to this render endpoint id. Absent
    /// follows the default multimedia output device.
    #[serde(default)]
    system_device_id: Option<String>,
    /// Dual-channel recording (raw tracks + AEC3 on the microphone). Absent
    /// means enabled; `false` rolls back to the legacy 16 kHz pipeline — it
    /// only affects new recordings, existing dual-format ones keep loading.
    #[serde(default)]
    dual_channel: Option<bool>,
}

impl StartRequest {
    fn wants_mic(&self) -> bool {
        self.audio_sources.is_empty() || self.audio_sources.iter().any(|source| source == "mic")
    }

    fn wants_system(&self) -> bool {
        self.audio_sources.is_empty()
            || self.audio_sources.iter().any(|source| source == "system")
    }

    /// Collapse the requested sources into the sidecar's `--sources` value.
    fn sources_argument(&self) -> &'static str {
        let mic = self.wants_mic();
        let system = self
            .audio_sources
            .iter()
            .any(|source| source == "system");
        match (mic, system) {
            (true, false) => "mic",
            (false, true) => "system",
            _ => "both",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRequest {
    session_id: String,
    epoch: u32,
    connections: Vec<ConnectionDescriptor>,
}

/// Switch a running session between pure recording and live
/// transcription/translation without interrupting the audio capture.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModeRequest {
    session_id: String,
    source_language: String,
    target_language: String,
    epoch: u32,
    connections: Vec<ConnectionDescriptor>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub(crate) microphone: String,
    pub(crate) system_audio: String,
    system_audio_required: bool,
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
    /// 1-based speaker index derived from the Volcengine AST `spk_chg` marker.
    /// `None` for providers without speaker-change detection (iLiveData, Qwen).
    speaker: Option<u32>,
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
    /// True when the silence watchdog ended this session rather than the user.
    auto_stopped_silence: bool,
    /// Dual-channel track manifest (engine, degraded intervals, track files).
    /// Absent for legacy-format recordings.
    #[serde(skip_serializing_if = "Option::is_none")]
    tracks: Option<Value>,
    /// True when any span of the recording could not be echo-cancelled.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    aec_degraded: bool,
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

impl LiveTranslationManager {
    /// True while a live translation/recording session exists (connecting,
    /// recording or paused). The inspiration voice capture refuses to start so
    /// the microphone is never driven by two features at once.
    pub fn has_active_session(&self) -> bool {
        self.session
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }
}

struct LiveSession {
    session_id: String,
    title: String,
    /// Mutable so a running session can switch between pure recording and
    /// live transcription/translation (`live_translation_set_mode`) without
    /// interrupting the audio capture sidecar.
    source_language: RwLock<String>,
    target_language: RwLock<String>,
    started_at: String,
    state: Mutex<String>,
    epoch: AtomicU32,
    epoch_offset_ms: AtomicU64,
    last_elapsed_ms: AtomicU64,
    /// Wall-clock (Unix epoch ms) captured when the session started, used to
    /// rebase providers that report utterance timestamps as absolute epoch ms
    /// (iLiveData) onto the recording-relative timeline.
    wall_start_ms: AtomicU64,
    mic_level: AtomicU32,
    system_level: AtomicU32,
    segments: Mutex<Vec<LiveSegment>>,
    routes: RwLock<HashMap<AudioSource, UnboundedSender<WsCommand>>>,
    /// Handles of the spawned translation websocket loops, so they can be
    /// aborted when the mode changes or the session stops.
    handles: Mutex<HashMap<AudioSource, JoinHandle<()>>>,
    child: Mutex<Option<Child>>,
    capture_stop: Arc<AtomicBool>,
    /// False for system-only sessions: no microphone is captured, so the
    /// mic-silence watchdog must not judge (or stop) the recording.
    wants_mic: bool,
    /// Dual-channel recording (raw tracks + AEC). Skips the transcript-level
    /// echo de-duplication (real-time overlaps stay visible) and persists the
    /// track manifest with the recording.
    dual_channel: bool,
    /// False for mic-only sessions: no system mixdown is captured.
    wants_system: bool,
    /// Last instant the session saw evidence of voice — a recognized provider
    /// segment or a mic level above [`MIC_SILENCE_LEVEL`]. Re-based whenever
    /// capture (re)starts so a resume gets a fresh silence window.
    last_voice_at: Mutex<Instant>,
    /// Set by the silence watchdog when it stops the session, so the
    /// completed payload can tell the UI why the recording ended.
    auto_stopped_silence: AtomicBool,
    directory: PathBuf,
    socket_path: PathBuf,
}

impl LiveSession {
    fn set_state(&self, state: &str) {
        *self.state.lock().expect("live state lock") = state.to_owned();
    }

    fn mark_voice_activity(&self) {
        *self.last_voice_at.lock().expect("live last voice lock") = Instant::now();
    }

    fn snapshot(&self) -> LiveSnapshot {
        LiveSnapshot {
            state: self.state.lock().expect("live state lock").clone(),
            session_id: Some(self.session_id.clone()),
            epoch: self.epoch.load(Ordering::Relaxed),
            source_language: Some(self.source_language.read().expect("live source language").clone()),
            target_language: Some(self.target_language.read().expect("live target language").clone()),
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
    crate::vault::content_dir(app, crate::vault::ContentKind::Recordings)
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
pub(crate) fn sidecar_command(app: &AppHandle) -> CommandResult<Command> {
    let path = crate::stt::sidecar_path(app, "audio-capture")?;
    let mut command = Command::new(path);
    // Dev only: detach from the terminal's process group so Ctrl+C in the dev
    // console doesn't kill the capture sidecar. Packaged builds must keep the
    // sidecar a plain child of the app bundle — TCC attributes its capture to
    // the (responsible) main app, which is what makes the microphone grant
    // from `mic_permission` stick under App Store / TestFlight packaging.
    #[cfg(all(unix, debug_assertions))]
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
pub(crate) fn run_permission_command(app: &AppHandle, argument: &str) -> CommandResult<PermissionStatus> {
    let mut command = sidecar_command(app)?;
    let output = command
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
        system_audio_required: true,
        restart_required: value
            .get("restartRequired")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Full permission snapshot with the microphone read in-process (see
/// `mic_permission`): TCC must attribute the mic grant to the Lynse bundle,
/// not to a detached sidecar binary, for App Store / TestFlight packaging.
/// System-audio + restart-required still come from the sidecar, which owns
/// the ScreenCaptureKit session.
#[cfg(target_os = "macos")]
pub(crate) fn read_permission_status(app: &AppHandle) -> CommandResult<PermissionStatus> {
    let mut status = run_permission_command(app, "--permission-status")?;
    status.microphone = crate::mic_permission::authorization_status()
        .as_str()
        .to_owned();
    Ok(status)
}

/// Fires the native TCC microphone prompt in-process (attributed to the
/// Lynse bundle, so the grant sticks under hardened runtime + sandbox) and
/// returns the full permission snapshot afterwards.
#[cfg(target_os = "macos")]
pub(crate) fn request_microphone_permission(
    app: &AppHandle,
) -> CommandResult<PermissionStatus> {
    let _ = crate::mic_permission::request_access();
    read_permission_status(app)
}

/// Windows has no Screen-Capture-style consent for output loopback: the
/// render endpoint can always be captured. The microphone is governed by the
/// privacy master switch (read best-effort from the ConsentStore registry).
#[cfg(target_os = "windows")]
fn read_windows_permission_status() -> PermissionStatus {
    let microphone = match crate::windows_capture::microphone_consent() {
        crate::windows_capture::MicConsent::Denied => "denied",
        // Unreadable registry (atypical builds) proceeds like the OS default
        // (allow): a real capture failure surfaces its own error.
        crate::windows_capture::MicConsent::Granted | crate::windows_capture::MicConsent::Unknown => {
            "granted"
        }
    };
    PermissionStatus {
        microphone: microphone.to_owned(),
        system_audio: "granted".to_owned(),
        system_audio_required: true,
        restart_required: false,
    }
}

#[tauri::command]
pub fn live_translation_permissions(app: AppHandle) -> CommandResult<PermissionStatus> {
    #[cfg(target_os = "macos")]
    return read_permission_status(&app);
    #[cfg(target_os = "windows")]
    return Ok(read_windows_permission_status());
}

#[tauri::command]
pub fn live_translation_request_permission(
    app: AppHandle,
    kind: String,
) -> CommandResult<PermissionStatus> {
    #[cfg(target_os = "macos")]
    match kind.as_str() {
        "microphone" => return request_microphone_permission(&app),
        "systemAudio" => {
            let status = run_permission_command(&app, "--request-system-audio")?;
            if status.system_audio != "granted" {
                open_macos_privacy_pane("screen");
            }
            return Ok(status);
        }
        _ => return Err("permission kind must be microphone or systemAudio".to_owned()),
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        match kind.as_str() {
            // Loopback needs no consent on Windows; route both kinds to the
            // mic privacy page when the mic is denied, otherwise just report.
            "microphone" | "systemAudio" => {
                if kind == "microphone"
                    && crate::windows_capture::microphone_consent()
                        == crate::windows_capture::MicConsent::Denied
                {
                    crate::windows_capture::open_microphone_privacy_settings();
                }
                return Ok(read_windows_permission_status());
            }
            _ => return Err("permission kind must be microphone or systemAudio".to_owned()),
        }
    }
}

/// On macOS, jump straight to the relevant Privacy & Security pane so the user
/// only has to flip the switch. Used when a recording attempt lacks the
/// required TCC grant (microphone or screen & system-audio recording).
#[cfg(target_os = "macos")]
pub(crate) fn open_macos_privacy_pane(kind: &str) {
    let anchor = match kind {
        "microphone" => "Privacy_Microphone",
        _ => "Privacy_ScreenCapture",
    };
    let _ = Command::new("open")
        .arg(format!(
            "x-apple.systempreferences:com.apple.preference.security?{anchor}"
        ))
        .spawn();
}

/// Endpoint lists for the recording settings pickers. Windows returns the
/// real WASAPI endpoints (stable ids + friendly names + defaults); other
/// platforms return empty lists so the UI can hide the pickers.
#[tauri::command]
pub fn live_translation_audio_devices() -> CommandResult<Value> {
    #[cfg(target_os = "windows")]
    return serde_json::to_value(crate::windows_capture::enumerate_devices())
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "windows"))]
    return Ok(json!({
        "inputs": [],
        "outputs": [],
        "defaultInput": null,
        "defaultOutput": null,
    }));
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
    // Pure recording mode (no translation connection) is allowed — it only
    // captures audio locally without any cloud API key.
    validate_connections(&request.connections)?;
    log::info!(
        "Live translation start requested: session={} sources={} title={:?}",
        request.session_id,
        request.sources_argument(),
        request.title.trim()
    );
    #[cfg(target_os = "macos")]
    {
        // First, surface the native TCC prompts so the OS dialog actually
        // appears and a "Lynse" entry is created in System Settings (the
        // microphone one is asked in-process — see `mic_permission`). Without
        // this the user is sent to the privacy pane where nothing is listed
        // yet, leaving them with nothing to toggle — the entry only
        // materialises after the OS prompt has fired at least once.
        let permissions = read_permission_status(&app)?;
        // In system-only mode the microphone is never captured, so its
        // permission is neither requested nor required.
        let needs_mic = request.wants_mic() && permissions.microphone != "granted";
        let needs_screen = permissions.system_audio != "granted";
        if needs_mic || needs_screen {
            if needs_mic {
                let _ = crate::mic_permission::request_access();
            }
            if needs_screen {
                let _ = run_permission_command(&app, "--request-system-audio");
            }
        }
        // Re-read the actual grant state. Screen Recording only takes effect
        // after a full app restart even once the user clicks Allow, so we still
        // send the user to the pane and ask for a restart.
        let after = read_permission_status(&app)?;
        if request.wants_mic() && after.microphone != "granted" {
            open_macos_privacy_pane("microphone");
            return Err(
                "缺少麦克风权限。请在系统弹出的对话框中点击「允许」（或在「隐私与安全性 → 麦克风」中允许 Lynse），然后重新启动 Lynse。"
                    .to_owned(),
            );
        }
        // The audio-capture sidecar always pulls audio through ScreenCaptureKit
        // (SCStream) — even for pure microphone recording — so the "Screen &
        // System Audio Recording" TCC grant is required in every mode. Without
        // it the sidecar exits immediately and no audio is ever captured, which
        // would otherwise surface as a silent "recording" with no audio.
        if after.system_audio != "granted" {
            open_macos_privacy_pane("screen");
            return Err(
                "缺少“屏幕与系统音频录制”权限。请在系统弹出的对话框中点击「允许」（或在「隐私与安全性 → 屏幕录制」中允许 Lynse），然后完全退出并重新启动 Lynse。"
                    .to_owned(),
            );
        }
    }
    {
        let guard = state
            .session
            .lock()
            .map_err(|_| "live session lock is poisoned")?;
        if let Some(existing) = guard.as_ref() {
            // Idempotent start: a session is already running (often still in the
            // transient "connecting" state right after the previous start). Return
            // its snapshot so the UI can sync to the live session instead of
            // erroring with "a live translation session is already active".
            return Ok(existing.snapshot());
        }
    }
    let directory = recovery_root(&app)?.join(&request.session_id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let macos_audio = {
        let socket_path =
            std::env::temp_dir().join(format!("l-{}.sock", uuid::Uuid::new_v4().simple()));
        let _ = fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path)
            .map_err(|error| format!("bind audio IPC: {error}"))?;
        (socket_path, listener)
    };

    let session = Arc::new(LiveSession {
        session_id: request.session_id.clone(),
        title: request.title.trim().to_owned(),
        source_language: RwLock::new(request.source_language.clone()),
        target_language: RwLock::new(request.target_language.clone()),
        started_at: now(),
        state: Mutex::new("connecting".to_owned()),
        epoch: AtomicU32::new(request.epoch),
        epoch_offset_ms: AtomicU64::new(0),
        last_elapsed_ms: AtomicU64::new(0),
        wall_start_ms: AtomicU64::new(wall_clock_ms()),
        mic_level: AtomicU32::new(0.0f32.to_bits()),
        system_level: AtomicU32::new(0.0f32.to_bits()),
        segments: Mutex::new(Vec::new()),
        routes: RwLock::new(HashMap::new()),
        handles: Mutex::new(HashMap::new()),
        child: Mutex::new(None),
        capture_stop: Arc::new(AtomicBool::new(true)),
        wants_mic: request.wants_mic(),
        wants_system: request.wants_system(),
        // Cross-platform feature switch: macOS gates `--aec` on it; Windows
        // gates the AEC bridge + raw tracks (see CaptureConfig::aec_enabled).
        dual_channel: request.dual_channel.unwrap_or(true),
        last_voice_at: Mutex::new(Instant::now()),
        auto_stopped_silence: AtomicBool::new(false),
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
        source_language: session.source_language.read().expect("live source language").clone(),
        target_language: session.target_language.read().expect("live target language").clone(),
        started_at: session.started_at.clone(),
    };
    fs::write(
        session.directory.join("session.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    // Computed before `request.connections` is moved into spawn_connections.
    let sources_argument = request.sources_argument();
    spawn_connections(&app, &session, request.epoch, 0, request.connections)?;

    #[cfg(target_os = "macos")]
    {
        let mut command = sidecar_command(&app)?;
        command
            .arg("--socket")
            .arg(&macos_audio.0)
            .arg("--out")
            .arg(&session.directory)
            .arg("--sources")
            .arg(&sources_argument)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if session.dual_channel {
            command.arg("--aec");
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                voice_end(&session);
                let _ = fs::remove_file(&macos_audio.0);
                return Err(format!("spawn audio-capture: {error}"));
            }
        };
        log::info!(
            "Live translation capture spawned: session={} socket={} sources={sources_argument}",
            session.session_id,
            session.socket_path.display()
        );
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
        // Run capture off the async runtime (mirrors macOS, where the sidecar
        // is spawned detached). The blocking engine event pump must not run
        // on the command's future.
        let win_app = app.clone();
        let win_session = session.clone();
        let win_config = crate::windows_capture::CaptureConfig {
            mic_endpoint: request.mic_device_id.clone(),
            system_endpoint: request.system_device_id.clone(),
            // RAW keeps driver effects from stacking under our processing;
            // the engine falls back to shared mode and records the downgrade.
            raw_mic: true,
            // The dual_channel=false rollback runs the legacy pipeline: no
            // AEC bridge, no raw tracks (matches macOS `--sources` without
            // `--aec`).
            aec_enabled: session.dual_channel,
        };
        thread::spawn(move || {
            if let Err(error) = start_windows_capture(&win_app, &win_session, win_config) {
                voice_end(&win_session);
                emit_error(&win_app, None, error);
            }
        });
    }

    *state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")? = Some(session.clone());
    spawn_silence_watchdog(app.clone(), session.clone());
    set_card_feed_target(&session);
    emit_snapshot(&app, &session);
    // The island is the tray-side control surface: only pop it when the main
    // window is out of sight (hidden to the tray or Dock-minimized). While the
    // main window is on screen, the recording page and the in-app float dock
    // own the controls, and the island would just duplicate them.
    if !main_window_visible(&app) {
        set_recording_island_visible(&app, true);
    }
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
                    log::info!(
                        "Live translation {} (session={})",
                        if value.get("event").and_then(Value::as_str) == Some("ready") {
                            "recording started"
                        } else {
                            "recording resumed"
                        },
                        session.session_id
                    );
                    session.set_state("recording");
                    // A fresh capture (re)start also restarts the silence
                    // window, so a long pause never bleeds into the resumed
                    // session's watchdog budget.
                    session.mark_voice_activity();
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
                    let mic_suppressed = value
                        .get("micSuppressed")
                        .and_then(Value::as_bool)
                        .unwrap_or_default();
                    session.mic_level.store(mic.to_bits(), Ordering::Relaxed);
                    session
                        .system_level
                        .store(system.to_bits(), Ordering::Relaxed);
                    session
                        .last_elapsed_ms
                        .fetch_max(elapsed, Ordering::Relaxed);
                    // Sound on the microphone counts as "not silent" even
                    // while the echo gate suppresses recognition: the room is
                    // clearly not abandoned, so keep the recording running.
                    // The system track counts too — listening to a remote
                    // speaker for a long stretch must not end the recording.
                    if mic >= MIC_SILENCE_LEVEL || system >= MIC_SILENCE_LEVEL {
                        session.mark_voice_activity();
                    }
                    let _ = app.emit(LIVE_EVENT, json!({ "type": "levels", "mic": mic, "system": system, "elapsedMs": elapsed, "micSuppressed": mic_suppressed }));
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
                log::debug!("audio-capture: {line}");
            }
        }
    });
}

/// Abort any live translation websocket loops and drop their routes. Used
/// before re-attaching connections (mode switch) and on session teardown so a
/// stale loop never keeps receiving audio after the mode changed.
fn clear_connections(session: &LiveSession) {
    let mut handles = session
        .handles
        .lock()
        .map_err(|_| "live handles lock is poisoned")
        .expect("live handles lock");
    for (_source, handle) in handles.drain() {
        handle.abort();
    }
    session
        .routes
        .write()
        .map_err(|_| "live routes lock is poisoned")
        .expect("live routes lock")
        .clear();
}

fn spawn_connections(
    app: &AppHandle,
    session: &Arc<LiveSession>,
    epoch: u32,
    epoch_offset_ms: u64,
    connections: Vec<ConnectionDescriptor>,
) -> CommandResult<()> {
    // Tear down any previous connections first so a mode switch never leaves
    // orphaned loops or duplicate routes for the same audio source.
    clear_connections(session);
    validate_connections(&connections)?;
    let mut routes = session
        .routes
        .write()
        .map_err(|_| "live routes lock is poisoned")?;
    let mut handles = session
        .handles
        .lock()
        .map_err(|_| "live handles lock is poisoned")?;
    for connection in connections {
        let (sender, receiver) = unbounded_channel();
        routes.insert(connection.source, sender);
        let app = app.clone();
        let session = session.clone();
        let provider = LiveProvider::from_name(connection.provider.as_deref());
        let tencent_credentials = match &provider {
            LiveProvider::Tencent => {
                let empty = HashMap::new();
                Some(tencent_asr::TencentCredentials::from_extra(
                    connection.extra.as_ref().unwrap_or(&empty),
                )?)
            }
            _ => None,
        };
        let handle = tauri::async_runtime::spawn(async move {
            websocket_loop(
                app,
                session,
                connection.source,
                epoch,
                epoch_offset_ms,
                connection.url,
                receiver,
                provider,
                connection.api_key.clone(),
                tencent_credentials,
            )
            .await;
        });
        handles.insert(connection.source, handle);
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
        let api_key = connection.api_key.as_deref().unwrap_or("").trim();
        match LiveProvider::from_name(connection.provider.as_deref()) {
            LiveProvider::Qwen if api_key.is_empty() => {
                return Err("Qwen 翻译引擎需要填写 DashScope API Key".to_owned());
            }
            LiveProvider::Volc if api_key.is_empty() => {
                return Err("火山同声传译需要填写 Access Key".to_owned());
            }
            LiveProvider::Tencent => {
                // Fail fast on credential shape before any audio flows; the
                // same parse happens again in the connection loop.
                let empty = HashMap::new();
                tencent_asr::TencentCredentials::from_extra(
                    connection.extra.as_ref().unwrap_or(&empty),
                )?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Resolve the language pair sent to Volcengine AST.
///
/// AST always translates, so Lynse's two special values need mapping:
/// `auto` source switches on server-side language detection, and the
/// transcript-only target (`none`) is satisfied by requesting *some* valid
/// target and dropping the translation subtitles on arrival.
fn volc_languages(source: &str, target: &str) -> (String, String, bool) {
    let detect = source.is_empty() || source == "auto";
    let source_language = if detect { String::new() } else { source.to_owned() };
    let target_language = if target.is_empty() || target == "none" {
        if source_language == "zh" { "en" } else { "zh" }.to_owned()
    } else {
        target.to_owned()
    };
    (source_language, target_language, detect)
}

/// Drop the audio that piled up in the channel while a stream was down, so a
/// reconnect resumes live speech instead of dumping minutes of stale audio at
/// the provider (the recording file keeps everything regardless). Returns true
/// when a VoiceEnd was seen — the session paused or stopped meanwhile and this
/// loop must not reconnect.
fn drain_stale_audio(receiver: &mut UnboundedReceiver<WsCommand>) -> bool {
    while let Ok(command) = receiver.try_recv() {
        if matches!(command, WsCommand::VoiceEnd) {
            return true;
        }
    }
    false
}

/// Reconnect backoff after `streak` consecutive failed attempts (1-based):
/// 0.5 s doubling, capped so a long outage keeps retrying at a steady pace.
fn live_reconnect_backoff(streak: u32) -> Duration {
    Duration::from_millis(500u64 << (streak.saturating_sub(1)).min(5))
        .min(LIVE_RECONNECT_BACKOFF_MAX)
}

#[allow(clippy::too_many_arguments)]
async fn websocket_loop(
    app: AppHandle,
    session: Arc<LiveSession>,
    source: AudioSource,
    epoch: u32,
    epoch_offset_ms: u64,
    url: String,
    mut receiver: UnboundedReceiver<WsCommand>,
    provider: LiveProvider,
    api_key: Option<String>,
    tencent_credentials: Option<tencent_asr::TencentCredentials>,
) {
    let is_qwen = provider == LiveProvider::Qwen;
    let is_volc = provider == LiveProvider::Volc;
    // Volcengine bills translation per session and always emits a translation
    // track; in transcript-only mode we still ask for one and simply drop the
    // translation subtitles.
    let volc_transcript_only = is_volc
        && session
            .target_language
            .read()
            .expect("live target language")
            .as_str()
            == "none";
    // Consecutive failed (re)connect attempts. Resets as soon as the provider
    // sends any traffic, so a long session only pays the backoff while the
    // network is actually broken — and never stops trying while the session
    // lives: sleep/wake (lid close), App Nap or a Wi-Fi roam can sever the
    // websocket at any moment, and transcription must resume once it returns.
    let mut failure_streak: u32 = 0;
    // Count of websocket streams opened for this source. A re-attached stream
    // restarts its relative provider timestamps at zero, so after the first
    // one the anchor must be re-based on the capture clock (see below).
    let mut connections_opened: u32 = 0;
    let mut stream_offset_ms = epoch_offset_ms;
    loop {
        // Audio kept piling into the channel while the stream was down; drop
        // that stale backlog before the next attempt.
        if failure_streak > 0 && drain_stale_audio(&mut receiver) {
            return;
        }
        failure_streak += 1;
        emit_stream_state(&app, source, "connecting", epoch);
        log::info!(
            "Live translation stream {source:?} connecting (attempt {failure_streak}, session={})",
            session.session_id
        );
        let mut request = match url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                emit_error(&app, Some(source), format!("实时翻译连接地址无效：{error}"));
                break;
            }
        };
        // Tencent authenticates through the URL itself and binds the signature
        // to a one-shot voice_id, so every attempt signs a fresh URL; reusing
        // one would make every reconnect after the first a hard failure.
        if provider == LiveProvider::Tencent {
            let credentials = tencent_credentials
                .as_ref()
                .expect("tencent provider without parsed credentials");
            match tencent_asr::build_signed_url(&url, credentials) {
                Ok(signed) => {
                    request = match signed.as_str().into_client_request() {
                        Ok(request) => request,
                        Err(error) => {
                            emit_error(
                                &app,
                                Some(source),
                                format!("实时翻译连接地址无效：{error}"),
                            );
                            break;
                        }
                    };
                }
                Err(error) => {
                    emit_error(&app, Some(source), error);
                    break;
                }
            }
        }
        if is_qwen {
            if let Some(key) = api_key.as_ref() {
                if let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", key.trim())) {
                    request.headers_mut().insert(AUTHORIZATION, value);
                }
            }
        }
        // Volcengine AST v4 authenticates on the websocket upgrade header. The
        // new Volcengine console issues a single API Key sent as `X-Api-Key`.
        if is_volc {
            if let Some(key) = api_key.as_ref() {
                if let Ok(value) = HeaderValue::from_str(key.trim()) {
                    request.headers_mut().insert("x-api-key", value);
                }
            }
            if let Ok(value) = HeaderValue::from_str(volc_ast::RESOURCE_ID) {
                request.headers_mut().insert("x-api-resource-id", value);
            }
            if let Ok(value) = HeaderValue::from_str(&uuid::Uuid::new_v4().to_string()) {
                request.headers_mut().insert("x-api-connect-id", value);
            }
        }
        let connect = tokio::time::timeout(
            LIVE_CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async(request),
        )
        .await;
        match connect {
            Ok(Ok((socket, _))) => {
                emit_stream_state(&app, source, "connected", epoch);
                connections_opened += 1;
                if connections_opened > 1 {
                    // This stream re-attached after an outage: its relative
                    // timestamps restart at zero, so re-anchor them on the
                    // capture clock — otherwise every utterance after the
                    // reconnect would land near the session start and sort to
                    // the top of the finished transcript.
                    stream_offset_ms = session.last_elapsed_ms.load(Ordering::Relaxed);
                }
                let (mut writer, mut reader) = socket.split();
                // For Qwen, configure translation and/or source-language ASR
                // right after the handshake. `none` is Lynse's transcript-only
                // mode: keep real-time ASR active without requesting translation.
                if is_qwen {
                    let source_lang = session
                        .source_language
                        .read()
                        .expect("live source language")
                        .clone();
                    let target_lang = session
                        .target_language
                        .read()
                        .expect("live target language")
                        .clone();
                    let transcript_only = target_lang == "none";
                    let mut session_cfg = json!({
                        "modalities": ["text"],
                        "input_audio_format": "pcm",
                    });
                    if !transcript_only {
                        session_cfg["translation"] = json!({ "language": target_lang });
                    }
                    if source_lang != "auto" || transcript_only {
                        let mut transcription = json!({
                            "model": "qwen3-asr-flash-realtime",
                        });
                        if source_lang != "auto" {
                            transcription["language"] = json!(source_lang);
                        }
                        session_cfg["input_audio_transcription"] = transcription;
                    }
                    let update = json!({
                        "type": "session.update",
                        "event_id": format!("evt_{}", uuid::Uuid::new_v4()),
                        "session": session_cfg,
                    })
                    .to_string();
                    if let Err(error) = writer.send(Message::Text(update.into())).await {
                        emit_error(&app, Some(source), format!("发送 Qwen 会话配置失败：{error}"));
                        break;
                    }
                }
                // Volcengine AST opens a session with an explicit StartSession
                // frame. Websocket ordering guarantees the server processes it
                // before any audio, so we can stream straight away instead of
                // blocking on the SessionStarted acknowledgement.
                let volc_source_lang = session
                    .source_language
                    .read()
                    .expect("live source language")
                    .clone();
                let volc_target_lang = session
                    .target_language
                    .read()
                    .expect("live target language")
                    .clone();
                let (volc_source_language, volc_target_language, volc_detect) =
                    volc_languages(&volc_source_lang, &volc_target_lang);
                let volc_config = volc_ast::SessionConfig {
                    session_id: uuid::Uuid::new_v4().to_string(),
                    mode: "s2t".to_owned(),
                    source_language: volc_source_language,
                    target_language: volc_target_language,
                    detect_source_language: volc_detect,
                };
                if is_volc {
                    let frame = volc_ast::encode_start_session(&volc_config);
                    if let Err(error) = writer.send(Message::Binary(frame.into())).await {
                        emit_error(&app, Some(source), format!("开启火山翻译会话失败：{error}"));
                        break;
                    }
                }
                // Volcengine is paced in 100 ms chunks (matching the vendor
                // reference client), so 20 ms capture frames are coalesced here.
                let mut volc_pending: Vec<u8> = Vec::with_capacity(volc_ast::CHUNK_BYTES);
                // Tencent is paced in 40 ms chunks (the vendor-recommended
                // frame size) through the same coalescing pattern.
                let mut tencent_pending: Vec<u8> = Vec::with_capacity(tencent_asr::CHUNK_BYTES);
                // `*SubtitleEnd` events may close an utterance without repeating
                // its text, so remember the last streamed value per track.
                let mut volc_last_source = String::new();
                let mut volc_last_translation = String::new();
                // 1-based speaker index for diarization, derived from the
                // `spk_chg` marker on source subtitle Start events.
                let mut volc_speaker_index: u32 = 1;
                let mut finishing: Option<tokio::time::Instant> = None;
                let mut qwen_finishing = false;
                // Liveness tracking: a half-open TCP path (connection severed
                // without a FIN — e.g. the network dropped while the machine
                // was asleep) never produces a read error on its own, so after
                // a silence window we probe with a websocket ping and force a
                // reconnect when the probe goes unanswered.
                let mut last_inbound = tokio::time::Instant::now();
                let mut pinged_at: Option<tokio::time::Instant> = None;
                loop {
                    tokio::select! {
                        command = receiver.recv(), if finishing.is_none() => {
                            match command {
                                Some(WsCommand::Audio(payload)) => {
                                    if is_qwen {
                                        let event = json!({
                                            "type": "input_audio_buffer.append",
                                            "audio": BASE64_ENGINE.encode(&payload),
                                        })
                                        .to_string();
                                        if let Err(error) = writer.send(Message::Text(event.into())).await {
                                            emit_error(&app, Some(source), format!("发送音频失败：{error}"));
                                            break;
                                        }
                                    } else if is_volc {
                                        volc_pending.extend_from_slice(&payload);
                                        let mut failed = None;
                                        while volc_pending.len() >= volc_ast::CHUNK_BYTES {
                                            let rest = volc_pending.split_off(volc_ast::CHUNK_BYTES);
                                            let chunk = std::mem::replace(&mut volc_pending, rest);
                                            let frame = volc_ast::encode_task_request(&volc_config, &chunk);
                                            if let Err(error) = writer.send(Message::Binary(frame.into())).await {
                                                failed = Some(error);
                                                break;
                                            }
                                        }
                                        if let Some(error) = failed {
                                            emit_error(&app, Some(source), format!("发送音频失败：{error}"));
                                            break;
                                        }
                                    } else if provider == LiveProvider::Tencent {
                                        tencent_pending.extend_from_slice(&payload);
                                        let mut failed = None;
                                        while tencent_pending.len() >= tencent_asr::CHUNK_BYTES {
                                            let rest = tencent_pending.split_off(tencent_asr::CHUNK_BYTES);
                                            let chunk = std::mem::replace(&mut tencent_pending, rest);
                                            if let Err(error) =
                                                writer.send(Message::Binary(chunk.into())).await
                                            {
                                                failed = Some(error);
                                                break;
                                            }
                                        }
                                        if let Some(error) = failed {
                                            emit_error(&app, Some(source), format!("发送音频失败：{error}"));
                                            break;
                                        }
                                    } else if let Err(error) = writer.send(Message::Binary(payload.into())).await {
                                        emit_error(&app, Some(source), format!("发送音频失败：{error}"));
                                        break;
                                    }
                                }
                                Some(WsCommand::VoiceEnd) | None => {
                                    if is_volc {
                                        // Flush the tail of the capture buffer, then
                                        // let the server drain and close the session.
                                        if !volc_pending.is_empty() {
                                            let chunk = std::mem::take(&mut volc_pending);
                                            let frame = volc_ast::encode_task_request(&volc_config, &chunk);
                                            let _ = writer.send(Message::Binary(frame.into())).await;
                                        }
                                        let frame = volc_ast::encode_finish_session(&volc_config);
                                        let _ = writer.send(Message::Binary(frame.into())).await;
                                        finishing =
                                            Some(tokio::time::Instant::now() + Duration::from_secs(5));
                                    } else if is_qwen {
                                        let _ = writer
                                            .send(Message::Text(
                                                r#"{"type":"session.finish","event_id":"evt_finish"}"#.into(),
                                            ))
                                            .await;
                                        qwen_finishing = true;
                                        finishing =
                                            Some(tokio::time::Instant::now() + Duration::from_secs(5));
                                    } else if provider == LiveProvider::Tencent {
                                        // Tencent has no end-of-audio frame: flush
                                        // the tail and close; the server answers
                                        // with its final results before dropping
                                        // the connection.
                                        if !tencent_pending.is_empty() {
                                            let chunk = std::mem::take(&mut tencent_pending);
                                            let _ = writer.send(Message::Binary(chunk.into())).await;
                                        }
                                        let _ = writer.close().await;
                                        finishing =
                                            Some(tokio::time::Instant::now() + Duration::from_secs(3));
                                    } else {
                                        let _ = writer
                                            .send(Message::Text(r#"{"method":"voiceEnd"}"#.into()))
                                            .await;
                                        finishing =
                                            Some(tokio::time::Instant::now() + Duration::from_secs(3));
                                    }
                                }
                            }
                        }
                        incoming = reader.next() => {
                            match incoming {
                                Some(Ok(Message::Text(text))) => {
                                    // Provider traffic proves the connection is
                                    // healthy and clears the reconnect backoff.
                                    last_inbound = tokio::time::Instant::now();
                                    pinged_at = None;
                                    failure_streak = 0;
                                    if is_qwen && qwen_finishing
                                        && text.contains("\"session.finished\"")
                                    {
                                        let _ = writer.close().await;
                                        emit_stream_state(&app, source, "closed", epoch);
                                        return;
                                    }
                                    if provider == LiveProvider::Tencent {
                                        match serde_json::from_str::<tencent_asr::AsrResponse>(
                                            text.as_ref(),
                                        ) {
                                            Ok(response) => {
                                                if response.code != 0 {
                                                    let detail = if response.message.is_empty() {
                                                        format!("状态码 {}", response.code)
                                                    } else {
                                                        response.message.clone()
                                                    };
                                                    emit_error(
                                                        &app,
                                                        Some(source),
                                                        format!(
                                                            "腾讯实时识别错误（{}）：{detail}",
                                                            response.code
                                                        ),
                                                    );
                                                    break;
                                                }
                                                if response.is_final == 1 {
                                                    // The server considers the speech
                                                    // over and is about to close; the
                                                    // reconnect loop keeps the stream
                                                    // alive for the next utterance.
                                                    break;
                                                }
                                                if let Some(result) = &response.result {
                                                    handle_tencent_result(
                                                        &app,
                                                        &session,
                                                        source,
                                                        epoch,
                                                        stream_offset_ms,
                                                        result,
                                                        &response.message_id,
                                                    );
                                                }
                                            }
                                            Err(error) => {
                                                log::warn!("tencent-asr: 无法解析响应：{error}");
                                            }
                                        }
                                    } else {
                                        handle_provider_message(
                                            &app,
                                            &session,
                                            source,
                                            epoch,
                                            stream_offset_ms,
                                            text.as_ref(),
                                            is_qwen,
                                        );
                                    }
                                }
                                Some(Ok(Message::Binary(frame))) if is_volc => {
                                    last_inbound = tokio::time::Instant::now();
                                    pinged_at = None;
                                    failure_streak = 0;
                                    match volc_ast::decode_response(&frame) {
                                        Ok(response) => match response.event {
                                            volc_ast::EVENT_SESSION_FINISHED => {
                                                let _ = writer.close().await;
                                                emit_stream_state(&app, source, "closed", epoch);
                                                return;
                                            }
                                            volc_ast::EVENT_SESSION_FAILED
                                            | volc_ast::EVENT_SESSION_CANCELED => {
                                                let detail = if response.message.is_empty() {
                                                    format!("状态码 {}", response.status_code)
                                                } else {
                                                    response.message.clone()
                                                };
                                                emit_error(
                                                    &app,
                                                    Some(source),
                                                    format!(
                                                        "火山翻译会话失败（{}）：{detail}",
                                                        volc_ast::describe_event(response.event)
                                                    ),
                                                );
                                                break;
                                            }
                                            _ => handle_volc_response(
                                                &app,
                                                &session,
                                                source,
                                                epoch,
                                                stream_offset_ms,
                                                &response,
                                                volc_transcript_only,
                                                &mut volc_last_source,
                                                &mut volc_last_translation,
                                                &mut volc_speaker_index,
                                            ),
                                        },
                                        Err(error) => {
                                            log::warn!("volc-ast: 无法解析响应帧：{error}");
                                        }
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => {
                                    if finishing.is_some() {
                                        emit_stream_state(&app, source, "closed", epoch);
                                        return;
                                    }
                                    emit_error(&app, Some(source), "翻译连接由服务端关闭，正在重连。");
                                    break;
                                }
                                Some(Ok(_)) => {
                                    // Ping/Pong and other framing traffic also
                                    // count as a liveness proof.
                                    last_inbound = tokio::time::Instant::now();
                                    pinged_at = None;
                                    failure_streak = 0;
                                }
                                Some(Err(error)) => {
                                    emit_error(&app, Some(source), format!("翻译连接中断：{error}"));
                                    break;
                                }
                            }
                        }
                        _ = async {
                            let deadline = match pinged_at {
                                Some(sent) => sent + LIVE_STREAM_PONG_GRACE,
                                None => last_inbound + LIVE_STREAM_PING_AFTER,
                            };
                            tokio::time::sleep_until(deadline).await
                        }, if finishing.is_none() => {
                            if pinged_at.is_some() {
                                // The ping probe came back empty: the TCP path
                                // is silently dead, so tear this socket down and
                                // let the reconnect loop below take over.
                                log::warn!(
                                    "Live translation stream {source:?} unresponsive (session={}), forcing reconnect",
                                    session.session_id
                                );
                                emit_error(&app, Some(source), "实时转写连接无响应，正在重连。");
                                break;
                            }
                            if writer.send(Message::Ping(Vec::new().into())).await.is_err() {
                                break;
                            }
                            pinged_at = Some(tokio::time::Instant::now());
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
            Ok(Err(error)) => {
                log::warn!(
                    "Live translation stream {source:?} connect failed (streak {failure_streak}, session={}): {error}",
                    session.session_id
                );
                // A 4xx handshake rejection (bad API key, wrong resource id) is
                // a configuration error the provider will keep refusing, so
                // retrying forever would only spin — fail the stream for real.
                // Everything else (connect timeout, DNS, TCP, 5xx) is
                // transient: keep trying for as long as the session lives.
                let rejected = matches!(
                    &error,
                    tokio_tungstenite::tungstenite::Error::Http(response)
                        if response.status().is_client_error()
                            && response.status().as_u16() != 429
                );
                if rejected {
                    emit_error(
                        &app,
                        Some(source),
                        format!("实时翻译连接被拒绝（{error}），请检查引擎配置。"),
                    );
                    emit_stream_state(&app, source, "failed", epoch);
                    return;
                }
                // Surface only the first failure of a streak — the banner stays
                // up (and clears on recovery) without flickering every retry.
                if failure_streak == 1 {
                    emit_error(
                        &app,
                        Some(source),
                        format!("实时翻译连接失败（第 {failure_streak} 次）：{error}"),
                    );
                }
            }
            Err(_elapsed) => {
                log::warn!(
                    "Live translation stream {source:?} connect timed out after {LIVE_CONNECT_TIMEOUT:?} (streak {failure_streak}, session={})",
                    session.session_id
                );
            }
        }
        tokio::time::sleep(live_reconnect_backoff(failure_streak)).await;
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
    is_qwen: bool,
) {
    let emission = if is_qwen {
        apply_qwen_message(session, source, epoch, epoch_offset_ms, text)
    } else {
        apply_provider_message(session, source, epoch, epoch_offset_ms, text)
    };
    emit_provider_emission(app, emission);
}

fn emit_provider_emission(app: &AppHandle, emission: Option<ProviderEmission>) {
    match emission {
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

/// Route one Volcengine AST subtitle event onto the shared live-segment model.
///
/// AST publishes two parallel tracks per utterance — source recognition
/// (`SourceSubtitle*`) and translation (`TranslationSubtitle*`) — which map
/// directly onto Lynse's (recognized, translated) segment pair. The `*End`
/// events close an utterance but do not always repeat its text, so the last
/// streamed value for each track is carried forward.
#[allow(clippy::too_many_arguments)]
fn handle_volc_response(
    app: &AppHandle,
    session: &LiveSession,
    source: AudioSource,
    epoch: u32,
    epoch_offset_ms: u64,
    response: &volc_ast::Response,
    transcript_only: bool,
    last_source: &mut String,
    last_translation: &mut String,
    speaker_index: &mut u32,
) {
    // Volcengine AST flags a speaker change on the *source* subtitle Start
    // event. Only the source track carries it (the translation Start repeats
    // the same flag for the same utterance), so we count on the source track
    // only to avoid double-incrementing the speaker index.
    if response.event == volc_ast::EVENT_SOURCE_SUBTITLE_START && response.spk_chg {
        *speaker_index += 1;
    }
    let Some(subtitle) = volc_ast::classify_subtitle(response.event) else {
        return;
    };
    let (is_recognized, is_final) = match subtitle {
        volc_ast::Subtitle::Source { is_final } => (true, is_final),
        volc_ast::Subtitle::Translation { is_final } => {
            if transcript_only {
                return;
            }
            (false, is_final)
        }
    };
    let carry = if is_recognized {
        last_source
    } else {
        last_translation
    };
    let text = if response.text.is_empty() {
        carry.clone()
    } else {
        response.text.clone()
    };
    if text.trim().is_empty() {
        return;
    }
    if is_final {
        carry.clear();
    } else {
        *carry = text.clone();
    }

    // AST reports utterance bounds in milliseconds from the start of the
    // session; before the first timestamped event we fall back to the capture
    // clock, the same approximation the Qwen provider uses.
    let start_ms = if response.start_time > 0 {
        epoch_offset_ms.saturating_add(response.start_time as u64)
    } else {
        epoch_offset_ms.saturating_add(session.last_elapsed_ms.load(Ordering::Relaxed))
    };
    let end_ms =
        (response.end_time > 0).then(|| epoch_offset_ms.saturating_add(response.end_time as u64));

    let emission = ingest_provider_text(
        session,
        source,
        epoch,
        None,
        start_ms,
        end_ms,
        is_recognized,
        is_final,
        String::new(),
        Some(*speaker_index),
        &text,
    );
    emit_provider_emission(app, emission);
}

/// Route one Tencent ASR result frame onto the shared live-segment model.
///
/// The service recognises only — there is no translation leg — so every frame
/// updates the recognized track. `slice_type` 2 closes the sentence; start and
/// interim frames carry the rolling text for the open utterance. Timestamps
/// are milliseconds relative to this connection's audio, the same shape the
/// Volcengine path rebases via `stream_offset_ms`.
#[allow(clippy::too_many_arguments)]
fn handle_tencent_result(
    app: &AppHandle,
    session: &LiveSession,
    source: AudioSource,
    epoch: u32,
    epoch_offset_ms: u64,
    result: &tencent_asr::AsrResult,
    message_id: &str,
) {
    let text = result.voice_text.clone();
    if text.trim().is_empty() {
        return;
    }
    let is_final = result.slice_type == 2;
    // Before the first timestamped frame we fall back to the capture clock,
    // the same approximation the Volcengine and Qwen paths use.
    let start_ms = if result.start_time > 0 {
        epoch_offset_ms.saturating_add(result.start_time as u64)
    } else {
        epoch_offset_ms.saturating_add(session.last_elapsed_ms.load(Ordering::Relaxed))
    };
    let end_ms = (result.end_time > 0)
        .then(|| epoch_offset_ms.saturating_add(result.end_time as u64));
    let emission = ingest_provider_text(
        session,
        source,
        epoch,
        None,
        start_ms,
        end_ms,
        true,
        is_final,
        message_id.to_owned(),
        None,
        &text,
    );
    emit_provider_emission(app, emission);
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

/// Timestamps at or above this bound cannot be session-relative offsets — as
/// elapsed ms it would mean a recording over 11 days long — so they must be
/// absolute Unix epoch ms (the 2001 era onward). iLiveData reports utterance
/// `startTs`/`endTs` this way; other providers report ms since stream open.
const ABSOLUTE_TIMESTAMP_MS: u64 = 1_000_000_000_000;

fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Map a provider timestamp onto the recording-relative timeline. Absolute
/// epoch ms are rebased against the session's wall-clock start; relative
/// offsets keep the stream-attach anchor (`epoch_offset_ms`).
fn rebase_provider_timestamp(raw: u64, wall_start_ms: u64, epoch_offset_ms: u64) -> u64 {
    if raw >= ABSOLUTE_TIMESTAMP_MS {
        raw.saturating_sub(wall_start_ms)
    } else {
        epoch_offset_ms.saturating_add(raw)
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
    let wall_start_ms = session.wall_start_ms.load(Ordering::Relaxed);
    let start_ms = rebase_provider_timestamp(
        value_u64(&value, "startTs"),
        wall_start_ms,
        epoch_offset_ms,
    );
    let raw_end = value_u64(&value, "endTs");
    let end_ms =
        (raw_end > 0).then(|| rebase_provider_timestamp(raw_end, wall_start_ms, epoch_offset_ms));
    let incoming = value_string(&value, if is_recognized { "asr" } else { "trans" })
        .unwrap_or_default();
    if incoming.is_empty() {
        return None;
    }
    // Utterance key: prefer the provider task id, fall back to the start
    // timestamp (stable per utterance for most providers).
    let task_id = value_string(&value, "taskId")
        .unwrap_or_else(|| value_u64(&value, "startTs").to_string());
    // iLiveData diarization: every result carries `SpeakerId` as a JSON number,
    // with -1 meaning "not recognised" (diarization disabled, or the engine has
    // not settled on a speaker yet). Normalise the provider's 0-based id onto
    // the same 1-based speaker index the Volcengine path uses.
    let speaker = value
        .get("SpeakerId")
        .and_then(Value::as_i64)
        .filter(|id| *id >= 0)
        .map(|id| (id as u32).saturating_add(1));
    ingest_provider_text(
        session,
        source,
        epoch,
        stream_id,
        start_ms,
        end_ms,
        is_recognized,
        is_final_method,
        task_id,
        speaker,
        &incoming,
    )
}

/// Apply the recognized/translated text from a Qwen realtime-translation event
/// to a segment. Qwen's protocol is event-driven (`session.update` + streaming
/// `input_audio_buffer.append` audio) rather than iLiveData's binary-PCM +
/// `method`-field shape, but the resulting (source-recognition, translation)
/// pair maps onto the same live-segment model, so we reuse the shared ingest.
fn apply_qwen_message(
    session: &LiveSession,
    source: AudioSource,
    epoch: u32,
    epoch_offset_ms: u64,
    text: &str,
) -> Option<ProviderEmission> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let event_type = value.get("type").and_then(Value::as_str)?;
    let (is_recognized, is_final, content) = classify_qwen_event(event_type, &value)?;
    if content.is_empty() {
        return None;
    }
    // Qwen auto-detects utterance boundaries, so we approximate the utterance
    // start with the latest captured audio time on this source.
    let start_ms = epoch_offset_ms.saturating_add(session.last_elapsed_ms.load(Ordering::Relaxed));
    ingest_provider_text(
        session,
        source,
        epoch,
        None,
        start_ms,
        None,
        is_recognized,
        is_final,
        String::new(),
        None,
        &content,
    )
}

/// Map a Qwen realtime-translation event type to (is_recognized, is_final,
/// text). Source recognition arrives via `input_audio_transcription.*`; the
/// translated text arrives via `response.text.*` (text-only) or
/// `response.audio_transcript.*` (text+audio) — both carry the same translated
/// string, so either family is accepted.
fn classify_qwen_event(event_type: &str, value: &Value) -> Option<(bool, bool, String)> {
    if event_type.contains("input_audio_transcription") {
        let text = event_text(value);
        return if event_type.ends_with(".completed") {
            Some((true, true, text))
        } else if event_type.ends_with(".text") {
            Some((true, false, text))
        } else {
            None
        };
    }
    if event_type.contains("response.text") || event_type.contains("response.audio_transcript") {
        let text = event_text(value);
        return if event_type.ends_with(".done") {
            Some((false, true, text))
        } else if event_type.ends_with(".delta") {
            Some((false, false, text))
        } else {
            None
        };
    }
    None
}

/// Extract the streamed text from a Qwen event. The field name varies by event
/// family (`text` / `delta` / `transcript` / `content`), so try each in order.
fn event_text(value: &Value) -> String {
    for key in ["text", "delta", "transcript", "content"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            return text.to_owned();
        }
    }
    String::new()
}

/// Shared utterance-ingest core used by both the iLiveData and Qwen providers:
/// coalesce the (source-recognition, translation) pair onto a single live
/// segment/card, honouring "final wins, interim ignored once final".
#[allow(clippy::too_many_arguments)]
fn ingest_provider_text(
    session: &LiveSession,
    source: AudioSource,
    epoch: u32,
    stream_id: Option<String>,
    start_ms: u64,
    end_ms: Option<u64>,
    is_recognized: bool,
    is_final: bool,
    task_id: String,
    speaker: Option<u32>,
    text: &str,
) -> Option<ProviderEmission> {
    // Recognized speech resets the silence watchdog, whichever provider or
    // source (mic/system) produced it — a transcript is the strongest evidence
    // the recording is still worth keeping.
    if is_recognized && !text.trim().is_empty() {
        session.mark_voice_activity();
    }
    let mut segments = session.segments.lock().expect("live segments lock");

    // Coalesce each utterance onto a single live segment/card. The provider
    // streams rolling-buffer corrections — each update may rewrite the previous
    // sentence and is not always a strict prefix of it — so we must refresh the
    // open card in place instead of spawning a new bubble for every interim
    // result. Otherwise a single spoken sentence renders as a stack of cards.
    //
    // Rule: attach the message to the open (not-yet-fully-final) utterance for
    // this source. A recognized interim that arrives after the current open
    // utterance's recognition has already finalized is the start of a new
    // sentence and opens a fresh card. Translations always land on the open
    // utterance they stream alongside.
    let exact_pos = segments.iter().rposition(|segment| {
        !segment.is_final && segment.source == source && segment.provider_stream_id == stream_id
    });
    let open_pos = segments.iter().rposition(|segment| {
        !segment.is_final && segment.source == source
    });
    let reuse_pos = match exact_pos.or(open_pos) {
        None => None,
        Some(pos) => {
            let segment = &segments[pos];
            let recognized_done = segment.recognized_final;
            // Providers may re-issue final results or corrections for the same
            // utterance. If the message belongs to the exact same provider
            // stream, refresh the open card in place unless the new result's
            // start time has clearly moved past the previous utterance (the
            // provider started a new sentence on the same stream). Otherwise a
            // recognized interim that arrives after the previous utterance has
            // finalized is treated as the start of the next sentence.
            if is_recognized && recognized_done && exact_pos.is_none() {
                None
            } else if is_recognized && recognized_done && exact_pos.is_some() {
                let previous_end = segment.end_ms.unwrap_or(segment.start_ms);
                if start_ms > previous_end.saturating_add(100) {
                    None
                } else {
                    Some(pos)
                }
            } else {
                Some(pos)
            }
        }
    };

    let index = if let Some(pos) = reuse_pos {
        pos
    } else {
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
            speaker,
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
    // Only overwrite the speaker when the provider actually reported one.
    // Interim results can arrive with -1 ("not recognised") and must not clear
    // a speaker already resolved for this utterance.
    if speaker.is_some() {
        segment.speaker = speaker;
    }
    let method = match (is_recognized, is_final) {
        (true, true) => "recognizedResult",
        (true, false) => "recognizedTempResult",
        (false, true) => "translatedResult",
        (false, false) => "translatedTempResult",
    };
    apply_method_text(segment, method, text);
    segment.is_final = segment.recognized_final && segment.translated_final;

    if is_final {
        // Dual-channel sessions keep simultaneous-speech overlaps visible:
        // the AEC removes the echo acoustically, so text-similarity
        // truncation of mic sentences is no longer applied (old recordings
        // keep their existing echo flags).
        if !session.dual_channel {
            deduplicate_echoes(&mut segments);
        }
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

// Pause/resume/stop signals forwarded to the macOS audio-capture sidecar via
// `signal_child`. On Windows there is no sidecar child process, so the value is
// irrelevant (the Windows `signal_child` is a no-op); we still define a
// platform-safe constant so the call sites compile on both targets.
#[cfg(target_os = "macos")]
const SIGNAL_PAUSE: i32 = libc::SIGUSR1;
#[cfg(target_os = "windows")]
const SIGNAL_PAUSE: i32 = 0;
#[cfg(target_os = "macos")]
const SIGNAL_RESUME: i32 = libc::SIGUSR2;
#[cfg(target_os = "windows")]
const SIGNAL_RESUME: i32 = 0;
#[cfg(target_os = "macos")]
const SIGNAL_STOP: i32 = libc::SIGTERM;
#[cfg(target_os = "windows")]
const SIGNAL_STOP: i32 = 0;

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
    signal_child(&session, SIGNAL_PAUSE)?;
    #[cfg(target_os = "windows")]
    {
        // In-process engine: pausing is stopping the feed, not signalling a
        // sidecar — effective immediately.
        let _ = with_windows_engine(|engine| engine.pause());
        voice_end(&session);
        emit_snapshot(&app, &session);
        return Ok(session.snapshot());
    }
    #[cfg(target_os = "macos")]
    {
        // The sidecar needs a moment to fully stop its capture streams.
        voice_end(&session);
        emit_snapshot(&app, &session);
        tokio::time::sleep(Duration::from_millis(3_100)).await;
        Ok(session.snapshot())
    }
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
    signal_child(&session, SIGNAL_RESUME)?;
    #[cfg(target_os = "windows")]
    {
        // The engine rebuilds its streams and re-anchors the timeline; the
        // echo canceller is reset on resume inside the engine.
        let _ = with_windows_engine(|engine| engine.resume());
    }
    emit_snapshot(&app, &session);
    Ok(session.snapshot())
}

/// Reconfigure a running live session: change the source/target language and
/// attach or detach the cloud translation connections on the fly. The audio
/// capture sidecar keeps running, so the recording itself is never
/// interrupted — switching to transcription/translation (or back to pure
/// recording) is instantaneous from the user's point of view.
#[tauri::command]
pub async fn live_translation_set_mode(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
    request: SetModeRequest,
) -> CommandResult<LiveSnapshot> {
    let session = state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .clone()
        .ok_or("no live translation session")?;
    if session.session_id != request.session_id {
        return Err("set_mode session id does not match".to_owned());
    }
    if session
        .state
        .lock()
        .map_err(|_| "live state lock is poisoned")?
        .as_str()
        == "stopping"
    {
        return Err("session is stopping".to_owned());
    }
    if request.source_language.trim().is_empty() || request.target_language.trim().is_empty() {
        return Err("language pair is required".to_owned());
    }
    validate_connections(&request.connections)?;
    *session
        .source_language
        .write()
        .map_err(|_| "live source language lock is poisoned")? = request.source_language.clone();
    *session
        .target_language
        .write()
        .map_err(|_| "live target language lock is poisoned")? = request.target_language.clone();
    session.epoch.store(request.epoch, Ordering::Relaxed);
    session.epoch_offset_ms.store(0, Ordering::Relaxed);
    // Tear down any previous connections, then attach the new ones (if any).
    // `spawn_connections` already calls `clear_connections` first, but we do
    // it explicitly so a pure-recording switch drops the websocket handles.
    clear_connections(&session);
    if !request.connections.is_empty() {
        spawn_connections(&app, &session, request.epoch, 0, request.connections)?;
    }
    emit_snapshot(&app, &session);
    Ok(session.snapshot())
}

#[tauri::command]
pub async fn live_translation_stop(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
) -> CommandResult<()> {
    let session = state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .take()
        .ok_or("no live translation session")?;
    clear_card_feed_target();
    session.set_state("stopping");
    emit_snapshot(&app, &session);
    // Drop the floating island immediately: the capsule has nothing left to
    // show once the user chose to stop.
    set_recording_island_visible(&app, false);
    session.capture_stop.store(false, Ordering::Relaxed);
    let _ = signal_child(&session, SIGNAL_STOP);

    // Ack now — the UI must answer the stop click instantly. Everything slow
    // (sidecar drain, trailing-segment grace, WAV mixdown, persistence) runs
    // in the background and reaches the UI through the `completed` event.
    tauri::async_runtime::spawn(async move {
        finalize_session(app, session).await;
    });
    Ok(())
}

/// Silence watchdog for the live session. Runs for the session's whole life
/// and stops + saves the recording once the microphone has carried no
/// recognizable speech and no audible level for [`SILENCE_AUTO_STOP`]. The
/// stop sequence mirrors `live_translation_stop`; the manager hand-off makes
/// it a no-op when the user stopped the session first.
fn silence_expired(state: &str, silent_for: Duration) -> bool {
    state == "recording" && silent_for >= SILENCE_AUTO_STOP
}

fn spawn_silence_watchdog(app: AppHandle, session: Arc<LiveSession>) {
    if !session.wants_mic {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SILENCE_CHECK_INTERVAL).await;
            let state = session.state.lock().expect("live state lock").clone();
            match state.as_str() {
                // Paused/connecting freezes the window; capture restarts
                // (`ready`/`resumed`) re-base it. Anything terminal ends the
                // watchdog — the session is already stopping or gone.
                "paused" | "connecting" => continue,
                "recording" => {}
                _ => return,
            }
            let silent_for = session
                .last_voice_at
                .lock()
                .expect("live last voice lock")
                .elapsed();
            if !silence_expired(&state, silent_for) {
                continue;
            }
            log::info!(
                "Live translation silence watchdog: no mic voice for {:.0}s, auto-stopping session={}",
                silent_for.as_secs_f32(),
                session.session_id
            );
            session.auto_stopped_silence.store(true, Ordering::Relaxed);
            let manager = app.state::<LiveTranslationManager>();
            let taken = manager
                .session
                .lock()
                .ok()
                .and_then(|mut guard| guard.take());
            match taken {
                Some(current) if Arc::ptr_eq(&current, &session) => {}
                Some(other) => {
                    // Not ours (a newer session took over) — put it back and
                    // leave the decision to that session's own watchdog.
                    if let Ok(mut guard) = manager.session.lock() {
                        *guard = Some(other);
                    }
                    return;
                }
                None => return,
            }
            clear_card_feed_target();
            session.set_state("stopping");
            emit_snapshot(&app, &session);
            set_recording_island_visible(&app, false);
            session.capture_stop.store(false, Ordering::Relaxed);
            let _ = signal_child(&session, SIGNAL_STOP);
            finalize_session(app, session).await;
            return;
        }
    });
}

/// Drain the capture sidecar, persist the finished session and announce it.
/// Runs in the background after `live_translation_stop` has acked.
async fn finalize_session(app: AppHandle, session: Arc<LiveSession>) {
    #[cfg(target_os = "windows")]
    wait_windows_capture_done().await;
    let child = session
        .child
        .lock()
        .map(|mut guard| guard.take())
        .unwrap_or(None);
    if let Some(mut child) = child {
        let _ = tauri::async_runtime::spawn_blocking(move || {
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
        .await;
    }

    voice_end(&session);
    // Trailing-segment grace: after VoiceEnd providers still stream their last
    // final results over the websockets. They typically land well under a
    // second, so a short grace keeps the transcript tail without making the
    // completion dialog wait.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let persist_result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let session = session.clone();
        move || persist_session(&app, &session)
    })
    .await;
    session.set_state("idle");
    let _ = app.emit(
        LIVE_EVENT,
        json!({ "type": "state", "snapshot": idle_snapshot() }),
    );
    match persist_result {
        Ok(Ok(completed)) => {
            let _ = app.emit(
                LIVE_EVENT,
                json!({ "type": "completed", "session": completed }),
            );
        }
        Ok(Err(error)) => {
            emit_error(&app, None, format!("保存录音失败：{error}"));
        }
        Err(error) => {
            emit_error(&app, None, format!("保存录音失败：{error}"));
        }
    }
}

use crate::audio_contract::wav::{inspect as inspect_wav, WavFormat, WavInfo};

/// Makes sure `mic_processed.wav` exists for a dual-channel session,
/// reprocessing the raw tracks through the sidecar when the processed file
/// is missing or empty (crash recovery, failed writer). Returns Ok(()) even
/// when nothing can be produced — the persist path falls back to whatever
/// audio exists rather than losing the recording.
#[cfg(target_os = "macos")]
pub(crate) fn ensure_dual_channel_processed(app: &AppHandle, directory: &Path) -> CommandResult<()> {
    let processed = directory.join("mic_processed.wav");
    if wav_data_len(&processed).map(|length| length > 0).unwrap_or(false) {
        return Ok(());
    }
    let mic_raw = directory.join("mic_raw.wav");
    let system_raw = directory.join("system_raw.wav");
    if wav_data_len(&mic_raw).map(|length| length > 0).unwrap_or(false)
        && wav_data_len(&system_raw).map(|length| length > 0).unwrap_or(false)
    {
        log::info!(
            "Reprocessing dual-channel tracks from raw audio: {}",
            directory.display()
        );
        let mut command = sidecar_command(app)?;
        command
            .arg("--process")
            .arg(directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match command.spawn() {
            Ok(mut child) => {
                let deadline = Instant::now() + Duration::from_secs(300);
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            if !status.success() {
                                log::warn!("dual-channel reprocessing exited with {status}");
                            }
                            break;
                        }
                        Ok(None) if Instant::now() < deadline => {
                            thread::sleep(Duration::from_millis(100));
                        }
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            log::warn!("dual-channel reprocessing timed out");
                            break;
                        }
                    }
                }
            }
            Err(error) => log::warn!("spawn audio-capture for reprocessing: {error}"),
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn ensure_dual_channel_processed(
    _app: &AppHandle,
    _directory: &Path,
) -> CommandResult<()> {
    // The Swift sidecar's `--process` reprocessor is macOS-only. Windows raw
    // tracks stay archived for recovery; persist falls back to whatever
    // audio exists until the in-engine reprocessor lands.
    Ok(())
}

fn persist_session(app: &AppHandle, session: &LiveSession) -> CommandResult<CompletedSession> {
    // Dual-source sessions name the processed mic track `mic_processed.wav`
    // (frozen track table); single-source mic sessions and the current macOS
    // sidecar write plain `mic.wav`. Either lands in the default mixdown.
    let mic = [
        session.directory.join("mic_processed.wav"),
        session.directory.join("mic.wav"),
    ]
    .into_iter()
    .find(|path| path.exists())
    .unwrap_or_else(|| session.directory.join("mic.wav"));
    let system = session.directory.join("system.wav");
    // The sidecar archives a full-bandwidth stereo mixdown next to the
    // 16 kHz recognition tracks; it is the master whenever it exists.
    let master = session.directory.join(MASTER_TRACK_FILE);
    // A sidecar that outlived the finalize budget is killed before it can
    // patch its headers — fix that first so every later reader (this mixdown,
    // the per-track picker, the reprocessor, `local-media://`) sees the real
    // duration.
    repair_capture_headers(&session.directory);
    // Name the mixed-down playback file after the recording's end time
    // (local clock, precise to the second) — this is the name shown in the
    // completion dialog and carried by the cloud upload, not an internal
    // "playback.wav".
    let ended_at = chrono::Local::now();
    let playback = session
        .directory
        .join(format!("{}.wav", ended_at.format("%Y%m%d_%H%M%S")));
    build_playback_wav(
        master.exists().then_some(master.as_path()),
        mic.exists().then_some(mic.as_path()),
        system.exists().then_some(system.as_path()),
        &playback,
    )?;
    // Dual-channel recordings carry the versioned track manifest (engine +
    // degraded intervals + per-track files, `tracks.json`); legacy recordings
    // have none. The same file is written by the macOS sidecar and the
    // Windows in-process engine, so both parse through the shared contract.
    let tracks_manifest = session
        .dual_channel
        .then(|| {
            crate::audio_contract::manifest::read_manifest(
                &session.directory.join(crate::audio_contract::manifest::MANIFEST_FILE),
            )
            .ok()
        })
        .flatten();
    let aec_degraded = tracks_manifest
        .as_ref()
        .map(|manifest| !manifest.degraded_intervals_ms.is_empty() || manifest.engine == "none")
        .unwrap_or(false);
    let tracks_value = tracks_manifest
        .as_ref()
        .map(|manifest| serde_json::to_value(manifest).unwrap_or(Value::Null));

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
            "sourceLanguage": session.source_language.read().expect("live source language").clone(),
            "targetLanguage": session.target_language.read().expect("live target language").clone(),
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
        "sourceLanguage": session.source_language.read().expect("live source language").clone(),
        "targetLanguage": session.target_language.read().expect("live target language").clone(),
    })).collect();
    let completed_at = now();
    let source_language = session.source_language.read().expect("live source language").clone();
    let target_language = session.target_language.read().expect("live target language").clone();
    // `completed` is reserved for sessions that actually produced transcript
    // text. A pure recording (no transcription connection attached, or nothing
    // recognized) persists as `recorded` so the UI never shows a transcription
    // badge for audio-only records.
    let status = if transcript_text.trim().is_empty() { "recorded" } else { "completed" };
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
            "status": status,
            "progressPhase": status,
            "durationMs": duration_ms,
            "engine": "ilivedata_rtvt",
            "modelId": "ilivedata-rtvt",
            "language": source_language,
            "targetLanguage": target_language,
            "liveSessionId": session.session_id,
            "syncStatus": "pending",
            "segments": local_segments,
            "trackManifest": tracks_value.clone().unwrap_or(Value::Null),
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
        auto_stopped_silence: session
            .auto_stopped_silence
            .load(Ordering::Relaxed),
        tracks: tracks_value,
        aec_degraded,
    })
}

/// Full-bandwidth mixdown the capture side writes beside the recognition
/// tracks. A derived artifact like the playback file, so — deliberately — it
/// is not one of the frozen capture tracks in `tracks.json`.
pub(crate) const MASTER_TRACK_FILE: &str = "master.wav";

/// Every WAV a session directory can hold. Raw tracks belong here: a sidecar
/// killed by the finalize budget leaves *all* of them with an unpatched header,
/// and the Swift `--process` reprocessor reads the raws through a reader that
/// refuses a zero-length `data` chunk — an unrepaired `mic_raw.wav` makes
/// reprocessing fail *after* it has already deleted the finished tracks.
const CAPTURE_TRACK_FILES: [&str; 6] = [
    MASTER_TRACK_FILE,
    "mic.wav",
    "mic_processed.wav",
    "system.wav",
    "mic_raw.wav",
    "system_raw.wav",
];

/// Repairs headers for tracks whose writer was killed before `close`. Missing
/// or unparseable files are skipped — persist must still produce a recording
/// out of whatever survived.
fn repair_capture_headers(directory: &Path) {
    for name in CAPTURE_TRACK_FILES {
        let path = directory.join(name);
        if !path.exists() {
            continue;
        }
        match crate::audio_contract::wav::repair_if_stale(&path) {
            Ok(true) => log::warn!("repaired WAV header: {}", path.display()),
            Ok(false) => {}
            Err(error) => log::debug!("no WAV header to repair at {}: {error}", path.display()),
        }
    }
}

/// One archived WAV whose payload is long enough to be worth playing.
fn playback_source(path: &Path) -> Option<(PathBuf, WavInfo)> {
    let info = inspect_wav(path).ok()?;
    (info.frames() > 0).then_some((path.to_path_buf(), info))
}

/// Builds the file the user plays back.
///
/// Preference order is a quality order: the sidecar's 48 kHz `master.wav`
/// already mixes echo-cancelled microphone and system audio at full bandwidth,
/// so it is copied verbatim (payload only — the header is rewritten to match
/// the bytes on disk). Without a master, the 16 kHz recognition tracks are
/// summed here, which is what pre-48 kHz recordings did.
fn build_playback_wav(
    master: Option<&Path>,
    mic: Option<&Path>,
    system: Option<&Path>,
    output: &Path,
) -> CommandResult<()> {
    if let Some((path, info)) = master.and_then(playback_source) {
        return copy_payload(&path, &info, output);
    }
    let tracks = [mic, system]
        .into_iter()
        .flatten()
        .filter_map(playback_source)
        .collect::<Vec<_>>();
    match tracks.as_slice() {
        [] => Err("no captured audio was written".to_owned()),
        // Single-source sessions are already complete WAVs.
        [(path, info)] => copy_payload(path, info, output),
        _ => {
            let (first, second) = (&tracks[0], &tracks[1]);
            // Sample-wise summation only means something for two tracks on the
            // same clock; mismatched rates fall back to the longer one.
            if first.1.format == second.1.format {
                mix_payload(first, second, output)
            } else {
                let longest = if track_duration_ms(&first.1) >= track_duration_ms(&second.1) {
                    first
                } else {
                    second
                };
                log::warn!(
                    "playback tracks disagree on format, keeping the longer one: {}",
                    longest.0.display()
                );
                copy_payload(&longest.0, &longest.1, output)
            }
        }
    }
}

fn track_duration_ms(info: &WavInfo) -> u64 {
    info.frames().saturating_mul(1_000) / u64::from(info.format.sample_rate.max(1))
}

/// Streams one track's payload into `output` behind a freshly written header.
fn copy_payload(path: &Path, info: &WavInfo, output: &Path) -> CommandResult<()> {
    let reader = open_payload(path, info)?;
    let mut out = BufWriter::new(File::create(output).map_err(|error| error.to_string())?);
    write_wav_header_for(&mut out, info.frames(), &info.format)?;
    std::io::copy(&mut reader.take(info.data_bytes), &mut out).map_err(|error| error.to_string())?;
    out.flush().map_err(|error| error.to_string())
}

fn open_payload(path: &Path, info: &WavInfo) -> CommandResult<BufReader<File>> {
    let mut reader =
        BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    reader
        .seek(SeekFrom::Start(info.data_offset))
        .map_err(|error| error.to_string())?;
    Ok(reader)
}

/// Streaming mixdown of two same-format PCM16 tracks in ~64 KB chunks: memory
/// stays flat for hour-long meetings. Frames are summed with saturation, never
/// averaged — averaging cost every track 6 dB for no benefit.
fn mix_payload(first: &(PathBuf, WavInfo), second: &(PathBuf, WavInfo), output: &Path) -> CommandResult<()> {
    let format = first.1.format;
    let frame_bytes = first.1.frame_bytes();
    if format.bits_per_sample != 16 || frame_bytes == 0 {
        return copy_payload(&first.0, &first.1, output);
    }
    let frames = first.1.frames().max(second.1.frames());
    let mut left = open_payload(&first.0, &first.1)?;
    let mut right = open_payload(&second.0, &second.1)?;
    let mut out = BufWriter::new(File::create(output).map_err(|error| error.to_string())?);
    write_wav_header_for(&mut out, frames, &format)?;

    let frames_per_chunk = (MIX_CHUNK_BYTES / frame_bytes).max(1);
    let mut left_bytes = vec![0u8; frames_per_chunk * frame_bytes];
    let mut right_bytes = vec![0u8; frames_per_chunk * frame_bytes];
    let mut mixed = Vec::with_capacity(left_bytes.len());
    let mut left_remaining = first.1.data_bytes;
    let mut right_remaining = second.1.data_bytes;
    loop {
        let left_read = read_limited(&mut left, &mut left_bytes, &mut left_remaining)?;
        let right_read = read_limited(&mut right, &mut right_bytes, &mut right_remaining)?;
        let usable = left_read.max(right_read) & !1; // keep i16 pairing
        if usable == 0 {
            break;
        }
        mixed.clear();
        for index in (0..usable).step_by(2) {
            let a = sample_at(&left_bytes, left_read, index);
            let b = sample_at(&right_bytes, right_read, index);
            let sum = a.saturating_add(b).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
            mixed.extend_from_slice(&sum.to_le_bytes());
        }
        out.write_all(&mixed).map_err(|error| error.to_string())?;
    }
    out.flush().map_err(|error| error.to_string())
}

/// i16 at `index` of a little-endian buffer, or silence past its end.
fn sample_at(bytes: &[u8], readable: usize, index: usize) -> i32 {
    if index + 1 < readable {
        i16::from_le_bytes([bytes[index], bytes[index + 1]]) as i32
    } else {
        0
    }
}

/// Data-chunk byte length of a WAV, tolerant of a header the writer never
/// patched (a killed sidecar declares 0 and still holds every sample).
fn wav_data_len(path: &Path) -> CommandResult<u64> {
    Ok(inspect_wav(path)?.data_bytes)
}

/// Reads a full buffer, tolerating a short final chunk and never crossing the
/// end of the declared `data` chunk. Returns bytes read.
fn read_limited(
    reader: &mut BufReader<File>,
    buffer: &mut [u8],
    remaining: &mut u64,
) -> CommandResult<usize> {
    let want = (buffer.len() as u64).min(*remaining) as usize;
    if want == 0 {
        return Ok(0);
    }
    let mut filled = 0;
    while filled < want {
        match reader.read(&mut buffer[filled..want]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    *remaining = remaining.saturating_sub(filled as u64);
    Ok(filled)
}

/// Chunk size for the streaming mixdown (32 768 samples = 64 KB of PCM16).
const MIX_CHUNK_BYTES: usize = 64 * 1024;

/// Writes a canonical 44-byte PCM16 WAV header for `frames` frames of
/// `format`. Playback masters must describe what they actually hold: a 48 kHz
/// stereo master and a 16 kHz mono recognition mixdown share this code.
fn write_wav_header_for<W: Write>(out: &mut W, frames: u64, format: &WavFormat) -> CommandResult<()> {
    debug_assert!(format.sample_format == "int");
    let bytes_per_frame = u64::from(format.channels) * u64::from(format.bits_per_sample) / 8;
    let data_bytes = u32::try_from(frames.saturating_mul(bytes_per_frame))
        .map_err(|_| "recording is too large for WAV")?;
    let channels = u32::from(format.channels);
    let bits = u32::from(format.bits_per_sample);
    out.write_all(b"RIFF").map_err(|error| error.to_string())?;
    out.write_all(&(36 + data_bytes).to_le_bytes())
        .map_err(|error| error.to_string())?;
    out.write_all(b"WAVEfmt ")
        .map_err(|error| error.to_string())?;
    out.write_all(&16u32.to_le_bytes())
        .map_err(|error| error.to_string())?;
    out.write_all(&1u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    out.write_all(&format.channels.to_le_bytes())
        .map_err(|error| error.to_string())?;
    out.write_all(&format.sample_rate.to_le_bytes())
        .map_err(|error| error.to_string())?;
    out.write_all(&(format.sample_rate * channels * bits / 8).to_le_bytes())
        .map_err(|error| error.to_string())?;
    out.write_all(&(format.channels * format.bits_per_sample / 8).to_le_bytes())
        .map_err(|error| error.to_string())?;
    out.write_all(&format.bits_per_sample.to_le_bytes())
        .map_err(|error| error.to_string())?;
    out.write_all(b"data").map_err(|error| error.to_string())?;
    out.write_all(&data_bytes.to_le_bytes())
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Writes the 44-byte canonical PCM16 mono 16 kHz WAV header. `data_samples`
/// is the sample count of the data chunk.
fn write_wav_header<W: Write>(out: &mut W, data_samples: usize) -> CommandResult<()> {
    write_wav_header_for(out, data_samples as u64, &WavFormat::RECOGNITION)
}

pub(crate) fn write_pcm16_wav(path: &Path, samples: &[i16]) -> CommandResult<()> {
    let mut file = BufWriter::new(File::create(path).map_err(|error| error.to_string())?);
    write_wav_header(&mut file, samples.len())?;
    // One buffered bulk write — the old per-sample `write_all` cost one
    // syscall per sample (57 million for an hour of audio).
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
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
        // The 16 kHz recognition tracks go: cloud holds the playback mix, and
        // they are derivable from what stays. The raw captures and the 48 kHz
        // master do NOT go — they are the only full-bandwidth audio in the
        // session, and reprocessing (or a future better engine) needs them.
        for name in ["mic.wav", "system.wav", "mic_processed.wav"] {
            let path = directory.join(name);
            if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

/// Cancel the save of a finished recording: drop the cached
/// local-transcriptions entry and delete the whole session directory
/// (the end-time-named playback WAV, raw sources, transcript). Backs the
/// completion dialog's "取消" button — without it a cancelled recording
/// would stay in the notes list forever.
#[tauri::command]
pub fn live_translation_discard(
    app: AppHandle,
    state: State<LiveTranslationManager>,
    session_id: String,
) -> CommandResult<()> {
    if !valid_session_id(&session_id) {
        return Err("invalid live translation session id".to_owned());
    }
    // Never delete data out from under a live session.
    let active = state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .as_ref()
        .map(|session| session.session_id.clone());
    if active.as_deref() == Some(session_id.as_str()) {
        return Err("cannot discard the active live translation session".to_owned());
    }
    remove_store_value(&app, "local-transcriptions", &format!("local:live:{session_id}"))?;
    let directory = recovery_root(&app)?.join(session_id);
    if directory.exists() {
        fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Re-run echo cancellation over a recording's raw tracks (the detail
/// page's "重新处理" entry): the sidecar rebuilds `mic_processed.wav` and
/// the 16 kHz system track from the raws, the playback mix is regenerated
/// and the stored manifest/flags are refreshed. Only dual-channel sessions
/// with raw tracks qualify.
#[tauri::command]
pub async fn live_translation_reprocess(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
    session_id: String,
) -> CommandResult<Value> {
    if !valid_session_id(&session_id) {
        return Err("invalid live translation session id".to_owned());
    }
    // Never rewrite audio out from under a live session.
    let active = state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .as_ref()
        .map(|session| session.session_id.clone());
    if active.as_deref() == Some(session_id.as_str()) {
        return Err("cannot reprocess the active live translation session".to_owned());
    }
    let record_id = format!("local:live:{session_id}");
    tauri::async_runtime::spawn_blocking(move || {
        let directory = recovery_root(&app)?.join(&session_id);
        let mic_raw = directory.join("mic_raw.wav");
        let system_raw = directory.join("system_raw.wav");
        if !mic_raw.exists() || !system_raw.exists() {
            return Err("这份录音没有保留原始音轨，无法重新处理".to_owned());
        }
        // Repair the raws *before* anything is deleted: the sidecar reads them
        // through a WAV reader that rejects an unpatched zero-length `data`
        // chunk, so a torn header here would fail the rebuild after the good
        // outputs were already gone.
        repair_capture_headers(&directory);
        // Force a full rebuild: drop the previous processed outputs first so
        // a stale file can never short-circuit the engine run.
        for name in ["mic_processed.wav", "system.wav", MASTER_TRACK_FILE] {
            let path = directory.join(name);
            if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        ensure_dual_channel_processed(&app, &directory)?;
        let processed = directory.join("mic_processed.wav");
        if !processed.exists() {
            return Err("重新处理失败：原始音轨无法完成回声消除".to_owned());
        }

        // Regenerate the default playback mix under its stored name so
        // existing players and cloud references stay valid.
        let record = crate::get_store_value(&app, "local-transcriptions", &record_id)?
            .ok_or("recording not found")?;
        let playback = record
            .get("sourcePath")
            .and_then(Value::as_str)
            .ok_or("recording has no playback path")?
            .to_owned();
        let playback_path = PathBuf::from(&playback);
        let system = directory.join("system.wav");
        let master = directory.join(MASTER_TRACK_FILE);
        build_playback_wav(
            master.exists().then_some(master.as_path()),
            processed.exists().then_some(processed.as_path()),
            system.exists().then_some(system.as_path()),
            &playback_path,
        )?;

        // Refresh the manifest-derived fields in the stored record.
        let track_manifest = crate::audio_contract::manifest::read_manifest(
            &directory.join(crate::audio_contract::manifest::MANIFEST_FILE),
        )
        .ok()
        .and_then(|manifest| serde_json::to_value(&manifest).ok())
        .unwrap_or(Value::Null);
        let aec_degraded = serde_json::from_value::<
            crate::audio_contract::manifest::TrackManifest,
        >(track_manifest.clone())
        .map(|manifest| {
            !manifest.degraded_intervals_ms.is_empty() || manifest.engine == "none"
        })
        .unwrap_or(false);
        let mut patch = Map::new();
        patch.insert("trackManifest".to_owned(), track_manifest);
        patch.insert("aecDegraded".to_owned(), json!(aec_degraded));
        patch.insert("updatedAt".to_owned(), json!(now()));
        patch.insert("error".to_owned(), Value::Null);
        update_store_value(&app, "local-transcriptions", &record_id, patch)?
            .ok_or("recording not found")?;
        log::info!("Reprocessed dual-channel recording session={session_id}");
        Ok(crate::get_store_value(&app, "local-transcriptions", &record_id)?
            .ok_or("recording not found")?)
    })
    .await
    .map_err(|error| error.to_string())?
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
    // Longest real track wins, at whatever rate it was archived: the 48 kHz
    // master and the 16 kHz recognition tracks are not interchangeable, and a
    // byte-count guess would price the master at three times its length.
    let duration_ms = [
        MASTER_TRACK_FILE,
        "mic_processed.wav",
        "mic.wav",
        "system.wav",
    ]
    .into_iter()
    .map(|name| directory.join(name))
    .filter_map(|path| inspect_wav(&path).ok())
    .filter(|info| info.frames() > 0)
    .map(|info| track_duration_ms(&info))
    .max()
    .unwrap_or_default();
    // Recovered sessions may come from either pipeline; detect from the
    // track files the sidecar managed to write.
    let dual_channel = directory.join("mic_processed.wav").exists()
        || directory.join("mic_raw.wav").exists();
    let session = LiveSession {
        session_id: manifest.session_id,
        title: manifest.title,
        source_language: RwLock::new(manifest.source_language),
        target_language: RwLock::new(manifest.target_language),
        started_at: manifest.started_at,
        state: Mutex::new("stopping".to_owned()),
        epoch: AtomicU32::new(0),
        wants_system: true,
        epoch_offset_ms: AtomicU64::new(0),
        last_elapsed_ms: AtomicU64::new(duration_ms),
        wall_start_ms: AtomicU64::new(wall_clock_ms()),
        mic_level: AtomicU32::new(0),
        system_level: AtomicU32::new(0),
        segments: Mutex::new(segments),
        routes: RwLock::new(HashMap::new()),
        handles: Mutex::new(HashMap::new()),
        child: Mutex::new(None),
        directory,
        socket_path: PathBuf::new(),
        capture_stop: Arc::new(AtomicBool::new(true)),
        wants_mic: true,
        dual_channel,
        last_voice_at: Mutex::new(Instant::now()),
        auto_stopped_silence: AtomicBool::new(false),
    };
    persist_session(app, &session)
}

/// Logical size of the recording-island window. The window hugs the pill
/// exactly — native vibrancy (`window_effects::apply_island_effects`) paints
/// the frosted capsule behind the webview. Toggling the live-transcript
/// drawer grows the window downward to [`RECORDING_ISLAND_EXPANDED_HEIGHT`]
/// via `live_translation_expand_island` (the frontend mirrors these values).
const RECORDING_ISLAND_WIDTH: f64 = 280.0;
const RECORDING_ISLAND_HEIGHT: f64 = 44.0;
const RECORDING_ISLAND_EXPANDED_HEIGHT: f64 = 480.0;

/// Generation token for the island grow/shrink animation. Each new
/// `live_translation_expand_island` call bumps it, so a rapid re-toggle makes
/// the in-flight animation thread bail on its next frame.
static ISLAND_ANIMATION_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Quintic ease-out — the "scroll snaps down" curve: a fast departure that
/// settles silky-smooth into place.
fn ease_out_quint(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(5)
}

/// Symmetric ease for the collapse, so the drawer folds back up gently.
fn ease_in_out_cubic(t: f64) -> f64 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

/// Steps the island window height towards `target_height` with an eased curve,
/// re-anchored to wherever the window currently is each frame. The webview
/// reflows live under the native vibrancy, so the frosted surface and the
/// transcript drawer unroll downward together.
fn animate_island_height(
    window: WebviewWindow,
    target_height: f64,
    expand: bool,
    generation: u64,
) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(size) = window.inner_size() else {
        return;
    };
    let from_height = size.height as f64 / scale;
    if (target_height - from_height).abs() < 0.5 {
        return;
    }
    let width = size.width as f64 / scale;
    let duration_ms = if expand { 360.0 } else { 280.0 };
    let start = Instant::now();
    loop {
        let linear = start.elapsed().as_secs_f64() * 1000.0 / duration_ms;
        let eased = if expand {
            ease_out_quint(linear.min(1.0))
        } else {
            ease_in_out_cubic(linear.min(1.0))
        };
        let height = from_height + (target_height - from_height) * eased;
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        if linear >= 1.0 || ISLAND_ANIMATION_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Positions the island pill directly below the menu-bar tray icon (top-right
/// of the screen) so it reads as a companion of the status item. Falls back
/// to top-centre when the tray rect is unavailable.
fn position_recording_island(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return;
    };
    let factor = monitor.scale_factor() as f64;
    let (mut x, mut y) = {
        let tray_x = monitor.position().x as f64 / factor;
        let tray_y = monitor.position().y as f64 / factor;
        let w = monitor.size().width as f64 / factor;
        (tray_x + (w - RECORDING_ISLAND_WIDTH) / 2.0, tray_y + 4.0)
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(Some(rect)) = tray.rect() {
            // Tray rect comes back as a dpi enum; normalise both arms to
            // logical pixels so the window position math stays consistent.
            let tray_x = match &rect.position {
                tauri::Position::Physical(p) => p.x as f64 / factor,
                tauri::Position::Logical(l) => l.x,
            };
            let tray_y = match &rect.position {
                tauri::Position::Physical(p) => p.y as f64 / factor,
                tauri::Position::Logical(l) => l.y,
            };
            let tray_w = match &rect.size {
                tauri::Size::Physical(s) => s.width as f64 / factor,
                tauri::Size::Logical(s) => s.width,
            };
            let tray_h = match &rect.size {
                tauri::Size::Physical(s) => s.height as f64 / factor,
                tauri::Size::Logical(s) => s.height,
            };
            // Right-align the island under the status item; keep it on
            // screen for edge-of-menu-bar placements.
            x = (tray_x + tray_w - RECORDING_ISLAND_WIDTH).max(0.0);
            y = tray_y + tray_h + 4.0;
        }
    }
    let _ = window.set_position(LogicalPosition::new(x, y));
}

/// True when the main window is on screen: visible and not Dock-minimized.
/// The recording island's visibility mirrors the inverse of this state.
pub(crate) fn main_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Shows (creating on first use) or hides the floating "recording island" —
/// the collapsed form of the recording page. While the main window is hidden
/// the island keeps elapsed time, live mic level and pause/stop reachable,
/// mirroring the macOS "dynamic island" interaction.
pub fn set_recording_island_visible(app: &AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window("recording-island") {
        if visible {
            reveal_recording_island(app, &window);
        } else {
            let _ = window.hide();
        }
        return;
    }
    if !visible {
        return;
    }
    let builder = WebviewWindowBuilder::new(
        app,
        "recording-island",
        WebviewUrl::App("index.html?window=recording-island".into()),
    )
    .title("Lynse Recording Island")
    .inner_size(RECORDING_ISLAND_WIDTH, RECORDING_ISLAND_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    // The pill renders its own rounded shadow inside the transparent
    // webview; the system window shadow would trace a rectangle around it.
    .shadow(false)
    // Created hidden: `reveal_recording_island` below unrolls it under the
    // tray icon instead of popping in at full size.
    .visible(false);
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            log::error!("Failed to create recording island window: {error}");
            return;
        }
    };
    // Native frosted glass behind the webview: the pill reads as a translucent
    // capsule over whatever is on screen, not a solid card.
    if let Err(error) =
        crate::window_effects::apply_island_effects(&window, RECORDING_ISLAND_HEIGHT / 2.0)
    {
        log::error!("Failed to apply recording island effects: {error}");
    }
    reveal_recording_island(app, &window);
}

/// The island's entrance: snap back below the tray icon (even if the user
/// dragged the pill elsewhere previously), show as a thin sliver hugging the
/// status bar, then unroll to full height with the drawer's quintic ease —
/// the capsule reads as growing straight out of the status-bar icon, directly
/// above which the window is anchored. Any in-flight drawer animation is
/// superseded via the shared generation token.
fn reveal_recording_island(app: &AppHandle, window: &tauri::WebviewWindow) {
    position_recording_island(app, window);
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(size) = window.inner_size() else {
        let _ = window.show();
        return;
    };
    let width = size.width as f64 / scale;
    // Re-showing while the transcript drawer is open unrolls back to the
    // expanded height; normally this is the compact pill height.
    let target_height = (size.height as f64 / scale).max(RECORDING_ISLAND_HEIGHT);
    let generation = ISLAND_ANIMATION_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = window.set_size(tauri::LogicalSize::new(width, 12.0));
    let _ = window.show();
    let window = window.clone();
    thread::spawn(move || animate_island_height(window, target_height, true, generation));
}

/// Grows or shrinks the recording-island window between the compact pill and
/// the expanded live-transcript drawer. The window is top-anchored under the
/// tray icon, so expanding always unfolds downward, dynamic-island style. The
/// height change is eased over ~1/3 of a second (see `animate_island_height`)
/// instead of snapping, so the drawer reads as a scroll unrolling.
#[tauri::command]
pub fn live_translation_expand_island(app: AppHandle, expand: bool) -> CommandResult<()> {
    let Some(window) = app.get_webview_window("recording-island") else {
        return Ok(());
    };
    let generation = ISLAND_ANIMATION_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let target_height = if expand {
        RECORDING_ISLAND_EXPANDED_HEIGHT
    } else {
        RECORDING_ISLAND_HEIGHT
    };
    // The animation runs off the command thread and returns immediately, so
    // the frontend can mount the drawer while the window is still unrolling.
    thread::spawn(move || animate_island_height(window, target_height, expand, generation));
    Ok(())
}

/// Hides the recording-island mini window (user tapped its close button).
/// Recording keeps running — the tray menu remains the control surface.
#[tauri::command]
pub fn live_translation_hide_island(app: AppHandle) -> CommandResult<()> {
    set_recording_island_visible(&app, false);
    Ok(())
}

/// Restores (shows + focuses) the main window — invoked from the recording
/// island when the user expands the collapsed recording UI back to the full
/// page.
#[tauri::command]
pub fn live_translation_show_main(app: AppHandle) -> CommandResult<()> {
    crate::show_main_window(&app);
    Ok(())
}

/// Hides the main window (the recording page's "collapse to tray" buttons).
/// While a session runs, the recording island takes over as the on-screen
/// control surface so the session stays reachable without the main window;
/// when idle, hiding is just the plain tray-app hide.
#[tauri::command]
pub fn live_translation_hide_main(
    app: AppHandle,
    state: State<'_, LiveTranslationManager>,
) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if state.has_active_session() {
        set_recording_island_visible(&app, true);
    }
    Ok(())
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

/// Update the system tray icon tooltip to reflect the current recording state.
/// Called from the webview on every significant state change (start, stop,
/// pause, resume) and periodically while recording so the tooltip timer stays
/// in sync — this is the "Dynamic Island" for the menu bar / tray area.
#[derive(Deserialize)]
pub struct TrayUpdatePayload {
    pub recording: bool,
    pub paused: bool,
    #[serde(default)]
    pub elapsed_secs: u64,
}

#[tauri::command]
pub fn live_translation_update_tray(app: AppHandle, payload: TrayUpdatePayload) -> CommandResult<()> {
    let tooltip = if payload.recording {
        if payload.paused {
            format!("Lynse — {:.0}s paused", payload.elapsed_secs)
        } else {
            let mins = payload.elapsed_secs / 60;
            let secs = payload.elapsed_secs % 60;
            format!("Lynse — \u{23FA} Recording  {mins}:{secs:02}")
        }
    } else {
        "Lynse".to_string()
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }
    // Mirror the state so the menu builder can pick it up. The menu is only
    // rebuilt when the (recording, paused) flags actually change — rebuilding
    // on every 200 ms tick would replace the NSMenu while it is open, making
    // it unclickable and collapsing it on any mouse movement. The tooltip is
    // cheap and stays live via the tick above.
    {
        let state = app.state::<crate::AppState>();
        let mut changed = false;
        if let Ok(mut guard) = state.tray_ui.lock() {
            changed =
                guard.recording != payload.recording || guard.paused != payload.paused;
            *guard = crate::TrayUiState {
                recording: payload.recording,
                paused: payload.paused,
                elapsed_secs: payload.elapsed_secs,
            };
        }
        if changed {
            crate::rebuild_tray_menu(&app)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Windows live-translation audio capture (dual-track).
//
// There is no Swift `audio-capture` sidecar on Windows: the WASAPI engine in
// `windows_capture` captures the system mixdown (loopback) and the microphone
// in-process, runs the shared echo-canceller contract, and streams the same
// 640-byte 16 kHz mono PCM frames macOS produces into `enqueue_audio`. Raw
// and processed tracks land in the session directory under a versioned
// `manifest.json` (see `audio_contract`).
// ---------------------------------------------------------------------------
// The Windows capture engine instance for the active session. Only one live
// session can exist at a time (enforced by the manager), so a module-level
// holder keeps pause/resume/stop reachable from the shared commands without
// threading an engine handle through the platform-agnostic LiveSession.
#[cfg(target_os = "windows")]
static WINDOWS_ENGINE: Mutex<Option<Arc<crate::windows_capture::CaptureEngine>>> = Mutex::new(None);

#[cfg(target_os = "windows")]
fn set_windows_engine(engine: Arc<crate::windows_capture::CaptureEngine>) {
    *WINDOWS_ENGINE
        .lock()
        .expect("windows engine lock") = Some(engine);
}

#[cfg(target_os = "windows")]
fn take_windows_engine() -> Option<Arc<crate::windows_capture::CaptureEngine>> {
    WINDOWS_ENGINE
        .lock()
        .expect("windows engine lock")
        .take()
}

#[cfg(target_os = "windows")]
fn with_windows_engine<R>(apply: impl FnOnce(&crate::windows_capture::CaptureEngine) -> R) -> Option<R> {
    let engine = WINDOWS_ENGINE
        .lock()
        .expect("windows engine lock")
        .clone();
    engine.as_deref().map(apply)
}

/// True while the capture engine of the current session is still running.
#[cfg(target_os = "windows")]
fn windows_engine_running() -> bool {
    WINDOWS_ENGINE
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

/// In-process WASAPI dual-track capture: system loopback + microphone through
/// the shared echo-canceller contract (`windows_capture` + `audio_contract`).
/// Mirrors the macOS sidecar's control surface: raw + processed tracks land in
/// the session directory, recognition frames surface as engine events, and
/// stop drains every queue before the writers' headers are fixed.
#[cfg(target_os = "windows")]
fn start_windows_capture(
    app: &AppHandle,
    session: &Arc<LiveSession>,
    config: crate::windows_capture::CaptureConfig,
) -> CommandResult<()> {
    use crate::windows_capture::{CaptureEngine, EngineEvent, Sources};

    let sources = Sources {
        mic: session.wants_mic,
        system: session.wants_system,
    };
    log::info!(
        "Windows dual-track capture starting: session={} mic={} system={}",
        session.session_id,
        sources.mic,
        sources.system
    );
    let engine = Arc::new(CaptureEngine::start(config, sources, session.directory.clone())?);
    set_windows_engine(engine.clone());

    // Event pump: engine events play the role of the macOS sidecar's stdout
    // JSON lines and audio socket frames.
    let mut stopping = false;
    loop {
        if !stopping && !session.capture_stop.load(Ordering::Relaxed) {
            stopping = true;
            // Joins the capture threads, fixes the WAV headers and finalises
            // the track manifest before persist_session reads the files.
            engine.stop();
        }
        match engine.recv_event_timeout(Duration::from_millis(100)) {
            Some(EngineEvent::Stopped) => break,
            Some(event) => handle_engine_event(app, session, event),
            None if stopping && engine.is_done() => break,
            None => {}
        }
    }
    take_windows_engine();
    log::info!(
        "Windows dual-track capture finished: session={}",
        session.session_id
    );
    Ok(())
}

/// Map engine events onto the same in-app surface the macOS sidecar feeds.
#[cfg(target_os = "windows")]
fn handle_engine_event(
    app: &AppHandle,
    session: &Arc<LiveSession>,
    event: crate::windows_capture::EngineEvent,
) {
    use crate::windows_capture::EngineEvent;
    match event {
        EngineEvent::Ready { mic, system } => {
            log::info!(
                "Live translation recording started (session={}, mic={:?}, system={:?})",
                session.session_id,
                mic.as_ref().map(|d| d.name.clone()),
                system.as_ref().map(|d| d.name.clone())
            );
            session.set_state("recording");
            // A fresh capture (re)start also restarts the silence window.
            session.mark_voice_activity();
            emit_snapshot(app, session);
        }
        EngineEvent::Diagnostic(message) => {
            log::info!("Capture diagnostic: {message}");
        }
        EngineEvent::Levels { mic, system } => {
            session.mic_level.store(mic.to_bits(), Ordering::Relaxed);
            session.system_level.store(system.to_bits(), Ordering::Relaxed);
            // The watchdog must check BOTH sources: a remote speaker talking
            // alone is a live meeting, not an empty room.
            if mic > MIC_SILENCE_LEVEL || (session.wants_system && system > MIC_SILENCE_LEVEL) {
                session.mark_voice_activity();
            }
        }
        EngineEvent::AudioFrame {
            source,
            elapsed_ms,
            bytes,
        } => match AudioSource::from_byte(source) {
            Some(source) => enqueue_audio(session, source, elapsed_ms, bytes),
            None => log::warn!("dropping engine frame with unknown source byte {source}"),
        },
        EngineEvent::Stopped => {}
    }
}

/// Wait until the capture engine fully stopped (writers closed, manifest
/// written) so persist_session reads final files. Bounded: a wedged device
/// must not stall the save path forever.
#[cfg(target_os = "windows")]
async fn wait_windows_capture_done() {
    let deadline = Instant::now() + Duration::from_secs(8);
    while windows_engine_running() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
async fn wait_windows_capture_done() {}
#[cfg(test)]
mod tests {
    use super::*;

    fn live_session() -> LiveSession {
        LiveSession {
            session_id: "session".to_owned(),
            title: "test".to_owned(),
            source_language: RwLock::new("zh".to_owned()),
            target_language: RwLock::new("en".to_owned()),
            started_at: now(),
            state: Mutex::new("recording".to_owned()),
            epoch: AtomicU32::new(0),
            epoch_offset_ms: AtomicU64::new(0),
            last_elapsed_ms: AtomicU64::new(0),
            wall_start_ms: AtomicU64::new(0),
            mic_level: AtomicU32::new(0),
            system_level: AtomicU32::new(0),
            segments: Mutex::new(Vec::new()),
            routes: RwLock::new(HashMap::new()),
            handles: Mutex::new(HashMap::new()),
            child: Mutex::new(None),
            capture_stop: Arc::new(AtomicBool::new(true)),
            wants_mic: true,
            wants_system: true,
            dual_channel: false,
            last_voice_at: Mutex::new(Instant::now()),
            auto_stopped_silence: AtomicBool::new(false),
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
            speaker: None,
            recognized_final: true,
            translated_final: false,
        }
    }

    #[test]
    fn silence_watchdog_needs_recording_state_and_full_window() {
        assert!(!silence_expired("recording", Duration::from_secs(59)));
        assert!(silence_expired("recording", SILENCE_AUTO_STOP));
        // Only a live recording can be auto-stopped: paused and connecting
        // freeze the window, anything else means the session is already gone.
        assert!(!silence_expired("paused", SILENCE_AUTO_STOP));
        assert!(!silence_expired("connecting", SILENCE_AUTO_STOP));
        assert!(!silence_expired("stopping", SILENCE_AUTO_STOP));
    }

    #[test]
    fn reconnect_backoff_doubles_then_caps() {
        assert_eq!(live_reconnect_backoff(1), Duration::from_millis(500));
        assert_eq!(live_reconnect_backoff(2), Duration::from_millis(1_000));
        assert_eq!(live_reconnect_backoff(3), Duration::from_millis(2_000));
        // A long outage keeps probing at the capped cadence instead of
        // growing the wait without bound.
        assert_eq!(live_reconnect_backoff(20), LIVE_RECONNECT_BACKOFF_MAX);
        // Defensive: a zero streak must not shift into overflow territory.
        assert_eq!(live_reconnect_backoff(0), Duration::from_millis(500));
    }

    #[test]
    fn drain_drops_stale_audio_but_reports_voice_end() {
        let (tx, mut rx) = unbounded_channel::<WsCommand>();
        tx.send(WsCommand::Audio(vec![1, 2, 3])).unwrap();
        tx.send(WsCommand::Audio(vec![4])).unwrap();
        assert!(!drain_stale_audio(&mut rx));
        assert!(rx.try_recv().is_err(), "stale audio must be dropped");

        tx.send(WsCommand::Audio(vec![5])).unwrap();
        tx.send(WsCommand::VoiceEnd).unwrap();
        tx.send(WsCommand::Audio(vec![6])).unwrap();
        drop(tx);
        // VoiceEnd ends the drain immediately: the session paused or stopped
        // while the stream was down, so the loop must not reconnect.
        assert!(drain_stale_audio(&mut rx));
    }

    #[test]
    fn voice_activity_resets_the_silence_clock() {
        let session = live_session();
        // Simulate a session that has been silent since capture started.
        *session
            .last_voice_at
            .lock()
            .expect("live last voice lock") = Instant::now() - SILENCE_AUTO_STOP;
        session.mark_voice_activity();
        let elapsed = session
            .last_voice_at
            .lock()
            .expect("live last voice lock")
            .elapsed();
        assert!(
            elapsed < SILENCE_CHECK_INTERVAL,
            "mark_voice_activity must re-base the silence window"
        );
        // Recognized provider speech marks activity (recognized + non-empty).
        session.mark_voice_activity();
        assert!(!silence_expired(
            "recording",
            session
                .last_voice_at
                .lock()
                .expect("live last voice lock")
                .elapsed()
        ));
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
    fn deduplicates_chinese_system_echo_from_microphone() {
        let mut segments = vec![
            segment(
                "system",
                AudioSource::System,
                "我们明天上午发布新版本",
                1_000,
            ),
            segment("mic", AudioSource::Mic, "我们明天上午发布新版本", 1_200),
        ];
        deduplicate_echoes(&mut segments);
        assert_eq!(segments[1].echo_of.as_deref(), Some("system"));
    }

    #[test]
    fn keeps_distinct_chinese_utterances() {
        let mut segments = vec![
            segment(
                "system",
                AudioSource::System,
                "这个季度营收增长了百分之二十",
                1_000,
            ),
            segment("mic", AudioSource::Mic, "我觉得下个月可以安排一次评审", 1_200),
        ];
        deduplicate_echoes(&mut segments);
        assert_eq!(segments[1].echo_of, None);
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
    fn rebases_absolute_provider_timestamps_onto_the_recording_timeline() {
        let session = live_session();
        session
            .wall_start_ms
            .store(1_788_000_000_000, Ordering::Relaxed);
        let text = json!({
            "method": "recognizedResult",
            "asr": "你好",
            "startTs": 1_788_000_006_500u64,
            "endTs": 1_788_000_009_000u64,
        })
        .to_string();
        let Some(ProviderEmission::Segments(segments)) =
            apply_provider_message(&session, AudioSource::Mic, 0, 0, &text)
        else {
            panic!("expected a segments emission");
        };
        let segment = segments.first().expect("one ingested segment");
        assert_eq!(segment.start_ms, 6_500);
        assert_eq!(segment.end_ms, Some(9_000));
    }

    #[test]
    fn keeps_relative_provider_timestamps_anchored_to_the_stream() {
        let session = live_session();
        let text = json!({
            "method": "recognizedResult",
            "asr": "hello",
            "startTs": 1_500u64,
            "endTs": 2_500u64,
        })
        .to_string();
        let Some(ProviderEmission::Segments(segments)) =
            apply_provider_message(&session, AudioSource::Mic, 0, 3_000, &text)
        else {
            panic!("expected a segments emission");
        };
        let segment = segments.first().expect("one ingested segment");
        assert_eq!(segment.start_ms, 4_500);
        assert_eq!(segment.end_ms, Some(5_500));
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
                provider: None,
                api_key: None,
                extra: None,
            },
            ConnectionDescriptor {
                source: AudioSource::System,
                url: "wss://example.test/system".to_owned(),
                provider: None,
                api_key: None,
                extra: None,
            },
        ];
        assert!(validate_connections(&valid).is_ok());
        let duplicate = vec![valid[0].clone(), valid[0].clone()];
        assert!(validate_connections(&duplicate).is_err());
        let insecure = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: "ws://example.test/mic".to_owned(),
            provider: None,
            api_key: None,
            extra: None,
        }];
        assert!(validate_connections(&insecure).is_err());
    }

    #[test]
    fn requires_api_key_for_qwen_connections() {
        let missing_key = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime".to_owned(),
            provider: Some("qwen".to_owned()),
            api_key: None,
            extra: None,
        }];
        assert!(validate_connections(&missing_key).is_err());
        let with_key = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime".to_owned(),
            provider: Some("qwen".to_owned()),
            api_key: Some("sk-test".to_owned()),
            extra: None,
        }];
        assert!(validate_connections(&with_key).is_ok());
    }

    #[test]
    fn requires_access_key_for_volc_connections() {
        let missing_key = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: volc_ast::DEFAULT_ENDPOINT.to_owned(),
            provider: Some("volc".to_owned()),
            api_key: None,
            extra: None,
        }];
        assert!(validate_connections(&missing_key).is_err());
        let with_key = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: volc_ast::DEFAULT_ENDPOINT.to_owned(),
            provider: Some("volc".to_owned()),
            api_key: Some("access-test".to_owned()),
            extra: None,
        }];
        assert!(validate_connections(&with_key).is_ok());
    }

    #[test]
    fn requires_tencent_credentials_in_extra() {
        let base_url = "wss://asr.cloud.tencent.com/asr/v2/125000000";
        let missing = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: base_url.to_owned(),
            provider: Some("tencent".to_owned()),
            api_key: None,
            extra: None,
        }];
        assert!(validate_connections(&missing).is_err());
        let mut map = HashMap::new();
        map.insert("secretId".to_owned(), "AKID".to_owned());
        map.insert("secretKey".to_owned(), "key".to_owned());
        let with_creds = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: base_url.to_owned(),
            provider: Some("tencent".to_owned()),
            api_key: None,
            extra: Some(map),
        }];
        assert!(validate_connections(&with_creds).is_ok());
    }

    #[test]
    fn maps_lynse_language_selection_to_volc_pair() {
        // `auto` turns on server-side detection and leaves the source empty.
        assert_eq!(
            volc_languages("auto", "en"),
            (String::new(), "en".to_owned(), true),
        );
        // Transcript-only still needs a valid target; pick one that differs
        // from the source so AST never rejects the pair.
        assert_eq!(
            volc_languages("zh", "none"),
            ("zh".to_owned(), "en".to_owned(), false),
        );
        assert_eq!(
            volc_languages("en", "none"),
            ("en".to_owned(), "zh".to_owned(), false),
        );
        // Auto + transcript-only: empty source is not `zh`, so target is `zh`.
        assert_eq!(
            volc_languages("auto", "none"),
            (String::new(), "zh".to_owned(), true),
        );
        assert_eq!(
            volc_languages("ja", "zh"),
            ("ja".to_owned(), "zh".to_owned(), false),
        );
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
    fn coalesces_repeated_final_results_on_the_same_stream() {
        let session = live_session();
        // Some providers emit the same final utterance more than once (e.g. a
        // late correction or duplicate flush). The second final must refresh
        // the existing card instead of spawning a duplicate bubble.
        let interim = r#"{"method":"recognizedTempResult","streamId":"9","taskId":"a1","startTs":"20","endTs":"0","asr":"一、二三四，五六七"}"#;
        let final1 = r#"{"method":"recognizedResult","streamId":"9","taskId":"a2","startTs":"20","endTs":"80","asr":"一、二三四，五六七。"}"#;
        let final2 = r#"{"method":"recognizedResult","streamId":"9","taskId":"a3","startTs":"20","endTs":"80","asr":"一、二三四，五六七。"}"#;
        apply_provider_message(&session, AudioSource::Mic, 0, 0, interim).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 0, 0, final1).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 0, 0, final2).unwrap();
        let segments = session.segments.lock().unwrap();
        assert_eq!(
            segments.len(),
            1,
            "repeated recognizedResult on the same stream must coalesce"
        );
        assert_eq!(segments[0].recognized_text, "一、二三四，五六七。");
        assert!(segments[0].recognized_final);
    }

    #[test]
    fn keeps_correcting_within_a_single_segment() {
        let session = live_session();
        // The provider rewrites the sentence mid-stream with a correction that is
        // NOT a strict prefix of the previous text (e.g. "五、六。" -> "五六七").
        // This used to open a new card per correction, duplicating the utterance.
        let m1 = r#"{"method":"recognizedTempResult","streamId":"9","taskId":"a1","startTs":"20","endTs":"0","asr":"hello world foo"}"#;
        let m2 = r#"{"method":"recognizedTempResult","streamId":"9","taskId":"a2","startTs":"20","endTs":"0","asr":"hello world bar"}"#;
        let m3 = r#"{"method":"recognizedResult","streamId":"9","taskId":"a3","startTs":"20","endTs":"80","asr":"hello world bar baz"}"#;
        apply_provider_message(&session, AudioSource::Mic, 0, 0, m1).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 0, 0, m2).unwrap();
        apply_provider_message(&session, AudioSource::Mic, 0, 0, m3).unwrap();
        let segments = session.segments.lock().unwrap();
        assert_eq!(segments.len(), 1, "corrections must refresh the same card");
        assert_eq!(segments[0].recognized_text, "hello world bar baz");
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
    fn build_playback_wav_copies_single_source_and_sums_dual_sources() {
        let directory = std::env::temp_dir().join(format!("lynse-mix-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();

        // Single source: the file must be copied verbatim (no re-encode).
        let mic = directory.join("mic.wav");
        write_pcm16_wav(&mic, &[100, -200, 300]).unwrap();
        let playback = directory.join("playback.wav");
        build_playback_wav(None, Some(&mic), None, &playback).unwrap();
        let copied = fs::read(&playback).unwrap();
        let original = fs::read(&mic).unwrap();
        assert_eq!(copied, original, "single source must copy byte-for-byte");

        // Dual source: samples are summed (never averaged — averaging cost both
        // tracks 6 dB), clamped at full scale, and the shorter stream is padded
        // with silence past its end.
        let system = directory.join("system.wav");
        write_pcm16_wav(&system, &[100, 100, i16::MAX, i16::MAX]).unwrap();
        build_playback_wav(None, Some(&mic), Some(&system), &playback).unwrap();
        let bytes = fs::read(&playback).unwrap();
        let data = &bytes[44..];
        let sample = |index: usize| i16::from_le_bytes([data[index * 2], data[index * 2 + 1]]);
        assert_eq!(data.len() / 2, 4, "output spans the longer source");
        assert_eq!(sample(0), 200, "100 + 100, at unity gain");
        assert_eq!(sample(1), -100);
        assert_eq!(sample(2), i16::MAX, "300 + i16::MAX saturates instead of folding");
        assert_eq!(sample(3), i16::MAX, "past mic's end the system tail keeps full gain");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn repair_capture_headers_fixes_the_raw_tracks_too() {
        // A killed sidecar leaves every track with a zero-length `data` chunk.
        // The reprocessor reads the raws through a reader that rejects that, so
        // repairing only the finished tracks would fail reprocessing *after* it
        // deleted them.
        let directory =
            std::env::temp_dir().join(format!("lynse-repair-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let format = crate::audio_contract::wav::WavFormat {
            sample_rate: 48_000,
            channels: 1,
            bits_per_sample: 16,
            sample_format: "int",
        };
        let torn = vec![directory.join(MASTER_TRACK_FILE), directory.join("mic_raw.wav"), directory.join("system_raw.wav")];
        for path in &torn {
            let writer = crate::audio_contract::wav::WavTrackWriter::raw(path, format).unwrap();
            writer.write_i16_at(0, &vec![42i16; 480]).unwrap();
            drop(writer); // never closed — header stays a placeholder
            let bytes = fs::read(path).unwrap();
            assert_eq!(&bytes[40..44], &0u32.to_le_bytes());
        }

        repair_capture_headers(&directory);

        for path in &torn {
            let info = crate::audio_contract::wav::inspect(path).unwrap();
            assert_eq!(info.frames(), 480, "{} lost audio", path.display());
            assert!(
                info.header_matches_contents(fs::metadata(path).unwrap().len()),
                "{} header still lies",
                path.display()
            );
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn build_playback_wav_prefers_the_48k_master_over_the_recognition_tracks() {
        let directory = std::env::temp_dir().join(format!("lynse-master-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();

        let format = crate::audio_contract::wav::WavFormat {
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: 16,
            sample_format: "int",
        };
        let master = directory.join(MASTER_TRACK_FILE);
        let writer = crate::audio_contract::wav::WavTrackWriter::raw(&master, format).unwrap();
        // Two stereo frames: (1000, 2000) then (3000, 4000).
        writer.write_i16_at(0, &[1000, 2000, 3000, 4000]).unwrap();
        writer.close().unwrap();

        let mic = directory.join("mic.wav");
        write_pcm16_wav(&mic, &[1, 2, 3]).unwrap();
        let system = directory.join("system.wav");
        write_pcm16_wav(&system, &[4, 5, 6]).unwrap();

        let playback = directory.join("playback.wav");
        build_playback_wav(
            Some(&master),
            Some(&mic),
            Some(&system),
            &playback,
        )
        .unwrap();
        let info = crate::audio_contract::wav::inspect(&playback).unwrap();
        assert_eq!(info.format, format, "master keeps its bandwidth");
        assert_eq!(info.frames(), 2);
        let bytes = fs::read(&playback).unwrap();
        let expected: Vec<u8> = [1000i16, 2000, 3000, 4000]
            .into_iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        assert_eq!(&bytes[44..], &expected[..], "payload must be the master, not the 16k tracks");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn build_playback_wav_recovers_a_track_whose_header_was_never_patched() {
        let directory = std::env::temp_dir().join(format!("lynse-stale-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();

        // The sidecar was killed before close(): 320 samples behind a header
        // that still declares zero data bytes.
        let mic = directory.join("mic.wav");
        let writer =
            crate::audio_contract::wav::WavTrackWriter::recognition(&mic).unwrap();
        writer.write_i16_at(0, &vec![500i16; 320]).unwrap();
        drop(writer);
        let raw = fs::read(&mic).unwrap();
        assert_eq!(&raw[40..44], &0u32.to_le_bytes(), "header stays unpatched");

        let playback = directory.join("playback.wav");
        build_playback_wav(None, Some(&mic), None, &playback).unwrap();
        let info = crate::audio_contract::wav::inspect(&playback).unwrap();
        assert_eq!(info.frames(), 320, "audio must survive the torn header");
        let bytes = fs::read(&playback).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[40..44].try_into().unwrap()),
            640,
            "the written header is honest"
        );
        let _ = fs::remove_dir_all(directory);
    }
}
