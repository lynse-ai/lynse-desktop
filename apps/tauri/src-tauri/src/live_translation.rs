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
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

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

/// How long a fresh session may stay in "connecting" before the start is
/// declared failed with a user-facing reason. Normally the capture engine (or
/// the macOS sidecar) reports ready within a couple of seconds; a wedged
/// audio device otherwise leaves the UI spinning forever with no explanation.
const CAPTURE_START_TIMEOUT: Duration = Duration::from_secs(20);

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
/// Inbound traffic only clears the reconnect backoff once the connection has
/// lived this long. A gate that accepts the handshake, emits one frame and
/// dies (bad key, unknown model) must keep the streak growing — otherwise it
/// zeroes the streak every cycle and the stream spins at 500 ms forever.
const LIVE_CONNECTION_GRACE: Duration = Duration::from_secs(2);

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

/// Wire-protocol adapters, one per on-the-wire translation protocol. All
/// providers converge on the same `LiveSegment` model; only framing and auth
/// differ. Selected per connection descriptor by `protocols::protocol_for`.
mod protocols;

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
    /// Speech enhancement on the microphone path (noise suppression +
    /// high-pass). Absent means off. It rides the canceller's audio-processing
    /// module, so it takes effect on the dual-channel path; the raw capture
    /// tracks stay untouched either way and can be reprocessed later.
    #[serde(default)]
    voice_enhancement: Option<bool>,
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
    /// RFC3339 recording start time; the cloud-sync upload sends it along
    /// as `recordStartTime` so the backend can align the file's create time.
    started_at: String,
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
    /// Provider of the translation connections attached at start. Absent in
    /// manifests written before the field existed; defaults to the generic
    /// label on recovery instead of failing the read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
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
    /// Microphone speech enhancement requested for this session.
    voice_enhancement: bool,
    /// False for mic-only sessions: no system mixdown is captured.
    wants_system: bool,
    /// Last instant the session saw evidence of voice — a recognized provider
    /// segment or a mic level above [`MIC_SILENCE_LEVEL`]. Re-based whenever
    /// capture (re)starts so a resume gets a fresh silence window.
    last_voice_at: Mutex<Instant>,
    /// Set by the silence watchdog when it stops the session, so the
    /// completed payload can tell the UI why the recording ended.
    auto_stopped_silence: AtomicBool,
    /// Provider name of the translation connections currently attached
    /// (`None` for pure recording / the backend relay). Recorded so the
    /// persisted record names the engine that actually produced the
    /// transcript instead of a hard-coded label.
    attached_provider: Mutex<Option<String>>,
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
    let message = message.into();
    // The event is transient UI state; the file log is the durable record
    // bug reports are pasted from. Never let a surfaced failure be invisible
    // there — every connect/close/provider failure funnels through here.
    log::warn!("Live translation error source={source:?}: {message}");
    let _ = app.emit(
        LIVE_EVENT,
        json!({ "type": "error", "source": source, "message": message }),
    );
}

fn emit_stream_state(app: &AppHandle, source: AudioSource, state: &str, epoch: u32) {
    // "connecting" is logged per attempt inside the websocket loop.
    if state != "connecting" {
        log::info!("Live translation stream {source:?} now {state} (epoch {epoch})");
    }
    let _ = app.emit(
        LIVE_EVENT,
        json!({ "type": "streamState", "source": source, "state": state, "epoch": epoch }),
    );
}

