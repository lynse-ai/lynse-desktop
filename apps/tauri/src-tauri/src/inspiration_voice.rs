//! Quick voice-memo capture for the Inspiration feature.
//!
//! macOS drives the `audio-capture` sidecar in mic-only mode (the same sidecar
//! live translation uses, so the TCC permission flow and the 16 kHz / mono /
//! PCM16 WAV output are identical). Windows captures in-process via `cpal`,
//! mirroring the live-translation microphone path. Both write
//! `<app_data>/inspirations/capture-<id>/audio.wav` and stream throttled level
//! events (`inspiration-voice-event`) to the main window for the waveform UI.
//! The file is adopted into `<app_data>/inspirations/<uuid>/` by
//! `inspiration_save` when the memo is actually stored.

use crate::app_data_dir;
use crate::CommandResult;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::live_translation::decode_audio_header;
use crate::live_translation::LiveTranslationManager;
#[cfg(target_os = "windows")]
use crate::live_translation::write_pcm16_wav;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
#[cfg(target_os = "macos")]
use std::io::{BufRead, BufReader};
#[cfg(target_os = "macos")]
use std::os::unix::net::UnixListener;
#[cfg(target_os = "macos")]
use std::process::{Child, Stdio};
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
#[cfg(not(target_os = "windows"))]
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use uuid::Uuid;

const VOICE_EVENT: &str = "inspiration-voice-event";
#[cfg(target_os = "macos")]
const AUDIO_HEADER_BYTES: usize = crate::live_translation::AUDIO_HEADER_BYTES;

struct VoiceCapture {
    capture_id: String,
    directory: std::path::PathBuf,
    #[cfg(target_os = "macos")]
    socket_path: std::path::PathBuf,
    #[cfg(target_os = "macos")]
    child: Mutex<Option<Child>>,
    /// `true` while the capture should keep running. Only the Windows
    /// in-process capture polls this flag; the macOS sidecar is stopped via
    /// SIGTERM instead (mirroring live translation).
    #[cfg(target_os = "windows")]
    stop: Arc<AtomicBool>,
    level: AtomicU32,
    elapsed_ms: AtomicU64,
    state: Mutex<String>,
    /// Windows-only: delivers the finalized WAV duration (or the failure) from
    /// the capture thread once the stop flag is observed.
    #[cfg(target_os = "windows")]
    done: Mutex<Option<std::sync::mpsc::Receiver<CommandResult<u64>>>>,
}

impl VoiceCapture {
    fn snapshot(&self) -> Value {
        json!({
            "state": self.state.lock().expect("inspiration voice state lock").clone(),
            "captureId": self.capture_id,
            "elapsedMs": self.elapsed_ms.load(Ordering::Relaxed),
            "level": f32::from_bits(self.level.load(Ordering::Relaxed)),
        })
    }
}

static CAPTURE: Mutex<Option<Arc<VoiceCapture>>> = Mutex::new(None);

fn current_capture() -> Option<Arc<VoiceCapture>> {
    CAPTURE
        .lock()
        .expect("inspiration voice capture lock")
        .clone()
}

fn take_capture() -> Option<Arc<VoiceCapture>> {
    CAPTURE
        .lock()
        .expect("inspiration voice capture lock")
        .take()
}

fn set_state(capture: &VoiceCapture, state: &str) {
    *capture
        .state
        .lock()
        .expect("inspiration voice state lock") = state.to_owned();
}

fn emit_levels(app: &AppHandle, capture: &VoiceCapture) {
    let _ = app.emit(
        VOICE_EVENT,
        json!({
            "type": "levels",
            "level": f32::from_bits(capture.level.load(Ordering::Relaxed)),
            "elapsedMs": capture.elapsed_ms.load(Ordering::Relaxed),
        }),
    );
}

fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit(VOICE_EVENT, json!({ "type": "error", "message": message.into() }));
}

/// RMS level (0..1) of one 16-bit little-endian mono PCM frame, mirroring the
/// meter behaviour of the recording-card feed in live_translation.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn frame_level(payload: &[u8]) -> f32 {
    let mut sum = 0.0f64;
    let mut count = 0usize;
    for chunk in payload.chunks_exact(2) {
        let sample = i16::from_le_bytes([chunk[0], chunk[1]]) as f64 / 32768.0;
        sum += sample * sample;
        count += 1;
    }
    if count == 0 {
        0.0
    } else {
        (sum / count as f64).sqrt().min(1.0) as f32
    }
}

fn inspirations_root(app: &AppHandle) -> CommandResult<std::path::PathBuf> {
    Ok(app_data_dir(app)?.join("inspirations"))
}

fn idle_snapshot() -> Value {
    json!({ "state": "idle", "captureId": null, "elapsedMs": 0, "level": 0.0 })
}

// ── macOS: audio-capture sidecar, mic only ─────────────────────────────────

#[cfg(target_os = "macos")]
fn platform_start(app: &AppHandle) -> CommandResult<Value> {
    use crate::live_translation::{
        open_macos_privacy_pane, read_permission_status, request_microphone_permission,
        run_permission_command, sidecar_command,
    };

    if let Some(existing) = current_capture() {
        // Idempotent start, mirroring live translation: hand back the running
        // capture instead of failing while the previous one is still active.
        return Ok(existing.snapshot());
    }
    // The sidecar captures the microphone through ScreenCaptureKit even in
    // mic-only mode, so both TCC grants are required (same as live translation).
    // The microphone is asked in-process — see `mic_permission` for why the
    // grant has to be attributed to the Lynse bundle.
    let mut permissions = read_permission_status(app)?;
    if permissions.microphone != "granted" {
        permissions = request_microphone_permission(app)?;
    }
    if permissions.system_audio != "granted" {
        permissions = run_permission_command(app, "--request-system-audio")?;
    }
    if permissions.microphone != "granted" {
        open_macos_privacy_pane("microphone");
        return Err(
            "缺少麦克风权限。请在系统弹出的对话框中点击「允许」（或在「隐私与安全性 → 麦克风」中允许 Lynse），然后重新启动 Lynse。"
                .to_owned(),
        );
    }
    if permissions.system_audio != "granted" {
        open_macos_privacy_pane("screen");
        return Err(
            "缺少“屏幕与系统音频录制”权限。请在系统弹出的对话框中点击「允许」（或在「隐私与安全性 → 屏幕录制」中允许 Lynse），然后完全退出并重新启动 Lynse。"
                .to_owned(),
        );
    }

    let capture_id = format!("capture-{}", Uuid::new_v4());
    let directory = inspirations_root(app)?.join(&capture_id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let socket_path = std::env::temp_dir().join(format!("lynse-inspiration-{capture_id}.sock"));
    let _ = fs::remove_file(&socket_path);
    let listener =
        UnixListener::bind(&socket_path).map_err(|error| format!("bind audio IPC: {error}"))?;

    let mut command = sidecar_command(app)?;
    command
        .arg("--socket")
        .arg(&socket_path)
        .arg("--out")
        .arg(&directory)
        .arg("--sources")
        .arg("mic")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(&socket_path);
            return Err(format!("spawn audio-capture: {error}"));
        }
    };
    let stdout = child.stdout.take().ok_or("audio-capture stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("audio-capture stderr unavailable")?;

    let capture = Arc::new(VoiceCapture {
        capture_id,
        directory,
        socket_path: socket_path.clone(),
        child: Mutex::new(Some(child)),
        level: AtomicU32::new(0.0f32.to_bits()),
        elapsed_ms: AtomicU64::new(0),
        state: Mutex::new("connecting".to_owned()),
    });
    *CAPTURE.lock().expect("inspiration voice capture lock") = Some(capture.clone());

    // The sidecar writes mic.wav itself; this reader only drains the PCM
    // stream (so the sidecar never blocks on a full socket buffer) and turns
    // frames into throttled level events for the waveform.
    let reader_app = app.clone();
    let reader_capture = capture.clone();
    thread::spawn(move || {
        let result = (|| -> CommandResult<()> {
            let (mut stream, _) = listener
                .accept()
                .map_err(|error| format!("accept audio IPC: {error}"))?;
            let mut last_emit = Instant::now();
            loop {
                let mut header = [0u8; AUDIO_HEADER_BYTES];
                match stream.read_exact(&mut header) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(error) => return Err(format!("read audio IPC header: {error}")),
                }
                let (_source, _sequence, elapsed_ms, length) = decode_audio_header(&header)?;
                let mut payload = vec![0u8; length];
                stream
                    .read_exact(&mut payload)
                    .map_err(|error| format!("read audio IPC payload: {error}"))?;
                reader_capture
                    .elapsed_ms
                    .fetch_max(elapsed_ms.saturating_add(20), Ordering::Relaxed);
                reader_capture
                    .level
                    .store(frame_level(&payload).to_bits(), Ordering::Relaxed);
                if last_emit.elapsed() >= Duration::from_millis(80) {
                    last_emit = Instant::now();
                    emit_levels(&reader_app, &reader_capture);
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            emit_error(&reader_app, error);
        }
        let _ = fs::remove_file(&reader_capture.socket_path);
    });

    // Control channel: "ready" flips the UI from connecting to recording; a
    // sidecar death before an explicit stop surfaces as an error.
    let control_app = app.clone();
    let control_capture = capture.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            match value.get("event").and_then(Value::as_str) {
                Some("ready" | "resumed") => {
                    set_state(&control_capture, "recording");
                    let _ = control_app.emit(VOICE_EVENT, json!({ "type": "ready" }));
                }
                Some("error") => emit_error(
                    &control_app,
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("audio capture failed"),
                ),
                _ => {}
            }
        }
        let state = control_capture
            .state
            .lock()
            .expect("inspiration voice state lock")
            .clone();
        if state != "stopping" {
            set_state(&control_capture, "idle");
            emit_error(&control_app, "音频采集进程意外退出，本次录音未保存。");
        }
    });

    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log::debug!("audio-capture: {line}");
        }
    });

    Ok(capture.snapshot())
}