/// Echo cancellation on the microphone path. On by default; `LYNSE_AEC=0`
/// bypasses the canceller while still archiving the raw 48 kHz tracks and the
/// master, so an A/B comparison stays one environment variable away. Live
/// capture, the Windows engine and offline reprocessing all read this switch —
/// they must not disagree, or reprocessing would rewrite a session's audio in
/// a shape capture never produced.
pub(crate) fn aec_enabled() -> bool {
    !matches!(std::env::var("LYNSE_AEC").as_deref(), Ok("0"))
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
    #[cfg(target_os = "windows")]
    {
        // Say WHY a start cannot proceed when the machine has no usable audio
        // endpoint for a requested source; the WASAPI probe would otherwise
        // surface (at best) a raw HRESULT string in a corner Alert.
        let devices = crate::windows_capture::enumerate_devices();
        let mut missing: Vec<&str> = Vec::new();
        if request.wants_mic() && devices.inputs.is_empty() {
            missing.push("麦克风");
        }
        if request.wants_system() && devices.outputs.is_empty() {
            missing.push("扬声器/耳机");
        }
        if !missing.is_empty() {
            log::warn!(
                "Live translation start rejected: no audio device (missing {missing:?})"
            );
            return Err(format!(
                "未检测到可用的{}，无法开始录音。请在 Windows「设置 → 系统 → 声音」中启用音频设备后重试。",
                missing.join(" 和 ")
            ));
        }
    }
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
        voice_enhancement: request.voice_enhancement.unwrap_or(false),
        last_voice_at: Mutex::new(Instant::now()),
        auto_stopped_silence: AtomicBool::new(false),
        attached_provider: Mutex::new(None),
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
        provider: connections_provider(&request.connections),
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
        if session.dual_channel && aec_enabled() {
            command.arg("--aec");
            if session.voice_enhancement {
                // 1 = mild. The aggressive level is reachable later through the
                // same argument; a toggle is enough for the UI for now.
                command.arg("--enhance").arg("1");
            }
        } else if session.voice_enhancement {
            log::warn!(
                "voice enhancement requested but the canceller is inactive (session={} dual_channel={}); skipping",
                session.session_id,
                session.dual_channel
            );
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
            "Live translation capture spawned: session={} socket={} sources={sources_argument} aec={}",
            session.session_id,
            session.socket_path.display(),
            if aec_enabled() { "on" } else { "off" }
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
            // `--aec`). NOTE: unlike the macOS sidecar, the Windows engine
            // still couples raw tracks to the canceller, so switching AEC off
            // there also drops back to the 16 kHz layout — split it the same
            // way before trusting a Windows A/B comparison.
            aec_enabled: session.dual_channel && aec_enabled(),
        };
        thread::spawn(move || {
            if let Err(error) = start_windows_capture(&win_app, &win_session, win_config) {
                // The error string is the only record of WHY the engine
                // refused — without this line a failed start is invisible
                // in the logs (the UI event alone proved easy to miss).
                log::error!("Windows capture failed to start: {error}");
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
    spawn_capture_start_watchdog(app.clone(), session.clone());
    set_card_feed_target(&session);
    emit_snapshot(&app, &session);
    // The island webview is the only receiver for the tray's pause/stop
    // actions, so it must exist for the session's whole life. Pop it when the
    // main window is out of sight (hidden to the tray or Dock-minimized);
    // otherwise create it hidden — no duplicate pill on screen while the
    // recording page and the in-app float dock own the controls, but the tray
    // keeps a live receiver either way.
    if main_window_visible(&app) {
        ensure_recording_island_window(&app);
    } else {
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

/// Provider name for a connection set — the same rule `spawn_connections`
/// uses to stamp `LiveSession::attached_provider` and the recovery manifest.
/// The first connection speaks for the session (sources share one provider);
/// a descriptor without a provider name is the backend relay.
fn connections_provider(connections: &[ConnectionDescriptor]) -> Option<String> {
    connections.first().map(|first| {
        first
            .provider
            .clone()
            .unwrap_or_else(|| "lynse_backend".to_owned())
    })
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
    // Remember which provider the transcript is actually coming from, before
    // the descriptors are consumed by the loop below.
    if let Some(provider) = connections_provider(&connections) {
        *session
            .attached_provider
            .lock()
            .expect("live provider lock") = Some(provider);
    }
    for connection in connections {
        let (sender, receiver) = unbounded_channel();
        routes.insert(connection.source, sender);
        let app = app.clone();
        let session = session.clone();
        // Transcript-only mode is baked into the adapter at spawn: it decides
        // whether the provider is asked for a (fake) translation target.
        let transcript_only = session
            .target_language
            .read()
            .expect("live target language")
            .as_str()
            == "none";
        let adapter = protocols::protocol_for(&connection, transcript_only)?;
        let handle = tauri::async_runtime::spawn(async move {
            websocket_loop(
                app,
                session,
                connection.source,
                epoch,
                epoch_offset_ms,
                connection.url,
                receiver,
                adapter,
            )
            .await;
        });
        handles.insert(connection.source, handle);
    }
    Ok(())
}

/// True when a credential contains characters outside printable ASCII.
/// Zero-width spaces and other invisible characters ride along when keys are
/// copied out of chat apps or PDFs, and they silently break either the
/// websocket auth header (HeaderValue rejects non-visible ASCII — the header
/// is then skipped without a word) or the provider-side signature. Failing at
/// start with a nameable cause beats a mystery 401 from the provider.
fn credential_has_invisible_chars(value: &str) -> bool {
    value
        .chars()
        .any(|ch| !(0x21..=0x7e).contains(&(ch as u32)))
}

/// Masked key fingerprint for logs: enough to tell WHICH stored key a session
/// is using (first 6 chars + length) without leaking the secret — the first
/// question when a provider rejects auth is "is the app even holding the key
/// I entered?".
fn credential_fingerprint(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => format!(
            "{}…(len {})",
            key.chars().take(6).collect::<String>(),
            key.chars().count()
        ),
        None => "none".to_owned(),
    }
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
        if credential_has_invisible_chars(api_key) {
            return Err(
                "引擎密钥包含不可见字符（复制时可能带入了隐藏字符），请删除后重新输入。".to_owned(),
            );
        }
        let adapter = protocols::protocol_for(connection, false)?;
        adapter.validate()?;
    }
    // Record which upstream endpoints this session will actually dial. The
    // query string is reduced to `model=` so signed one-shot parameters
    // (Tencent signature, iLiveData token) never reach the log, while the
    // Qwen realtime model name stays visible — misdirected model versus
    // rejected API key is the first fork in diagnosing a connect 401.
    for connection in connections {
        log::info!(
            "Live translation endpoint attached: source={:?} provider={} url={} key={}",
            connection.source,
            connection.provider.as_deref().unwrap_or("backend"),
            endpoint_log_label(&connection.url),
            credential_fingerprint(connection.api_key.as_deref()),
        );
    }
    Ok(())
}

/// Redact a connection URL for logging: keep the address and the `model=`
/// query parameter, drop every other query entry (signed one-shot values).
fn endpoint_log_label(url: &str) -> String {
    let (base, query) = match url.split_once('?') {
        Some((base, query)) => (base, query),
        None => return url.to_owned(),
    };
    match query.split('&').find_map(|pair| pair.strip_prefix("model=")) {
        Some(model) => format!("{base}?model={model}"),
        None => base.to_owned(),
    }
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

async fn websocket_loop(
    app: AppHandle,
    session: Arc<LiveSession>,
    source: AudioSource,
    epoch: u32,
    epoch_offset_ms: u64,
    url: String,
    mut receiver: UnboundedReceiver<WsCommand>,
    mut adapter: Box<dyn protocols::LiveProtocol + Send>,
) {
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
        // Provider auth rides on the upgrade: Tencent re-signs the URL per
        // attempt (one-shot voice_id), DashScope sends its Bearer key and
        // Volcengine its X-Api-Key headers. A prepare failure is a config
        // error that reconnecting cannot fix — stop the stream for good.
        if let Err(error) = adapter.prepare_request(&url, &mut request) {
            emit_error(&app, Some(source), error);
            break;
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
                // Provider session setup right after the handshake (DashScope
                // `session.update`, Volc `StartSession`). Send failures redial.
                let ctx = protocols::ProtocolCtx {
                    session: &session,
                    source,
                    epoch,
                    epoch_offset_ms: stream_offset_ms,
                };
                match adapter.on_connected(&ctx) {
                    Ok(frames) => {
                        let mut setup_failed = false;
                        for (frame, label) in frames {
                            let sent = match frame {
                                protocols::Outbound::Text(text) => {
                                    writer.send(Message::Text(text.into())).await
                                }
                                protocols::Outbound::Binary(bytes) => {
                                    writer.send(Message::Binary(bytes.into())).await
                                }
                            };
                            if let Err(error) = sent {
                                emit_error(&app, Some(source), format!("{label}：{error}"));
                                setup_failed = true;
                                break;
                            }
                        }
                        if setup_failed {
                            break;
                        }
                    }
                    Err(error) => {
                        emit_error(&app, Some(source), error);
                        break;
                    }
                }
                let mut finishing: Option<tokio::time::Instant> = None;
                // Liveness tracking: a half-open TCP path (connection severed
                // without a FIN — e.g. the network dropped while the machine
                // was asleep) never produces a read error on its own, so after
                // a silence window we probe with a websocket ping and force a
                // reconnect when the probe goes unanswered.
                let mut last_inbound = tokio::time::Instant::now();
                let mut pinged_at: Option<tokio::time::Instant> = None;
                // When this connection was established. Inbound traffic only
                // resets the failure streak once the connection has lived a
                // moment — a gate that accepts the handshake, emits one frame
                // and dies (bad key, unknown model) would otherwise zero the
                // streak every cycle and spin at 500 ms forever.
                let connected_at = tokio::time::Instant::now();
                // Per-connection leg proofs: the first inbound provider frame
                // and the first forwarded audio chunk separate "capture never
                // feeds the socket" from "the gate accepted and went silent" —
                // the two failure shapes a reconnect-only log cannot tell apart.
                let mut first_frame_logged = false;
                let mut audio_forward_logged = false;
                'connection: loop {
                    tokio::select! {
                        command = receiver.recv(), if finishing.is_none() => {
                            match command {
                                Some(WsCommand::Audio(payload)) => {
                                    if !audio_forward_logged {
                                        audio_forward_logged = true;
                                        log::info!(
                                            "Live translation stream {source:?} forwarding captured audio"
                                        );
                                    }
                                    for frame in adapter.encode_audio(&payload) {
                                        let sent = match frame {
                                            protocols::Outbound::Text(text) => {
                                                writer.send(Message::Text(text.into())).await
                                            }
                                            protocols::Outbound::Binary(bytes) => {
                                                writer.send(Message::Binary(bytes.into())).await
                                            }
                                        };
                                        if let Err(error) = sent {
                                            emit_error(&app, Some(source), format!("发送音频失败：{error}"));
                                            break 'connection;
                                        }
                                    }
                                }
                                Some(WsCommand::VoiceEnd) | None => {
                                    let (frames, grace) = adapter.finish();
                                    for frame in frames {
                                        let sent = match frame {
                                            protocols::Outbound::Text(text) => {
                                                writer.send(Message::Text(text.into())).await
                                            }
                                            protocols::Outbound::Binary(bytes) => {
                                                writer.send(Message::Binary(bytes.into())).await
                                            }
                                        };
                                        let _ = sent;
                                    }
                                    finishing =
                                        Some(tokio::time::Instant::now() + grace);
                                }
                            }
                        }
                        incoming = reader.next() => {
                            match incoming {
                                Some(Ok(Message::Text(text))) => {
                                    last_inbound = tokio::time::Instant::now();
                                    pinged_at = None;
                                    if connected_at.elapsed() >= LIVE_CONNECTION_GRACE {
                                        failure_streak = 0;
                                    }
                                    if !first_frame_logged {
                                        first_frame_logged = true;
                                        // The first frame names the gate's very
                                        // first word — session ack, in-band
                                        // auth/model error, or nothing at all.
                                        log::info!(
                                            "Live translation stream {source:?} provider first frame: {}",
                                            text.chars().take(200).collect::<String>()
                                        );
                                    }
                                    // DashScope acknowledges `session.finish`
                                    // with a `session.finished` event; on it,
                                    // close for real instead of reconnecting.
                                    if finishing.is_some() && adapter.is_finish_ack(text.as_ref()) {
                                        let _ = writer.close().await;
                                        emit_stream_state(&app, source, "closed", epoch);
                                        return;
                                    }
                                    let ctx = protocols::ProtocolCtx {
                                        session: &session,
                                        source,
                                        epoch,
                                        epoch_offset_ms: stream_offset_ms,
                                    };
                                    match adapter.handle_text(&app, &ctx, text.as_ref()) {
                                        protocols::InboundOutcome::Ignored => {}
                                        // A real result on a fresh connection is
                                        // full proof of health — clear the streak
                                        // even inside the connection grace window
                                        // (short utterances on Tencent close and
                                        // redial within seconds, by design).
                                        protocols::InboundOutcome::GotResult => {
                                            failure_streak = 0;
                                        }
                                        protocols::InboundOutcome::GotResultAndRedial => {
                                            failure_streak = 0;
                                            break 'connection;
                                        }
                                        protocols::InboundOutcome::Redial(message) => {
                                            emit_error(&app, Some(source), message);
                                            break 'connection;
                                        }
                                        protocols::InboundOutcome::StreamFinished => {
                                            let _ = writer.close().await;
                                            emit_stream_state(&app, source, "closed", epoch);
                                            return;
                                        }
                                    }
                                }
                                Some(Ok(Message::Binary(frame))) => {
                                    last_inbound = tokio::time::Instant::now();
                                    pinged_at = None;
                                    if connected_at.elapsed() >= LIVE_CONNECTION_GRACE {
                                        failure_streak = 0;
                                    }
                                    let ctx = protocols::ProtocolCtx {
                                        session: &session,
                                        source,
                                        epoch,
                                        epoch_offset_ms: stream_offset_ms,
                                    };
                                    match adapter.handle_binary(&app, &ctx, frame.as_ref()) {
                                        protocols::InboundOutcome::Ignored => {}
                                        protocols::InboundOutcome::GotResult => {
                                            failure_streak = 0;
                                        }
                                        protocols::InboundOutcome::GotResultAndRedial => {
                                            failure_streak = 0;
                                            break 'connection;
                                        }
                                        protocols::InboundOutcome::Redial(message) => {
                                            emit_error(&app, Some(source), message);
                                            break 'connection;
                                        }
                                        protocols::InboundOutcome::StreamFinished => {
                                            let _ = writer.close().await;
                                            emit_stream_state(&app, source, "closed", epoch);
                                            return;
                                        }
                                    }
                                }
                                Some(Ok(Message::Close(frame))) => {
                                    if finishing.is_some() {
                                        emit_stream_state(&app, source, "closed", epoch);
                                        return;
                                    }
                                    // The close code is often the only hint a
                                    // provider gives (1006 = TCP died mid-flight,
                                    // 4xxx = policy/auth rejection at the gate).
                                    let detail = frame
                                        .map(|frame| format!("（code={} {}）", frame.code, frame.reason))
                                        .unwrap_or_default();
                                    emit_error(
                                        &app,
                                        Some(source),
                                        format!("翻译连接由服务端关闭{detail}，正在重连。"),
                                    );
                                    break 'connection;
                                }
                                None => {
                                    if finishing.is_some() {
                                        emit_stream_state(&app, source, "closed", epoch);
                                        return;
                                    }
                                    emit_error(&app, Some(source), "翻译连接中断，正在重连。");
                                    break 'connection;
                                }
                                Some(Ok(_)) => {
                                    // Ping/Pong and other framing traffic also
                                    // count as a liveness proof.
                                    last_inbound = tokio::time::Instant::now();
                                    pinged_at = None;
                                    if connected_at.elapsed() >= LIVE_CONNECTION_GRACE {
                                        failure_streak = 0;
                                    }
                                }
                                Some(Err(error)) => {
                                    emit_error(&app, Some(source), format!("翻译连接中断：{error}"));
                                    break 'connection;
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
                                break 'connection;
                            }
                            if writer.send(Message::Ping(Vec::new().into())).await.is_err() {
                                break 'connection;
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
                // A timeout emits nothing by itself — without this the user
                // stares at a recording that produces no text and no error.
                // Surface only the first failure of a streak; the banner
                // clears on recovery via the streamState "connected" event.
                if failure_streak == 1 {
                    emit_error(
                        &app,
                        Some(source),
                        format!(
                            "实时翻译连接超时（{LIVE_CONNECT_TIMEOUT:?} 无响应），正在重试。"
                        ),
                    );
                }
            }
        }
        tokio::time::sleep(live_reconnect_backoff(failure_streak)).await;
    }
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


fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
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
// Pause branches to the in-process engine call on Windows, so the placeholder
// constant has no reader there — it exists to keep the shared call sites
// compiling.
#[cfg(target_os = "windows")]
#[allow(dead_code)]
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
    // Signal the sidecar BEFORE flipping the visible state: a missed signal
    // (sidecar crashed or wedged) must leave the session "recording" so the
    // UI can retry, instead of showing a paused pill over a microphone that
    // is still hot. Windows flips first instead — pausing there is an
    // in-process engine call whose outcome is immediately observable.
    #[cfg(target_os = "windows")]
    {
        session.set_state("paused");
        // In-process engine: pausing is stopping the feed, not signalling a
        // sidecar — effective immediately.
        let _ = with_windows_engine(|engine| engine.pause());
        voice_end(&session);
        emit_snapshot(&app, &session);
        return Ok(session.snapshot());
    }
    #[cfg(target_os = "macos")]
    {
        signal_child(&session, SIGNAL_PAUSE)?;
        session.set_state("paused");
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
    // Resume capture BEFORE attaching the new websocket loops: if the sidecar
    // misses the resume signal, the session stays "paused" with no provider
    // streams dialing against a frozen capture — the old order (attach, then
    // signal) stranded "connecting" sessions whenever the signal failed.
    signal_child(&session, SIGNAL_RESUME)?;
    session.set_state("connecting");
    spawn_connections(&app, &session, request.epoch, offset, request.connections)?;
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

/// Start watchdog: a session that never leaves "connecting" — the capture
/// engine wedged inside a WASAPI call, or failed before the event pump ever
/// ran — would otherwise spin in the UI forever with no explanation. After
/// [`CAPTURE_START_TIMEOUT`] the session is failed with a user-facing reason.
/// A capture thread wedged inside a COM call cannot be killed and leaks for
/// the process lifetime, but the session slot frees so the user can retry.
fn spawn_capture_start_watchdog(app: AppHandle, session: Arc<LiveSession>) {
    tauri::async_runtime::spawn(async move {
        let deadline = Instant::now() + CAPTURE_START_TIMEOUT;
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = session.state.lock().expect("live state lock").clone();
            match state.as_str() {
                "connecting" if Instant::now() < deadline => {}
                "connecting" => break,
                _ => return,
            }
        }
        log::error!(
            "Live translation capture start timed out after {:?} (session={})",
            CAPTURE_START_TIMEOUT,
            session.session_id
        );
        let manager = app.state::<LiveTranslationManager>();
        let taken = manager
            .session
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        match taken {
            Some(current) if Arc::ptr_eq(&current, &session) => {}
            _ => return,
        }
        // Signals a still-alive capture thread to wind down; one wedged
        // inside a COM call cannot observe this (see the function comment).
        session.capture_stop.store(false, Ordering::Relaxed);
        clear_card_feed_target();
        session.set_state("failed");
        emit_snapshot(&app, &session);
        set_recording_island_visible(&app, false);
        emit_error(
            &app,
            None,
            "启动录音超时：音频设备没有响应。请检查系统声音设置或插拔音频设备后重试。",
        );
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
    log::info!("Persisting recording: session={}", session.session_id);
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
            // A saved recording leaves no other trace in the log; without
            // this line "did the save land?" is unanswerable from a log
            // alone (the UI events are transient).
            log::info!(
                "Recording persisted: session={} playback={} durationMs={}",
                completed.session_id,
                completed.playback_path,
                completed.duration_ms
            );
            let _ = app.emit(
                LIVE_EVENT,
                json!({ "type": "completed", "session": completed }),
            );
        }
        Ok(Err(error)) => {
            log::error!("Persisting recording failed: {error}");
            emit_error(&app, None, format!("保存录音失败：{error}"));
        }
        Err(error) => {
            log::error!("Persisting recording panicked: {error}");
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
        if aec_enabled() {
            command.arg("--aec");
        }
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

/// Engine metadata for the persisted record, derived from the provider that
/// was actually attached. The legacy build hard-coded the iLiveData label no
/// matter which engine produced the transcript.
fn engine_labels(attached: Option<&str>) -> (String, String) {
    match attached {
        Some("qwen") => ("qwen_livetranslate".to_owned(), "qwen-livetranslate".to_owned()),
        // A user-configured DashScope-compatible service (the custom provider).
        Some("dashscope") => ("dashscope_realtime".to_owned(), "dashscope-realtime".to_owned()),
        Some("volc") => ("volc_ast".to_owned(), "volc-ast".to_owned()),
        Some("tencent") => ("tencent_asr".to_owned(), "tencent-asr".to_owned()),
        // The backend relay mirrors the iLiveData RTVT wire protocol, and a
        // pure recording has no transcript engine to name.
        None | Some("lynse_backend") | Some("ilivedata_direct") => {
            ("ilivedata_rtvt".to_owned(), "ilivedata-rtvt".to_owned())
        }
        // Unknown names pass through so a future provider stays identifiable.
        Some(other) => (other.to_owned(), other.to_owned()),
    }
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
    let (engine, model_id) = engine_labels(
        session
            .attached_provider
            .lock()
            .expect("live provider lock")
            .as_deref(),
    );
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
            "engine": engine,
            "modelId": model_id,
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
        started_at: session.started_at.clone(),
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
        // The Swift sidecar's placeholder header is 44 zero bytes, so a killed
        // sidecar leaves tracks without even a RIFF magic — inspect cannot
        // parse them and the stale-header repair never reaches them. The
        // frozen per-track format is the only remaining description.
        let rebuilt = match crate::audio_contract::wav::capture_track_format(name, directory) {
            Some(format) => {
                crate::audio_contract::wav::rebuild_zeroed_header(&path, &format).unwrap_or(false)
            }
            None => false,
        };
        if rebuilt {
            log::warn!("rebuilt zeroed WAV header: {}", path.display());
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

/// Remember the client-generated cloud fileId for a finished recording so a
/// retried upload re-runs the sync chain against the same placeholder
/// (create upserts by fileId) instead of duplicating the cloud record.
#[tauri::command]
pub fn live_translation_set_cloud_file_id(
    app: AppHandle,
    session_id: String,
    cloud_file_id: String,
) -> CommandResult<()> {
    let record_id = format!("local:live:{session_id}");
    let mut patch = Map::new();
    patch.insert("cloudFileId".to_owned(), json!(cloud_file_id));
    update_store_value(&app, "local-transcriptions", &record_id, patch)?
        .ok_or("live translation record not found")?;
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
        // The in-engine AEC reprocessor only exists on macOS so far. Refuse
        // here, BEFORE the stale-output deletion inside `run_reprocess` — a
        // reprocess must never destroy the finished tracks it cannot rebuild.
        #[cfg(target_os = "macos")]
        {
            run_reprocess(app, directory, record_id)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (directory, record_id);
            Err("重新处理暂不支持当前平台，请更新 Lynse 以获得该功能".to_owned())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn run_reprocess(
    app: AppHandle,
    directory: std::path::PathBuf,
    record_id: String,
) -> CommandResult<Value> {
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
        log::info!("Reprocessed dual-channel recording session={record_id}");
        crate::get_store_value(&app, "local-transcriptions", &record_id)?
            .ok_or_else(|| "recording not found".to_owned())
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
        // A directory that already produced its `local-transcriptions` record
        // is saved, not stranded — the session directory (and its session.json)
        // deliberately outlives persist as the recording's storage. Without
        // this filter every past recording would resurface as "recoverable"
        // and recovering it would duplicate the record.
        let record_id = format!("local:live:{}", manifest.session_id);
        if crate::get_store_value(&app, "local-transcriptions", &record_id)?.is_some() {
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
    // Defense in depth against double-recovery: a session that already has its
    // record is saved — recovering it again would duplicate the entry (the
    // recoveries listing filters these, but a stale client could still ask).
    {
        let record_id = format!("local:live:{session_id}");
        if crate::get_store_value(&app, "local-transcriptions", &record_id)?.is_some() {
            return Err("this recording has already been saved".to_owned());
        }
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
    // Fix the headers before anything reads the tracks: a killed sidecar's
    // zeroed placeholders would fail `inspect_wav` below and blank the
    // duration even though the audio is all there.
    repair_capture_headers(&directory);
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
        // Recovery replays whatever the sidecar already archived; enhancement is a
        // capture-time decision and cannot be applied retroactively.
        voice_enhancement: false,
        last_voice_at: Mutex::new(Instant::now()),
        auto_stopped_silence: AtomicBool::new(false),
        attached_provider: Mutex::new(manifest.provider.clone()),
    };
    persist_session(app, &session)
}

/// Deletes one stranded session directory without recovering it — the other
/// way out of the recovery prompt, for recordings the user does not want.
#[tauri::command]
pub fn live_translation_discard_recovery(
    app: AppHandle,
    state: State<LiveTranslationManager>,
    session_id: String,
) -> CommandResult<()> {
    if !valid_session_id(&session_id) {
        return Err("invalid live translation session id".to_owned());
    }
    if state
        .session
        .lock()
        .map_err(|_| "live session lock is poisoned")?
        .is_some()
    {
        // A running (or finalizing) session's directory is still being
        // written; the listing never offers it, so refuse stale callers too.
        return Err("cannot discard the active live translation session".to_owned());
    }
    // Defense in depth, mirroring `live_translation_recover`: a session with
    // its record is saved — its directory is the recording's storage.
    {
        let record_id = format!("local:live:{session_id}");
        if crate::get_store_value(&app, "local-transcriptions", &record_id)?.is_some() {
            return Err("this recording has already been saved".to_owned());
        }
    }
    let directory = recovery_root(&app)?.join(&session_id);
    if !directory.is_dir() {
        return Ok(());
    }
    fs::remove_dir_all(&directory).map_err(|error| error.to_string())
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

/// Windows WebView2 quirk (same one that hid the About/feedback popups): a
/// window created hidden and shown before its page finishes loading can stay
/// invisible for good. The island is created hidden and its first reveal can
/// race the page load, so the reveal defers to the page-load hook there.
static ISLAND_WEBVIEW_READY: AtomicBool = AtomicBool::new(false);
static ISLAND_PENDING_REVEAL: AtomicBool = AtomicBool::new(false);

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
/// transcript drawer unroll downward together — or upward on Windows, where
/// `bottom_anchor` pins the pill's bottom edge above the taskbar and the
/// height change moves the top edge instead.
fn animate_island_height(
    window: WebviewWindow,
    target_height: f64,
    expand: bool,
    generation: u64,
    bottom_anchor: Option<f64>,
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
        keep_island_bottom(&window, bottom_anchor);
        if linear >= 1.0 || ISLAND_ANIMATION_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Positions the island pill next to the tray icon: on macOS directly below
/// the menu-bar status item (top-right, unrolling downward); on Windows just
/// above the taskbar's tray area (bottom-right, unrolling upward — the
/// dynamic island on the opposite screen edge). Falls back to the screen
/// centre (macOS) / right edge (Windows) when the tray rect is unavailable.
fn position_recording_island(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return;
    };
    let factor = monitor.scale_factor() as f64;

    #[cfg(target_os = "windows")]
    {
        // The work area excludes the taskbar, so its bottom edge is exactly
        // where the island's full-height bottom should rest.
        let work_area = monitor.work_area();
        let left = work_area.position.x as f64 / factor;
        let right = (work_area.position.x + work_area.size.width as i32) as f64 / factor;
        let bottom = (work_area.position.y + work_area.size.height as i32) as f64 / factor;
        let mut x = right - RECORDING_ISLAND_WIDTH - 8.0;
        if let Some(tray) = app.tray_by_id("main-tray") {
            if let Ok(Some(rect)) = tray.rect() {
                let tray_left = match &rect.position {
                    tauri::Position::Physical(p) => p.x as f64 / factor,
                    tauri::Position::Logical(l) => l.x,
                };
                let tray_w = match &rect.size {
                    tauri::Size::Physical(s) => s.width as f64 / factor,
                    tauri::Size::Logical(s) => s.width,
                };
                // Right-align the island with the tray icons, clamped to the
                // work area for exotic taskbar placements.
                x = (tray_left + tray_w - RECORDING_ISLAND_WIDTH).max(left);
            }
        }
        let y = bottom - 4.0 - RECORDING_ISLAND_HEIGHT;
        let _ = window.set_position(LogicalPosition::new(x, y));
    }

    #[cfg(not(target_os = "windows"))]
    {
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
}

/// Logical Y of the island window's BOTTOM edge — just above the Windows
/// taskbar. `None` on macOS, where the island hangs from the menu bar by its
/// top edge instead and never needs bottom-anchoring.
fn island_bottom_anchor(app: &AppHandle) -> Option<f64> {
    #[cfg(target_os = "windows")]
    {
        let monitor = app.primary_monitor().ok().flatten()?;
        let factor = monitor.scale_factor() as f64;
        let work_area = monitor.work_area();
        let bottom = (work_area.position.y + work_area.size.height as i32) as f64 / factor;
        Some(bottom - 4.0)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        None
    }
}

/// Keeps the island's bottom edge pinned to `bottom_y` (logical) at its
/// current x, whatever its height is at the moment. No-op on macOS (anchor
/// is `None` there): the top-anchored window just grows downward natively.
fn keep_island_bottom(window: &tauri::WebviewWindow, bottom_y: Option<f64>) {
    let Some(bottom_y) = bottom_y else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let height = window
        .inner_size()
        .map(|size| size.height as f64 / scale)
        .unwrap_or(0.0);
    let _ = window.set_position(LogicalPosition::new(pos.x as f64 / scale, bottom_y - height));
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
            // Drop any reveal still queued behind the page load, so a session
            // that ended before the webview was ready never pops the island.
            ISLAND_PENDING_REVEAL.store(false, Ordering::Release);
            let _ = window.hide();
        }
        return;
    }
    if !visible {
        return;
    }
    let window = match build_recording_island_window(app) {
        Ok(window) => window,
        Err(error) => {
            log::error!("Failed to create recording island window: {error}");
            return;
        }
    };
    reveal_recording_island(app, &window);
}

/// Creates the island webview WITHOUT showing it. The window (once created)
/// survives session stop — only hidden — so one pre-creation at session start
/// guarantees the tray's pause/stop/resume events always have a frontend
/// receiver, even while the main window owns the screen.
pub fn ensure_recording_island_window(app: &AppHandle) {
    if app.get_webview_window("recording-island").is_some() {
        return;
    }
    if let Err(error) = build_recording_island_window(app) {
        log::error!("Failed to pre-create recording island window: {error}");
    }
}

fn build_recording_island_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
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
    // Created hidden: `reveal_recording_island` unrolls it at the tray
    // anchor instead of popping in at full size.
    .visible(false)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            ISLAND_WEBVIEW_READY.store(true, Ordering::Release);
            // A reveal requested while the page was still loading (Windows
            // gate below) replays now that showing is safe.
            if ISLAND_PENDING_REVEAL.swap(false, Ordering::AcqRel) {
                let app = window.app_handle().clone();
                reveal_recording_island(&app, &window);
            }
        }
    });
    let window = builder.build()?;
    // Native frosted glass behind the webview: the pill reads as a translucent
    // capsule over whatever is on screen, not a solid card.
    if let Err(error) =
        crate::window_effects::apply_island_effects(&window, RECORDING_ISLAND_HEIGHT / 2.0)
    {
        log::error!("Failed to apply recording island effects: {error}");
    }
    Ok(window)
}

/// The island's entrance: snap back to the tray anchor (even if the user
/// dragged the pill elsewhere previously), show as a thin sliver hugging the
/// tray, then unroll to full height with the quintic ease — macOS reads it as
/// the capsule growing out of the status bar (downward), Windows as it
/// sprouting up from the taskbar tray area. Any in-flight drawer animation is
/// superseded via the shared generation token.
fn reveal_recording_island(app: &AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    if !ISLAND_WEBVIEW_READY.load(Ordering::Acquire) {
        // Page not loaded yet — showing now risks the invisible-window
        // quirk. The page-load hook replays this reveal when safe.
        ISLAND_PENDING_REVEAL.store(true, Ordering::Release);
        return;
    }
    position_recording_island(app, window);
    let bottom_anchor = island_bottom_anchor(app);
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
    // Bottom-anchored hosts (Windows) must start the sliver at its final
    // bottom edge, or the first animation frames would jump it downward.
    keep_island_bottom(window, bottom_anchor);
    let _ = window.show();
    let window = window.clone();
    thread::spawn(move || {
        animate_island_height(window, target_height, true, generation, bottom_anchor)
    });
}

/// Grows or shrinks the recording-island window between the compact pill and
/// the expanded live-transcript drawer. The window is tray-anchored, so
/// expanding unfolds away from the screen edge it is pinned to — downward on
/// macOS (menu bar), upward on Windows (taskbar). The height change is eased
/// over ~1/3 of a second (see `animate_island_height`) instead of snapping,
/// so the drawer reads as a scroll unrolling.
#[tauri::command]
pub fn live_translation_expand_island(app: AppHandle, expand: bool) -> CommandResult<()> {
    let Some(window) = app.get_webview_window("recording-island") else {
        return Ok(());
    };
    let bottom_anchor = island_bottom_anchor(&app);
    let generation = ISLAND_ANIMATION_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let target_height = if expand {
        RECORDING_ISLAND_EXPANDED_HEIGHT
    } else {
        RECORDING_ISLAND_HEIGHT
    };
    // The animation runs off the command thread and returns immediately, so
    // the frontend can mount the drawer while the window is still unrolling.
    thread::spawn(move || {
        animate_island_height(window, target_height, expand, generation, bottom_anchor)
    });
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
            // Forward at the engine's 200 ms cadence: the macOS sidecar's
            // `levels` lines are what move the page timer/meters while
            // recording, and this is their Windows equivalent — without it
            // the page never updates between the Ready and stopping
            // snapshots.
            let _ = app.emit(
                LIVE_EVENT,
                json!({
                    "type": "levels",
                    "mic": mic,
                    "system": system,
                    "elapsedMs": session.last_elapsed_ms.load(Ordering::Relaxed),
                }),
            );
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
    use crate::tencent_asr;
    use crate::volc_ast;
    use protocols::LiveProtocol as _;

    /// Drive the direct protocol's message handler the way the connection
    /// loop does, for the ingest-semantics tests below.
    fn direct_message(
        session: &LiveSession,
        source: AudioSource,
        epoch: u32,
        offset_ms: u64,
        text: &str,
    ) -> Option<ProviderEmission> {
        protocols::direct::apply_provider_message(
            &protocols::ProtocolCtx {
                session,
                source,
                epoch,
                epoch_offset_ms: offset_ms,
            },
            text,
        )
    }

    /// Drive the DashScope protocol's message handler the way the connection
    /// loop does, for the ingest-semantics tests below.
    #[allow(clippy::too_many_arguments)]
    fn qwen_message(
        session: &LiveSession,
        source: AudioSource,
        epoch: u32,
        offset_ms: u64,
        text: &str,
        transcript_only: bool,
    ) -> Option<ProviderEmission> {
        protocols::dashscope::apply_qwen_message(
            &protocols::ProtocolCtx {
                session,
                source,
                epoch,
                epoch_offset_ms: offset_ms,
            },
            text,
            transcript_only,
        )
    }

    fn live_session() -> LiveSession {
        LiveSession {
            session_id: "session".to_owned(),
            title: "test".to_owned(),
            source_language: RwLock::new("zh".to_owned()),
            target_language: RwLock::new("en".to_owned()),
            started_at: now(),
            state: Mutex::new("recording".to_owned()),
            epoch: AtomicU32::new(0),
            attached_provider: Mutex::new(None),
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
            voice_enhancement: false,
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
            direct_message(&session, AudioSource::Mic, 0, 0, &text)
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
            direct_message(&session, AudioSource::Mic, 0, 3_000, &text)
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
            url: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime".to_owned(),
            provider: Some("qwen".to_owned()),
            api_key: None,
            extra: None,
        }];
        assert!(validate_connections(&missing_key).is_err());
        let with_key = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime".to_owned(),
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
            protocols::volc::volc_languages("auto", "en"),
            (String::new(), "en".to_owned(), true),
        );
        // Transcript-only still needs a valid target; pick one that differs
        // from the source so AST never rejects the pair.
        assert_eq!(
            protocols::volc::volc_languages("zh", "none"),
            ("zh".to_owned(), "en".to_owned(), false),
        );
        assert_eq!(
            protocols::volc::volc_languages("en", "none"),
            ("en".to_owned(), "zh".to_owned(), false),
        );
        // Auto + transcript-only: empty source is not `zh`, so target is `zh`.
        assert_eq!(
            protocols::volc::volc_languages("auto", "none"),
            (String::new(), "zh".to_owned(), true),
        );
        assert_eq!(
            protocols::volc::volc_languages("ja", "zh"),
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

        direct_message(&session, AudioSource::Mic, 2, 5_000, recognized_temp).unwrap();
        direct_message(&session, AudioSource::Mic, 2, 5_000, translated_temp).unwrap();
        direct_message(&session, AudioSource::Mic, 2, 5_000, recognized_final).unwrap();
        direct_message(&session, AudioSource::Mic, 2, 5_000, translated_final).unwrap();

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
        direct_message(&session, AudioSource::Mic, 0, 0, m1).unwrap();
        direct_message(&session, AudioSource::Mic, 0, 0, m2).unwrap();
        direct_message(&session, AudioSource::Mic, 0, 0, m3).unwrap();
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
        direct_message(&session, AudioSource::Mic, 0, 0, u1).unwrap();
        direct_message(&session, AudioSource::Mic, 0, 0, u2).unwrap();
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
        direct_message(&session, AudioSource::Mic, 0, 0, interim).unwrap();
        direct_message(&session, AudioSource::Mic, 0, 0, final1).unwrap();
        direct_message(&session, AudioSource::Mic, 0, 0, final2).unwrap();
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
        direct_message(&session, AudioSource::Mic, 0, 0, m1).unwrap();
        direct_message(&session, AudioSource::Mic, 0, 0, m2).unwrap();
        direct_message(&session, AudioSource::Mic, 0, 0, m3).unwrap();
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
    fn repair_capture_headers_rebuilds_the_swift_sidecars_zeroed_placeholders() {
        // The Swift WavWriter's placeholder is 44 zero bytes — no RIFF magic
        // at all — so a killed sidecar's tracks used to be invisible to
        // recovery for good: `build_playback_wav` saw no readable audio and
        // every `recover` failed. Rebuilding the frozen per-track header must
        // make the whole session recoverable again.
        let directory =
            std::env::temp_dir().join(format!("lynse-repair-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let mut zeroed = |name: &str, payload_frames: usize, frame_bytes: usize| {
            let path = directory.join(name);
            let mut bytes = vec![0u8; 44];
            bytes.resize(44 + payload_frames * frame_bytes, 0);
            bytes[44..].iter_mut().enumerate().for_each(|(i, byte)| {
                *byte = ((i * 7 + 31) & 0xFF) as u8;
            });
            fs::write(&path, bytes).unwrap();
            assert!(
                crate::audio_contract::wav::inspect(&path).is_err(),
                "{name} must start unreadable"
            );
            path
        };
        zeroed(MASTER_TRACK_FILE, 480, 4);
        zeroed("mic_raw.wav", 480, 2);
        zeroed("system_raw.wav", 480, 4);
        zeroed("mic_processed.wav", 1600, 2);
        zeroed("system.wav", 1600, 2);

        repair_capture_headers(&directory);

        let master = directory.join(MASTER_TRACK_FILE);
        let info = crate::audio_contract::wav::inspect(&master).unwrap();
        assert_eq!(info.format.channels, 2, "master beside mic tracks is stereo");
        assert_eq!(info.frames(), 480);
        let mic_raw =
            crate::audio_contract::wav::inspect(&directory.join("mic_raw.wav")).unwrap();
        assert_eq!(mic_raw.format.sample_rate, 48_000);
        assert_eq!(mic_raw.format.channels, 1);
        let mic_processed =
            crate::audio_contract::wav::inspect(&directory.join("mic_processed.wav")).unwrap();
        assert_eq!(mic_processed.format.sample_rate, 16_000);

        // The point of the repair: recovery's mixdown now succeeds instead of
        // failing with "no captured audio was written".
        let playback = directory.join("playback.wav");
        build_playback_wav(Some(&master), None, None, &playback).unwrap();
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

    #[test]
    fn engine_labels_name_the_provider_that_ran() {
        assert_eq!(
            engine_labels(Some("qwen")),
            ("qwen_livetranslate".to_owned(), "qwen-livetranslate".to_owned())
        );
        assert_eq!(
            engine_labels(Some("volc")),
            ("volc_ast".to_owned(), "volc-ast".to_owned())
        );
        assert_eq!(
            engine_labels(Some("tencent")),
            ("tencent_asr".to_owned(), "tencent-asr".to_owned())
        );
        // The backend relay mirrors the iLiveData wire protocol, so a session
        // without direct-provider credentials keeps the historical label.
        assert_eq!(
            engine_labels(None),
            ("ilivedata_rtvt".to_owned(), "ilivedata-rtvt".to_owned())
        );
        assert_eq!(
            engine_labels(Some("lynse_backend")),
            ("ilivedata_rtvt".to_owned(), "ilivedata-rtvt".to_owned())
        );
    }

    #[test]
    fn unknown_provider_tags_are_rejected_instead_of_falling_back() {
        let mystery = ConnectionDescriptor {
            source: AudioSource::Mic,
            url: "wss://example.test/mic".to_owned(),
            provider: Some("mystery".to_owned()),
            api_key: None,
            extra: None,
        };
        let error = validate_connections(std::slice::from_ref(&mystery)).unwrap_err();
        assert!(error.contains("mystery"), "unexpected error: {error}");
        assert!(protocols::protocol_for(&mystery, false).is_err());
        // Untagged and the legacy/direct aliases all route to the plain JSON
        // protocol, exactly like the pre-refactor dispatch.
        for tag in [None, Some("direct"), Some("ilivedata_direct"), Some("lynse_backend")] {
            let connection = ConnectionDescriptor {
                source: AudioSource::Mic,
                url: "wss://example.test/mic".to_owned(),
                provider: tag.map(str::to_owned),
                api_key: None,
                extra: None,
            };
            assert!(protocols::protocol_for(&connection, false).is_ok());
        }
    }

    #[test]
    fn dashscope_session_setup_honours_the_asr_model_override() {
        let session = live_session();
        *session.source_language.write().unwrap() = "zh".to_owned();
        let extra = |asr_model: &str| {
            let mut map = std::collections::HashMap::new();
            map.insert("asrModel".to_owned(), asr_model.to_owned());
            map
        };
        fn ctx_for(session: &LiveSession) -> protocols::ProtocolCtx<'_> {
            protocols::ProtocolCtx {
                session,
                source: AudioSource::Mic,
                epoch: 0,
                epoch_offset_ms: 0,
            }
        }
        let frames_for = |extra: std::collections::HashMap<String, String>| {
            let mut protocol =
                protocols::dashscope::DashScopeProtocol::new("sk-test".to_owned(), extra, false);
            protocol.on_connected(&ctx_for(&session)).unwrap()
        };

        // Default: the stock qwen3 ASR model name rides in session.update.
        let frames = frames_for(Default::default());
        let setup = match &frames[0].0 {
            protocols::Outbound::Text(text) => text.clone(),
            protocols::Outbound::Binary(_) => panic!("expected a text frame"),
        };
        assert!(setup.contains("qwen3-asr-flash-realtime"), "{setup}");

        // A DashScope-compatible service can override the recognition model.
        let frames = frames_for(extra("my-asr-v2"));
        let setup = match &frames[0].0 {
            protocols::Outbound::Text(text) => text.clone(),
            protocols::Outbound::Binary(_) => panic!("expected a text frame"),
        };
        assert!(setup.contains("my-asr-v2"), "{setup}");
        assert!(!setup.contains("qwen3-asr-flash-realtime"), "{setup}");
    }

    #[test]
    fn engine_labels_name_custom_dashscope_services() {
        let (engine, model_id) = engine_labels(Some("dashscope"));
        assert_eq!(engine, "dashscope_realtime");
        assert_eq!(model_id, "dashscope-realtime");
    }

    #[test]
    fn connections_provider_reads_the_first_descriptor() {
        let direct = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: "wss://example.invalid".to_owned(),
            provider: Some("volc".to_owned()),
            api_key: Some("key".to_owned()),
            extra: None,
        }];
        assert_eq!(
            connections_provider(&direct).as_deref(),
            Some("volc"),
            "the first connection speaks for the session"
        );
        // A descriptor without a provider name is the backend relay.
        let relayed = vec![ConnectionDescriptor {
            source: AudioSource::Mic,
            url: "wss://example.invalid".to_owned(),
            provider: None,
            api_key: None,
            extra: None,
        }];
        assert_eq!(connections_provider(&relayed).as_deref(), Some("lynse_backend"));
        assert_eq!(connections_provider(&[]), None, "pure recording has no engine");
    }

    #[test]
    fn qwen_translation_target_maps_unsupported_codes() {
        assert_eq!(protocols::dashscope::qwen_translation_target("zh"), "zh");
        assert_eq!(protocols::dashscope::qwen_translation_target("pt"), "pt");
        assert_eq!(protocols::dashscope::qwen_translation_target("zh-TW"), "zh", "Chinese variants degrade to Mandarin");
        assert_eq!(protocols::dashscope::qwen_translation_target("zh-yue"), "zh");
        assert_eq!(protocols::dashscope::qwen_translation_target("tl"), "en", "unsupported codes fall back to English");
    }

    #[test]
    fn qwen_transcript_only_drops_translation_but_keeps_recognition() {
        let session = live_session();
        // The fake-target translation leg must never surface as text.
        let delta = r#"{"type":"response.text.delta","delta":"hello"}"#;
        assert!(
            qwen_message(&session, AudioSource::Mic, 0, 0, delta, true).is_none(),
            "translation delta must be dropped in transcript-only mode"
        );
        let done = r#"{"type":"response.audio_transcript.done","transcript":"hello"}"#;
        assert!(
            qwen_message(&session, AudioSource::Mic, 0, 0, done, true).is_none(),
            "translation final must be dropped in transcript-only mode"
        );
        // Recognition is the whole point of transcript-only mode.
        let recognized =
            r#"{"type":"conversation.item.input_audio_transcription.completed","text":"你好世界"}"#;
        let emission = qwen_message(&session, AudioSource::Mic, 0, 0, recognized, true);
        assert!(emission.is_some(), "recognition must survive transcript-only mode");
        // With translation requested for real, the same translation frame lands.
        assert!(qwen_message(&session, AudioSource::Mic, 0, 0, delta, false).is_some());
    }
}