/// SIGTERM the sidecar and wait (bounded) for it to finalize its WAV, mirroring
/// `live_translation_stop`. The wait runs on the blocking pool so the async
/// runtime is never blocked by the child process.
#[cfg(target_os = "macos")]
async fn stop_sidecar(capture: &VoiceCapture) {
    if let Some(pid) = capture
        .child
        .lock()
        .expect("inspiration voice child lock")
        .as_ref()
        .map(Child::id)
    {
        let _ = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    let child = capture
        .child
        .lock()
        .expect("inspiration voice child lock")
        .take();
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
}

#[cfg(target_os = "macos")]
async fn platform_stop(_app: &AppHandle) -> CommandResult<Value> {
    let capture = take_capture().ok_or("no inspiration voice capture")?;
    set_state(&capture, "stopping");
    stop_sidecar(&capture).await;
    // The sidecar finalizes `mic.wav` on SIGTERM; adopt the stable name.
    let mic = capture.directory.join("mic.wav");
    let audio = capture.directory.join("audio.wav");
    if mic.exists() {
        fs::rename(&mic, &audio).map_err(|error| error.to_string())?;
    }
    if !audio.exists() {
        return Err("录音未能保存，请重试".to_owned());
    }
    Ok(json!({
        "audioPath": audio.to_string_lossy(),
        "durationMs": capture.elapsed_ms.load(Ordering::Relaxed),
    }))
}

#[cfg(target_os = "macos")]
async fn platform_cancel(_app: &AppHandle) -> CommandResult<()> {
    let Some(capture) = take_capture() else { return Ok(()) };
    set_state(&capture, "stopping");
    stop_sidecar(&capture).await;
    let _ = fs::remove_dir_all(&capture.directory);
    let _ = fs::remove_file(&capture.socket_path);
    Ok(())
}

// ── Windows: in-process cpal capture (no Swift sidecar) ────────────────────

#[cfg(target_os = "windows")]
fn platform_start(app: &AppHandle) -> CommandResult<Value> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    if let Some(existing) = current_capture() {
        return Ok(existing.snapshot());
    }
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

    let capture_id = format!("capture-{}", Uuid::new_v4());
    let directory = inspirations_root(app)?.join(&capture_id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let samples = Arc::new(Mutex::new(Vec::<i16>::new()));
    let live_level = Arc::new(AtomicU32::new(0.0f32.to_bits()));
    let sample_count = Arc::new(AtomicU64::new(0));
    let (done_tx, done_rx) = std::sync::mpsc::channel();

    let capture = Arc::new(VoiceCapture {
        capture_id,
        directory: directory.clone(),
        stop: Arc::new(AtomicBool::new(true)),
        level: AtomicU32::new(0.0f32.to_bits()),
        elapsed_ms: AtomicU64::new(0),
        state: Mutex::new("recording".to_owned()),
        done: Mutex::new(Some(done_rx)),
    });
    *CAPTURE.lock().expect("inspiration voice capture lock") = Some(capture.clone());

    // The capture thread keeps the cpal stream alive, mirrors level events to
    // the window at ~10 Hz, and finalizes the WAV once stop is requested.
    //
    // `cpal::Stream` is deliberately `!Send` on every platform (it wraps
    // `NotSendSyncAcrossAllPlatforms` in its Windows pipeWire/WASAPI backends),
    // so it is built *inside* this thread and never crosses a thread boundary.
    // `cpal::Device` is `Send`, so handing it over instead is safe.
    let capture_app = app.clone();
    let capture_stop = capture.stop.clone();
    let capture_mirror = capture.clone();
    thread::spawn(move || {
        macro_rules! build_input_stream {
            ($sample_type:ty) => {{
                let samples = samples.clone();
                let live_level = live_level.clone();
                let sample_count = sample_count.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[$sample_type], _| {
                        memo_feed_samples(data, channels, in_rate, &samples, &live_level, &sample_count);
                    },
                    move |error| log::error!("inspiration voice stream error: {error}"),
                    None,
                )
            }};
        }

        // Stream construction happens here rather than before the spawn, so a
        // failure can no longer be returned synchronously: report it through
        // the same channels the successful path uses.
        // The `_ =>` arm returns early (type `!`, unifies with the other
        // arms), so `.map_err` only has to normalize `BuildStreamError`.
        let started = (match sample_format {
            cpal::SampleFormat::F32 => build_input_stream!(f32),
            cpal::SampleFormat::I16 => build_input_stream!(i16),
            cpal::SampleFormat::U16 => build_input_stream!(u16),
            _ => {
                set_state(&capture_mirror, "idle");
                emit_error(&capture_app, "不支持的麦克风采样格式");
                let _ = done_tx.send(Err("不支持的麦克风采样格式".to_owned()));
                return;
            }
        })
        .map_err(|error| format!("创建麦克风输入流失败：{error}"))
        .and_then(|stream| {
            stream
                .play()
                .map(|()| stream)
                .map_err(|error| format!("启动麦克风输入流失败：{error}"))
        });

        let stream = match started {
            Ok(stream) => stream,
            Err(error) => {
                log::error!("inspiration voice capture failed: {error}");
                set_state(&capture_mirror, "idle");
                emit_error(&capture_app, error.clone());
                let _ = done_tx.send(Err(error));
                return;
            }
        };

        let mut last_emit = Instant::now();
        while capture_stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(100));
            if last_emit.elapsed() >= Duration::from_millis(100) {
                last_emit = Instant::now();
                let elapsed = sample_count.load(Ordering::Relaxed) * 1000 / 16_000;
                capture_mirror.elapsed_ms.store(elapsed, Ordering::Relaxed);
                capture_mirror
                    .level
                    .store(live_level.load(Ordering::Relaxed), Ordering::Relaxed);
                emit_levels(&capture_app, &capture_mirror);
            }
        }
        drop(stream);
        let pcm: Vec<i16> = samples
            .lock()
            .expect("inspiration voice pcm lock")
            .drain(..)
            .collect();
        let duration_ms = pcm.len() as u64 * 1000 / 16_000;
        let result = write_pcm16_wav(&directory.join("audio.wav"), &pcm).map(|_| duration_ms);
        let _ = done_tx.send(result);
    });

    Ok(capture.snapshot())
}

/// Mix down to mono, resample to 16 kHz, and append PCM16 samples to the memo
/// buffer. Same pipeline as the live-translation Windows microphone path, but
/// the samples land in a local buffer instead of a translation websocket.
#[cfg(target_os = "windows")]
fn memo_feed_samples<T>(
    data: &[T],
    channels: usize,
    in_rate: u32,
    samples: &Arc<Mutex<Vec<i16>>>,
    level: &AtomicU32,
    sample_count: &AtomicU64,
) where
    T: cpal::Sample,
    f32: cpal::FromSample<T>,
{
    // `Sample::from_sample` has to be in scope to be callable; macOS uses the
    // `audio-capture` sidecar and never compiles this path.
    use cpal::Sample;

    let mono: Vec<f32> = data
        .chunks(channels)
        .map(|frame| {
            let sum: f32 = frame.iter().map(|&sample| f32::from_sample(sample)).sum();
            sum / channels as f32
        })
        .collect();
    let resampled = resample_linear(&mono, in_rate, 16_000);
    if resampled.is_empty() {
        return;
    }
    let mut sum_squares = 0.0f64;
    for sample in &resampled {
        sum_squares += (*sample as f64).powi(2);
    }
    let rms = (sum_squares / resampled.len() as f64).sqrt().min(1.0) as f32;
    level.store(rms.to_bits(), Ordering::Relaxed);
    let converted: Vec<i16> = resampled
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * 32_767.0) as i16)
        .collect();
    sample_count.fetch_add(converted.len() as u64, Ordering::Relaxed);
    samples
        .lock()
        .expect("inspiration voice pcm lock")
        .extend_from_slice(&converted);
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

#[cfg(target_os = "windows")]
async fn platform_stop(_app: &AppHandle) -> CommandResult<Value> {
    let capture = take_capture().ok_or("no inspiration voice capture")?;
    set_state(&capture, "stopping");
    capture.stop.store(false, Ordering::Relaxed);
    let receiver = capture
        .done
        .lock()
        .expect("inspiration voice done lock")
        .take()
        .ok_or("inspiration voice capture already stopped")?;
    let directory = capture.directory.clone();
    let duration_ms = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(8))
            .map_err(|_| "等待录音结束超时".to_owned())?
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(json!({
        "audioPath": directory.join("audio.wav").to_string_lossy(),
        "durationMs": duration_ms,
    }))
}

#[cfg(target_os = "windows")]
async fn platform_cancel(_app: &AppHandle) -> CommandResult<()> {
    let Some(capture) = take_capture() else { return Ok(()) };
    set_state(&capture, "stopping");
    capture.stop.store(false, Ordering::Relaxed);
    // Take the receiver in its own statement: an `if let` scrutinee keeps the
    // temporary `MutexGuard` alive for the whole block, and a `std` guard is
    // `!Send` — holding it across `.await` makes the command's future `!Send`,
    // which Tauri rejects on Windows.
    let receiver = capture
        .done
        .lock()
        .expect("inspiration voice done lock")
        .take();
    if let Some(receiver) = receiver {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = receiver.recv_timeout(Duration::from_secs(8));
        })
        .await;
    }
    let _ = fs::remove_dir_all(&capture.directory);
    Ok(())
}

// ── Unsupported platforms ──────────────────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_start(_app: &AppHandle) -> CommandResult<Value> {
    Err("语音灵感仅支持 macOS 和 Windows".to_owned())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn platform_stop(_app: &AppHandle) -> CommandResult<Value> {
    Err("语音灵感仅支持 macOS 和 Windows".to_owned())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn platform_cancel(_app: &AppHandle) -> CommandResult<()> {
    Err("语音灵感仅支持 macOS 和 Windows".to_owned())
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Start a quick voice memo. Refuses while a live translation session owns the
/// microphone; an existing memo capture is returned idempotently.
#[tauri::command]
pub fn inspiration_voice_start(
    app: AppHandle,
    live: State<'_, LiveTranslationManager>,
) -> CommandResult<Value> {
    if live.has_active_session() {
        return Err("正在录音或实时转写中，请先结束后再记录语音灵感".to_owned());
    }
    platform_start(&app)
}

/// Stop the running memo and return the finalized WAV location plus duration.
#[tauri::command]
pub async fn inspiration_voice_stop(app: AppHandle) -> CommandResult<Value> {
    platform_stop(&app).await
}

/// Abort the running memo and discard its audio.
#[tauri::command]
pub async fn inspiration_voice_cancel(app: AppHandle) -> CommandResult<()> {
    platform_cancel(&app).await
}

/// Current memo capture snapshot (or idle) so the capture sheet can restore
/// its recording state, e.g. after a window reload.
#[tauri::command]
pub fn inspiration_voice_state() -> CommandResult<Value> {
    Ok(current_capture()
        .map(|capture| capture.snapshot())
        .unwrap_or_else(idle_snapshot))
}
