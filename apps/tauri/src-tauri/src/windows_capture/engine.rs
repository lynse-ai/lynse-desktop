// Dual-track WASAPI capture engine for Windows meeting recording.
//
// Topology (one thread each; every thread owns its own COM apartment):
//
//   system_thread ─ WASAPI loopback (shared, event-driven) on the chosen
//   render endpoint → raw s16 stereo track (48 kHz) + mono downmix → the
//   serial AEC queue.
//
//   mic_thread ─ WASAPI capture (RAW mode requested, shared fallback) on the
//   chosen input endpoint → raw s16 mono track (48 kHz) → the serial AEC
//   queue (or the direct 16 kHz recognition path when no system track is
//   active).
//
//   aec_thread ─ the single serial processing queue (mirrors the macOS
//   `DualChannelProcessor`): 10 ms frames paired by 48 kHz timeline
//   position, echo-cancelled mic → `mic_processed.wav` + "本机" recognition
//   frames, system → `system.wav` + "远端" recognition frames.
//
// Timeline: GetBuffer's QPC device positions mapped onto one session clock
// that freezes during pauses. Missing spans keep their position and are
// padded with silence — never spliced away — and are recorded in the track
// manifest (`tracks.json`, the frozen cross-platform schema).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMOPTIONS_RAW,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use super::device::{
    ensure_com, install_device_notifications, resolve_capture_endpoint, resolve_render_endpoint,
    take_default_change, take_endpoints_change,
};
use crate::audio_contract::aec::{create as create_canceller, ENGINE_FRAME_SAMPLES};
use crate::audio_contract::framer::{PcmFramer, RecognitionFrame};
use crate::audio_contract::manifest::{
    DeviceInfo, GapRecord, TrackManifest, TrackRole, MANIFEST_FILE,
};
use crate::audio_contract::resampler::Resampler;
use crate::audio_contract::wav::WavTrackWriter;
use crate::audio_contract::{
    PROCESSING_SAMPLE_RATE, RECOGNITION_FRAME_MS, RECOGNITION_SAMPLE_RATE,
};

/// 200 ms of WASAPI buffer, in 100 ns units.
const BUFFER_HNS: i64 = 2_000_000;
/// How long a wait event is polled alongside the control flags.
const WAIT_SLICE_MS: u32 = 200;
/// Peaks are flushed this often (mirrors the macOS sidecar cadence).
const LEVELS_INTERVAL_MS: u64 = 200;
/// A stream chunk that starts later than this past the expected position
/// counts as a real gap (less than one recognition frame is callback jitter).
const GAP_TOLERANCE_MS: u64 = 25;
/// How many consecutive processed frames may lack a system frame before the
/// reference is treated as lost (≈300 ms of stream time; mirrors the macOS
/// processor's `referenceStallLimitFrames`).
const REFERENCE_STALL_LIMIT_FRAMES: usize = 30;
/// Queued-frame ceiling per track: beyond this (≈5 s) the consumer stalled;
/// the oldest frames are dropped and marked degraded rather than growing
/// memory for an hour-long meeting.
const MAX_QUEUED_FRAMES: usize = 500;
/// How often a stream with a dead device retries opening it.
const REOPEN_RETRY: Duration = Duration::from_secs(1);
/// Upper bound for one WASAPI device probe during `start`. On a cold audio
/// stack (first capture after boot/install) `Activate`/`Initialize`/`Start` can
/// wedge inside a COM call indefinitely; running the probe on a worker with a
/// deadline turns that hang into a normal start failure the UI can recover
/// from. A wedged worker is intentionally leaked — a thread stuck mid-COM-call
/// cannot be cancelled — which is far cheaper than freezing the whole app.
const DEVICE_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Default)]
pub struct CaptureConfig {
    /// Fixed mic endpoint id; `None` follows the default communications input.
    pub mic_endpoint: Option<String>,
    /// Fixed render endpoint id; `None` follows the default multimedia output.
    pub system_endpoint: Option<String>,
    /// Request AUDCLNT_STREAMOPTIONS_RAW on the microphone (fewer driver
    /// effects stacked under the app's processing). Falls back to plain
    /// shared mode, recording the actual mode in the manifest.
    pub raw_mic: bool,
    /// The dual_channel=false rollback: both sources still record, but no
    /// AEC bridge and no raw tracks — each stream writes its 16 kHz track
    /// directly (the legacy pipeline shape).
    pub aec_enabled: bool,
}

/// What the session wants to capture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sources {
    pub mic: bool,
    pub system: bool,
}

/// Events the session consumer reacts to — the Windows counterpart of the
/// macOS sidecar's stdout JSON lines.
pub enum EngineEvent {
    Ready {
        mic: Option<DeviceInfo>,
        system: Option<DeviceInfo>,
    },
    Diagnostic(String),
    Levels {
        mic: f32,
        system: f32,
    },
    /// One 640-byte recognition frame (16 kHz mono s16), already positioned
    /// on the session timeline.
    AudioFrame {
        source: u8,
        elapsed_ms: u64,
        bytes: Vec<u8>,
    },
    Stopped,
}

struct ControlState {
    paused: bool,
    stop: bool,
    /// Bumped on resume / device rebuild so streams re-open their clients.
    generation: u32,
}

struct SessionClock {
    started: Instant,
    paused_at: Option<Instant>,
    paused_total: Duration,
}

impl SessionClock {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            paused_at: None,
            paused_total: Duration::ZERO,
        }
    }

    fn elapsed_ms(&self) -> u64 {
        let now = self.paused_at.unwrap_or_else(Instant::now);
        (now - self.started - self.paused_total).as_millis() as u64
    }

    fn pause(&mut self) {
        if self.paused_at.is_none() {
            self.paused_at = Some(Instant::now());
        }
    }

    fn resume(&mut self) {
        if let Some(paused_at) = self.paused_at.take() {
            self.paused_total += paused_at.elapsed();
        }
    }
}

struct EngineShared {
    config: CaptureConfig,
    sources: Sources,
    directory: PathBuf,
    control: Mutex<ControlState>,
    control_wake: Condvar,
    clock: Mutex<SessionClock>,
    events: Sender<EngineEvent>,
    manifest: Mutex<TrackManifest>,
    /// Serial AEC bridge; present only when both sources are active.
    aec: Option<Mutex<AecBridge>>,
    /// Device facts captured by each stream thread on (re)open.
    mic_device: Mutex<Option<DeviceInfo>>,
    system_device: Mutex<Option<DeviceInfo>>,
    generation: AtomicU32,
    mic_level: AtomicU32,
    system_level: AtomicU32,
    /// Set once every thread joined and the manifest was finalised.
    done: AtomicBool,
}

impl EngineShared {
    fn control(&self) -> std::sync::MutexGuard<'_, ControlState> {
        self.control.lock().expect("capture control lock")
    }

    fn request_stop(&self) {
        if let Ok(mut control) = self.control.lock() {
            control.stop = true;
        }
        self.control_wake.notify_all();
    }

    fn set_paused(&self, paused: bool) {
        if let Ok(mut control) = self.control.lock() {
            if control.paused == paused || control.stop {
                return;
            }
            control.paused = paused;
            if paused {
                if let Ok(mut clock) = self.clock.lock() {
                    clock.pause();
                }
            }
        }
        self.control_wake.notify_all();
    }

    fn resume(&self) {
        if let Ok(mut control) = self.control.lock() {
            if !control.paused || control.stop {
                return;
            }
            control.paused = false;
            control.generation += 1;
            self.generation.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut clock) = self.clock.lock() {
                clock.resume();
            }
        }
        self.control_wake.notify_all();
    }

    fn emit(&self, event: EngineEvent) {
        let _ = self.events.send(event);
    }

    fn record_gap(&self, track: &str, start_ms: u64, end_ms: u64, reason: &str) {
        if end_ms <= start_ms {
            return;
        }
        if let Ok(mut manifest) = self.manifest.lock() {
            manifest.record_gap(GapRecord {
                track: track.to_owned(),
                start_ms,
                end_ms,
                reason: reason.to_owned(),
            });
        }
        self.emit(EngineEvent::Diagnostic(format!(
            "gap on {track}: {start_ms}..{end_ms}ms ({reason})"
        )));
    }

    fn set_device(&self, kind: SourceKind, info: DeviceInfo) {
        let slot = match kind {
            SourceKind::Mic => &self.mic_device,
            SourceKind::System => &self.system_device,
        };
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(info);
        }
    }
}

/// One ingest track of the serial queue: pending samples + complete 10 ms
/// frames waiting to be paired, keyed by absolute 48 kHz timeline position
/// (mirrors the macOS processor's `Track`).
#[derive(Default)]
struct AecTrack {
    pending: Vec<f32>,
    /// Absolute position (48 kHz samples) of `pending[0]`.
    next_position: i64,
    frames: VecDeque<(i64, Vec<f32>)>,
    /// Set once the first chunk arrived; positions before it are unknown.
    started: bool,
}

impl AecTrack {
    /// Ingest one device chunk; silence-pads timeline gaps, drops overlaps,
    /// cuts complete 10 ms frames. Returns the frames that became available.
    fn push(&mut self, position: i64, samples: &[f32]) {
        let mut samples = samples;
        let mut position = position;
        if !self.started {
            self.started = true;
            self.next_position = position;
        }
        if position < self.next_position {
            let overlap = (self.next_position - position) as usize;
            if overlap >= samples.len() {
                return;
            }
            samples = &samples[overlap..];
            position = self.next_position;
        }
        if position > self.next_position {
            // A real gap: pad with silence so later content keeps its
            // absolute timeline position.
            let gap = (position - self.next_position) as usize;
            self.append(&vec![0.0; gap]);
        }
        self.append(samples);
    }

    fn append(&mut self, samples: &[f32]) {
        let mut samples = samples;
        if !self.pending.is_empty() {
            let needed = ENGINE_FRAME_SAMPLES - self.pending.len();
            let take = needed.min(samples.len());
            self.pending.extend_from_slice(&samples[..take]);
            samples = &samples[take..];
            if self.pending.len() == ENGINE_FRAME_SAMPLES {
                self.frames
                    .push_back((self.next_position, std::mem::take(&mut self.pending)));
                self.next_position += ENGINE_FRAME_SAMPLES as i64;
            }
        }
        while samples.len() >= ENGINE_FRAME_SAMPLES {
            self.frames
                .push_back((self.next_position, samples[..ENGINE_FRAME_SAMPLES].to_vec()));
            self.next_position += ENGINE_FRAME_SAMPLES as i64;
            samples = &samples[ENGINE_FRAME_SAMPLES..];
        }
        if !samples.is_empty() {
            self.pending.extend_from_slice(samples);
        }
    }

    fn trim(&mut self, degraded: &mut Vec<[u64; 2]>) {
        while self.frames.len() > MAX_QUEUED_FRAMES {
            let (position, _) = self.frames.pop_front().expect("frame ceiling checked");
            degraded.push([
                position_ms(position),
                position_ms(position + ENGINE_FRAME_SAMPLES as i64),
            ]);
        }
    }
}

fn position_ms(position_samples: i64) -> u64 {
    (position_samples.max(0) as u64) * 1_000 / u64::from(PROCESSING_SAMPLE_RATE)
}

fn downmix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    if channels == 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// The serial echo-canceller queue state (fed by both capture threads,
/// drained only by the AEC thread).
struct AecBridge {
    mic: AecTrack,
    system: AecTrack,
    /// Frames processed without a system frame since the last system ingest
    /// (the stall counter behind `REFERENCE_STALL_LIMIT_FRAMES`).
    frames_since_system: usize,
    reference_lost: bool,
}

impl AecBridge {
    fn new() -> Self {
        Self {
            mic: AecTrack::default(),
            system: AecTrack::default(),
            frames_since_system: 0,
            reference_lost: false,
        }
    }

    /// Capture (re)start: drop buffered audio and restart the counters; the
    /// timeline base keeps running (both tracks re-anchor to it).
    fn reset(&mut self) {
        let mic_base = self.mic.next_position;
        let system_base = self.system.next_position;
        self.mic = AecTrack {
            next_position: mic_base.max(system_base),
            started: self.mic.started,
            ..AecTrack::default()
        };
        self.system = AecTrack {
            next_position: mic_base.max(system_base),
            started: self.system.started,
            ..AecTrack::default()
        };
        self.frames_since_system = 0;
    }
}

pub struct CaptureEngine {
    shared: Arc<EngineShared>,
    handles: Mutex<Vec<std::thread::JoinHandle<()>>>,
    events: Mutex<Receiver<EngineEvent>>,
    writers: Mutex<Vec<Arc<WavTrackWriter>>>,
}

impl CaptureEngine {
    /// Validate the requested endpoints up front and spin up the capture
    /// threads. A source that cannot be opened fails the whole start —
    /// silently downgrading to one track is not allowed (the user must see
    /// the error while they can still fix it).
    pub fn start(
        config: CaptureConfig,
        sources: Sources,
        directory: PathBuf,
    ) -> Result<Self, String> {
        if !sources.mic && !sources.system {
            return Err("at least one capture source is required".to_owned());
        }
        install_device_notifications();
        ensure_com();

        // Up-front availability check per source, with device facts for the
        // Ready event.
        let mic_probe = if sources.mic {
            Some(probe_device_with_timeout(
                &config.mic_endpoint,
                SourceKind::Mic,
                config.raw_mic,
            )?)
        } else {
            None
        };
        let system_probe = if sources.system {
            Some(probe_device_with_timeout(
                &config.system_endpoint,
                SourceKind::System,
                false,
            )?)
        } else {
            None
        };
        // Step markers: a start that never reaches Ready has no event-pump
        // logging yet, so these lines are the only way to tell WHICH call
        // (probe / writer / thread spawn) hung or failed on a given machine.
        log::info!(
            "capture probes ok: mic={}, system={}",
            describe_probe(mic_probe.as_ref()),
            describe_probe(system_probe.as_ref()),
        );

        let (events_tx, events_rx) = channel();
        let started_at = crate::now();
        let session_id = directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        // Engine id: the manifest must say which canceller actually ran. The
        // fallback backend is created here only when the feature build failed
        // to load its engine, so the id reflects reality either way.
        let aec_active = sources.mic && sources.system && config.aec_enabled;
        let manifest = if aec_active {
            TrackManifest::dual_channel(&session_id, &started_at, "pending".to_owned())
        } else if sources.mic && sources.system {
            TrackManifest::dual_legacy(&session_id, &started_at)
        } else {
            let role = if sources.mic { TrackRole::Mic } else { TrackRole::System };
            TrackManifest::single_source(&session_id, &started_at, role)
        };

        let shared = Arc::new(EngineShared {
            config,
            sources,
            directory,
            control: Mutex::new(ControlState {
                paused: false,
                stop: false,
                generation: 0,
            }),
            control_wake: Condvar::new(),
            clock: Mutex::new(SessionClock::new()),
            events: events_tx,
            manifest: Mutex::new(manifest),
            aec: aec_active.then(|| Mutex::new(AecBridge::new())),
            mic_device: Mutex::new(mic_probe.as_ref().map(|(info, _)| info.clone())),
            system_device: Mutex::new(system_probe.as_ref().map(|(info, _)| info.clone())),
            generation: AtomicU32::new(0),
            mic_level: AtomicU32::new(0.0f32.to_bits()),
            system_level: AtomicU32::new(0.0f32.to_bits()),
            done: AtomicBool::new(false),
        });

        // Writers are created eagerly so an unwritable session directory
        // fails the start instead of the stop. All tracks are 16-bit PCM
        // (the frozen cross-platform raw format); raw tracks sit at 48 kHz.
        let s16 = |rate: u32, channels: u16| crate::audio_contract::wav::WavFormat {
            sample_rate: rate,
            channels,
            bits_per_sample: 16,
            sample_format: "int",
        };
        let open_writer = |file: &str, rate: u32, channels: u16| -> Result<Arc<WavTrackWriter>, String> {
            let writer = WavTrackWriter::raw(&shared.directory.join(file), s16(rate, channels))
                .map_err(|error| format!("创建音轨文件 {file} 失败：{error}"))?;
            Ok(Arc::new(writer))
        };
        let dual = aec_active;
        let mut writers: Vec<Arc<WavTrackWriter>> = Vec::new();
        if sources.system {
            writers.push(open_writer("system_raw.wav", PROCESSING_SAMPLE_RATE, 2)?);
            writers.push(open_writer("system.wav", RECOGNITION_SAMPLE_RATE, 1)?);
        }
        if dual {
            writers.push(open_writer("mic_raw.wav", PROCESSING_SAMPLE_RATE, 1)?);
            writers.push(open_writer("mic_processed.wav", RECOGNITION_SAMPLE_RATE, 1)?);
        } else if sources.mic {
            writers.push(open_writer("mic.wav", RECOGNITION_SAMPLE_RATE, 1)?);
        }
        log::info!(
            "track writers opened: {} file(s) in {}",
            writers.len(),
            shared.directory.display()
        );

        let engine = Self {
            shared: shared.clone(),
            handles: Mutex::new(Vec::new()),
            events: Mutex::new(events_rx),
            writers: Mutex::new(writers.clone()),
        };
        let find_writer = |file: &str| {
            writers
                .iter()
                .find(|w| w.path().file_name().map(|n| n.to_string_lossy() == file).unwrap_or(false))
                .cloned()
                .expect("writer exists")
        };
        fn spawn(
            handles: &Mutex<Vec<std::thread::JoinHandle<()>>>,
            name: &'static str,
            body: impl FnOnce() + Send + 'static,
        ) -> Result<(), String> {
            let handle = std::thread::Builder::new()
                .name(name.to_owned())
                .spawn(body)
                .map_err(|error| format!("启动采集线程 {name} 失败：{error}"))?;
            handles.lock().expect("engine handles lock").push(handle);
            Ok(())
        }

        // Order matters for the AEC bridge: system first so the reference
        // lands before the mic frames that need cancelling.
        if sources.system {
            let thread_shared = shared.clone();
            let recognition = find_writer("system.wav");
            let raw = find_writer("system_raw.wav");
            spawn(&engine.handles, "lynse-capture-system", move || {
                run_stream_thread(thread_shared, Some(recognition), Some(raw), SourceKind::System)
            })?;
        }
        if sources.mic {
            let thread_shared = shared.clone();
            // Only the AEC thread takes the mic away from `mic.wav`, and only
            // when it actually runs: without `aec_enabled` the rollback layout
            // (`dual_legacy`) carries plain `mic.wav` and has no `mic_raw.wav`.
            let recognition = if dual {
                None
            } else {
                Some(find_writer("mic.wav"))
            };
            let raw = dual.then(|| find_writer("mic_raw.wav"));
            spawn(&engine.handles, "lynse-capture-mic", move || {
                run_stream_thread(thread_shared, recognition, raw, SourceKind::Mic)
            })?;
        }
        if dual {
            let thread_shared = shared.clone();
            let mic_writer = find_writer("mic_processed.wav");
            let system_writer = find_writer("system.wav");
            spawn(&engine.handles, "lynse-capture-aec", move || {
                run_aec_thread(thread_shared, mic_writer, system_writer)
            })?;
        }
        {
            let thread_shared = shared.clone();
            spawn(&engine.handles, "lynse-capture-levels", move || {
                run_levels_thread(thread_shared)
            })?;
        }

        log::info!(
            "capture threads spawned: {}",
            engine.handles.lock().map(|handles| handles.len()).unwrap_or(0)
        );
        shared.emit(EngineEvent::Ready {
            mic: mic_probe.map(|(info, _)| info),
            system: system_probe.map(|(info, _)| info),
        });
        Ok(engine)
    }

    pub fn pause(&self) {
        self.shared.set_paused(true);
    }

    pub fn resume(&self) {
        self.shared.resume();
    }

    /// Poll the next engine event (none when the queue is empty).
    pub fn try_event(&self) -> Option<EngineEvent> {
        self.events
            .lock()
            .ok()
            .and_then(|events| events.try_recv().ok())
    }

    /// Block up to `timeout` for the next engine event.
    pub fn recv_event_timeout(&self, timeout: Duration) -> Option<EngineEvent> {
        self.events
            .lock()
            .ok()
            .and_then(|events| events.recv_timeout(timeout).ok())
    }

    pub fn is_done(&self) -> bool {
        self.shared.done.load(Ordering::Relaxed)
    }

    /// Stop capture, join every thread (each flushes its own writers), then
    /// finalise and write the track manifest. Thread loops poll the stop flag
    /// at WAIT_SLICE_MS, so this converges quickly even with a dead device.
    pub fn stop(&self) {
        self.shared.request_stop();
        let handles = self
            .handles
            .lock()
            .map(|mut guard| std::mem::take(&mut *guard))
            .unwrap_or_default();
        for handle in handles {
            let _ = handle.join();
        }
        // Close any writer a panicked thread left open (thread exit paths do
        // this themselves; this is the crash guard).
        if let Ok(writers) = self.writers.lock() {
            for writer in writers.iter() {
                let _ = writer.close();
            }
        }
        self.finalize_manifest();
        self.shared.done.store(true, Ordering::Relaxed);
        self.shared.emit(EngineEvent::Stopped);
    }

    fn finalize_manifest(&self) {
        let Ok(mut manifest) = self.shared.manifest.lock() else {
            return;
        };
        if let Ok(writers) = self.writers.lock() {
            for writer in writers.iter() {
                let file = writer
                    .path()
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                // sampleFrames is additive; the frozen per-track fields stay
                // as written at start.
                let _ = file;
            }
        }
        let read_device = |slot: &Mutex<Option<DeviceInfo>>| {
            slot.lock().ok().and_then(|guard| guard.clone())
        };
        if let Some(devices) = manifest.devices.as_mut() {
            devices.mic = read_device(&self.shared.mic_device);
            devices.system = read_device(&self.shared.system_device);
        }
        let path = self.shared.directory.join(MANIFEST_FILE);
        if let Err(error) = crate::audio_contract::manifest::write_manifest(&path, &manifest) {
            log::warn!("manifest write failed: {error}");
        }
        log::info!(
            "Capture manifest finalised: session={} tracks={} degraded={}",
            manifest.session_id.as_deref().unwrap_or(""),
            manifest.tracks.len(),
            manifest.degraded_intervals_ms.len()
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceKind {
    Mic,
    System,
}

impl SourceKind {
    fn track_raw(self) -> &'static str {
        match self {
            Self::Mic => "mic_raw",
            Self::System => "system_raw",
        }
    }

    fn source_byte(self) -> u8 {
        match self {
            Self::Mic => 0,
            Self::System => 1,
        }
    }
}

fn device_enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe { CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .map_err(|error| error.to_string())
}

/// Bring up one WASAPI client purely to verify the endpoint works; torn down
/// immediately. Returns precise error text per source on failure.
/// `probe_device` on a worker thread bounded by [`DEVICE_PROBE_TIMEOUT`]. The
/// probe only validates a device and reads its format, returning plain data,
/// so the COM objects it opens never escape the worker. On timeout the worker
/// is leaked (it cannot be interrupted mid-COM-call) and the start fails with a
/// user-facing reason instead of hanging forever.
fn probe_device_with_timeout(
    endpoint: &Option<String>,
    kind: SourceKind,
    raw: bool,
) -> Result<(DeviceInfo, StreamFormat), String> {
    let label = match kind {
        SourceKind::Mic => "麦克风",
        SourceKind::System => "系统声音",
    };
    let endpoint = endpoint.clone();
    let (tx, rx) = channel();
    std::thread::Builder::new()
        .name("lynse-audio-probe".to_owned())
        .spawn(move || {
            let _ = tx.send(probe_device(&endpoint, kind, raw));
        })
        .map_err(|error| format!("启动 {label} 探测线程失败：{error}"))?;
    match rx.recv_timeout(DEVICE_PROBE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            log::error!(
                "{label} device probe timed out after {:?} — WASAPI call wedged",
                DEVICE_PROBE_TIMEOUT
            );
            Err(format!(
                "{label}设备探测超时（{}秒）：Windows 音频服务没有响应。请检查系统声音设置或插拔音频设备后重试。",
                DEVICE_PROBE_TIMEOUT.as_secs()
            ))
        }
    }
}

fn probe_device(
    endpoint: &Option<String>,
    kind: SourceKind,
    raw: bool,
) -> Result<(DeviceInfo, StreamFormat), String> {
    let opened = open_client(endpoint, kind, raw)?;
    let info = DeviceInfo {
        endpoint_id: opened.device_id.clone(),
        name: opened.device_name.clone(),
        raw_mode: opened.raw_mode,
        as_requested: endpoint.as_deref().map(|id| id == opened.device_id).unwrap_or(true),
    };
    Ok((info, opened.format))
}

/// Compact per-source identity for the start logs.
fn describe_probe(probe: Option<&(DeviceInfo, StreamFormat)>) -> String {
    match probe {
        Some((info, format)) => format!(
            "{} [{} Hz, {} ch, {}]",
            info.name,
            format.sample_rate,
            format.channels,
            if info.raw_mode { "raw" } else { "shared" }
        ),
        None => "off".to_owned(),
    }
}

#[derive(Clone, Copy, Debug)]
struct StreamFormat {
    sample_rate: u32,
    channels: u16,
}

struct OpenedClient {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: HANDLE,
    format: StreamFormat,
    raw_mode: bool,
    device_id: String,
    device_name: String,
    /// WASAPI keeps the activated client alive through the endpoint object it
    /// came from: releasing `IMMDevice` first leaves the client pointing at
    /// freed memory, which faults inside MMDevApi.dll on the next call. Kept
    /// as the last field so it is dropped after `client` and `capture`.
    _device: IMMDevice,
}

impl Drop for OpenedClient {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

fn open_client(
    endpoint: &Option<String>,
    kind: SourceKind,
    raw_requested: bool,
) -> Result<OpenedClient, String> {
    ensure_com();
    let enumerator = device_enumerator()?;
    let device = match kind {
        SourceKind::Mic => resolve_capture_endpoint(&enumerator, endpoint.as_deref()),
        SourceKind::System => resolve_render_endpoint(&enumerator, endpoint.as_deref()),
    }
    .map_err(|error| format!("解析设备失败：{error}"))?;
    let device_id = unsafe { device.GetId() }
        .ok()
        .and_then(|id| unsafe { id.to_string() }.ok())
        .ok_or("读取设备 id 失败")?;
    let device_name = super::device::device_name_of(&device);

    let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|error| format!("激活音频客户端失败：{error}"))?;
    let mix_format_ptr = unsafe { client.GetMixFormat() }
        .map_err(|error| format!("读取混音格式失败：{error}"))?;
    let (sample_rate, channels) = {
        let mix_format: &windows::Win32::Media::Audio::WAVEFORMATEX = unsafe { &*mix_format_ptr };
        (mix_format.nSamplesPerSec, mix_format.nChannels)
    };

    let stream_flags = match kind {
        // Loopback is shared-mode only by definition.
        SourceKind::System => AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_LOOPBACK,
        SourceKind::Mic => AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    };
    let initialize = |raw: bool| -> windows::core::Result<()> {
        let options: u32 = if raw { AUDCLNT_STREAMOPTIONS_RAW.0 as u32 } else { 0 };
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags | options,
                BUFFER_HNS,
                0,
                mix_format_ptr,
                None,
            )
        }
    };
    let mut raw_mode = false;
    let mut result = if raw_requested && matches!(kind, SourceKind::Mic) {
        raw_mode = true;
        initialize(true)
    } else {
        initialize(false)
    };
    if raw_mode && result.is_err() {
        // RAW is a preference, not a requirement: retry standard shared mode
        // and record the downgrade in the manifest.
        let error = result.unwrap_err();
        log::info!("RAW microphone mode unavailable ({error}); using shared mode");
        raw_mode = false;
        result = initialize(false);
    }
    result.map_err(|error| format!("初始化音频流失败：{error}"))?;

    let event = unsafe { CreateEventW(None, true, false, None) }
        .map_err(|error| format!("创建采集事件失败：{error}"))?;
    unsafe { client.SetEventHandle(event) }.map_err(|error| format!("绑定采集事件失败：{error}"))?;
    let capture: IAudioCaptureClient = unsafe { client.GetService() }
        .map_err(|error| format!("获取采集客户端失败：{error}"))?;
    unsafe { client.Start() }.map_err(|error| format!("启动音频流失败：{error}"))?;
    // The mix format blob is owned by WASAPI's allocator.
    unsafe { CoTaskMemFree(Some(mix_format_ptr.cast())) };
    Ok(OpenedClient {
        client,
        capture,
        event,
        format: StreamFormat {
            sample_rate,
            channels,
        },
        raw_mode,
        device_id,
        device_name,
        _device: device,
    })
}

/// QPC → session-timeline mapping for one stream thread.
struct QpcMapper {
    freq: f64,
    base_ticks: u64,
    base_ms: u64,
}

impl QpcMapper {
    fn new(clock_elapsed_ms: u64) -> Self {
        let mut freq = 0i64;
        let mut ticks = 0i64;
        unsafe {
            let _ = QueryPerformanceFrequency(&mut freq);
            let _ = QueryPerformanceCounter(&mut ticks);
        }
        Self {
            freq: freq as f64,
            base_ticks: ticks.max(0) as u64,
            base_ms: clock_elapsed_ms,
        }
    }

    /// Session-timeline ms of a GetBuffer QPC value.
    fn ms_at(&self, qpc: u64) -> u64 {
        let delta = qpc.saturating_sub(self.base_ticks) as f64 / self.freq * 1_000.0;
        self.base_ms.saturating_add(delta as u64)
    }
}

fn store_level(target: &AtomicU32, samples: &[f32]) {
    let peak = samples.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    target.store(peak.to_bits(), Ordering::Relaxed);
}

fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|v| (v.clamp(-1.0, 1.0) * 32_767.0).round() as i16)
        .collect()
}

fn write_frame(writer: Option<&Arc<WavTrackWriter>>, frame: &RecognitionFrame) {
    let Some(writer) = writer else { return };
    // Little-endian s16 pairs straight back to samples for the WAV track.
    let samples: Vec<i16> = frame
        .bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let _ = writer.write_i16_at(frame.elapsed_ms, &samples);
}

/// One capture stream: WASAPI loopback (system) or capture (mic).
///
/// `recognition_writer` is the 16 kHz mono track this stream writes directly
/// (system.wav for the system path; mic.wav in mic-only sessions). `raw_writer`
/// is the 48 kHz s16 verbatim track (None for the mic in single-source mode —
/// its 16 kHz track IS the raw recording, matching the macOS single-source
/// layout).
fn run_stream_thread(
    shared: Arc<EngineShared>,
    recognition_writer: Option<Arc<WavTrackWriter>>,
    raw_writer: Option<Arc<WavTrackWriter>>,
    kind: SourceKind,
) {
    let mut opened: Option<OpenedClient> = None;
    let mut resampler_48 = Resampler::new(48_000, PROCESSING_SAMPLE_RATE);
    let mut resampler_16 = Resampler::new(PROCESSING_SAMPLE_RATE, RECOGNITION_SAMPLE_RATE);
    let mut framer = PcmFramer::new();
    let mut mapper = QpcMapper::new(0);
    let mut last_chunk_end_ms: Option<u64> = None;
    let mut generation_seen = u32::MAX;

    'session: loop {
        // ---- control gate -------------------------------------------------
        {
            let mut control = shared.control();
            loop {
                if control.stop {
                    break 'session;
                }
                if control.paused {
                    // Stop feeding audio while paused: nothing lands on disk
                    // or in the recognition feed. The clock is frozen, so on
                    // resume the timeline continues where it left off.
                    let (guard, _) = shared
                        .control_wake
                        .wait_timeout(control, Duration::from_millis(WAIT_SLICE_MS as u64))
                        .expect("capture control lock");
                    control = guard;
                    continue;
                }
                break;
            }
        }

        // ---- device-change policy ------------------------------------------
        if take_default_change() || take_endpoints_change() {
            // Rebuilding unconditionally on any device notification is safe
            // and simple: the reopen path re-resolves the endpoint (follow
            // default picks up a new default; a fixed selection reconnects
            // when its endpoint reappears).
            if let Ok(mut control) = shared.control.lock() {
                control.generation += 1;
            }
            shared.generation.fetch_add(1, Ordering::Relaxed);
        }

        // ---- (re)open the stream -------------------------------------------
        let current_generation = shared.generation.load(Ordering::Relaxed);
        if opened.is_some() && generation_seen != current_generation {
            opened = None;
        }
        if opened.is_none() {
            let endpoint = match kind {
                SourceKind::Mic => shared.config.mic_endpoint.clone(),
                SourceKind::System => shared.config.system_endpoint.clone(),
            };
            match open_client(&endpoint, kind, shared.config.raw_mic) {
                Ok(client) => {
                    resampler_48 = Resampler::new(client.format.sample_rate, PROCESSING_SAMPLE_RATE);
                    resampler_16 = Resampler::new(PROCESSING_SAMPLE_RATE, RECOGNITION_SAMPLE_RATE);
                    framer = PcmFramer::new();
                    mapper = QpcMapper::new(shared.clock.lock().expect("clock lock").elapsed_ms());
                    last_chunk_end_ms = None;
                    let info = DeviceInfo {
                        endpoint_id: client.device_id.clone(),
                        name: client.device_name.clone(),
                        raw_mode: client.raw_mode,
                        as_requested: endpoint.as_deref().map(|id| id == client.device_id).unwrap_or(true),
                    };
                    shared.set_device(kind, info);
                    generation_seen = current_generation;
                    opened = Some(client);
                    shared.emit(EngineEvent::Diagnostic(format!(
                        "{kind:?} stream opened (generation {current_generation})"
                    )));
                }
                Err(error) => {
                    // The endpoint is gone (unplugged, service restarting).
                    // Keep the selection — never silently switch to another
                    // device — and retry. Gaps land on the timeline; the
                    // other track keeps recording.
                    if let Some(expected) = last_chunk_end_ms {
                        shared.record_gap(
                            kind.track_raw(),
                            expected,
                            expected + REOPEN_RETRY.as_millis() as u64,
                            "device_reconnect",
                        );
                    }
                    shared.emit(EngineEvent::Diagnostic(format!(
                        "{kind:?} stream unavailable, retrying: {error}"
                    )));
                    generation_seen = current_generation;
                    std::thread::sleep(REOPEN_RETRY);
                    continue;
                }
            }
        }
        let Some(state) = opened.as_mut() else { unreachable!("stream just opened") };

        // ---- wait for data ---------------------------------------------------
        let wait = unsafe { WaitForSingleObject(state.event, WAIT_SLICE_MS) };
        if wait == WAIT_TIMEOUT {
            continue;
        }

        // ---- drain packets -----------------------------------------------------
        loop {
            let packet_size = match unsafe { state.capture.GetNextPacketSize() } {
                Ok(size) => size,
                Err(_) => break,
            };
            if packet_size == 0 {
                break;
            }
            let mut data = std::ptr::null_mut::<u8>();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut device_position = 0u64;
            let mut qpc_position = 0u64;
            if unsafe {
                state.capture.GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc_position),
                )
            }
            .is_err()
            {
                break;
            }
            let bytes_per_frame = state.format.channels as usize * 4; // f32
            let mut interleaved: Vec<f32> = if data.is_null() || frames == 0 {
                Vec::new()
            } else {
                let slice =
                    unsafe { std::slice::from_raw_parts(data, frames as usize * bytes_per_frame) };
                slice
                    .chunks_exact(4)
                    .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
                    .collect()
            };
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                interleaved.iter_mut().for_each(|v| *v = 0.0);
            }
            let timestamp_error = flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0;
            let _ = unsafe { state.capture.ReleaseBuffer(frames) };

            let duration_ms = frames as f64 / f64::from(state.format.sample_rate) * 1_000.0;
            let chunk_end_ms = mapper.ms_at(qpc_position);
            let chunk_start_ms = chunk_end_ms.saturating_sub(duration_ms as u64);
            if timestamp_error {
                shared.record_gap(kind.track_raw(), chunk_start_ms, chunk_end_ms, "timestamp_error");
            } else if let Some(expected) = last_chunk_end_ms {
                if chunk_start_ms > expected + GAP_TOLERANCE_MS {
                    shared.record_gap(
                        kind.track_raw(),
                        expected,
                        chunk_start_ms,
                        "device_position_jump",
                    );
                }
            }
            last_chunk_end_ms = Some(chunk_end_ms);

            // Raw track keeps the verbatim device stream (s16 at the
            // processing rate — the frozen cross-platform raw format).
            if let Some(raw) = raw_writer.as_ref() {
                let _ = raw.write_i16_at(chunk_start_ms, &to_i16(&interleaved));
            }

            let mono = downmix_to_mono(&interleaved, state.format.channels);
            store_level(
                match kind {
                    SourceKind::Mic => &shared.mic_level,
                    SourceKind::System => &shared.system_level,
                },
                &mono,
            );
            let mono_48 = resampler_48.process(&mono);

            match kind {
                SourceKind::System => {
                    // Reference for the canceller + its own recognition path.
                    if let Some(Ok(mut bridge)) = shared.aec.as_ref().map(|aec| aec.lock()) {
                        let position = chunk_start_ms * u64::from(PROCESSING_SAMPLE_RATE) / 1_000;
                        bridge.system.push(position as i64, &mono_48);
                        bridge.frames_since_system = 0;
                    }
                    let mono_16 = resampler_16.process(&mono_48);
                    emit_frames(
                        &shared,
                        kind,
                        recognition_writer.as_ref(),
                        &mut framer,
                        &mono_16,
                        chunk_start_ms,
                    );
                }
                SourceKind::Mic => {
                    if shared.aec.is_some() {
                        // The AEC thread owns the processed recognition feed.
                        if let Some(Ok(mut bridge)) = shared.aec.as_ref().map(|aec| aec.lock()) {
                            let position = chunk_start_ms * u64::from(PROCESSING_SAMPLE_RATE) / 1_000;
                            bridge.mic.push(position as i64, &mono_48);
                        }
                    } else {
                        // Single-source session: no canceller, direct path.
                        let mono_16 = resampler_16.process(&mono_48);
                        emit_frames(
                            &shared,
                            kind,
                            recognition_writer.as_ref(),
                            &mut framer,
                            &mono_16,
                            chunk_start_ms,
                        );
                    }
                }
            }
        }
    }

    // ---- shutdown: flush tail frames and close writers ------------------------
    for frame in framer.finish() {
        write_frame(recognition_writer.as_ref(), &frame);
        let _ = shared.events.send(EngineEvent::AudioFrame {
            source: kind.source_byte(),
            elapsed_ms: frame.elapsed_ms,
            bytes: frame.bytes,
        });
    }
    if let Some(writer) = recognition_writer.as_ref() {
        let _ = writer.close();
    }
    if let Some(writer) = raw_writer.as_ref() {
        let _ = writer.close();
    }
}

fn emit_frames(
    shared: &Arc<EngineShared>,
    kind: SourceKind,
    writer: Option<&Arc<WavTrackWriter>>,
    framer: &mut PcmFramer,
    samples: &[f32],
    chunk_start_ms: u64,
) {
    for frame in framer.append(samples, chunk_start_ms) {
        if let Some((start, end)) = framer.pending_gap.take() {
            shared.record_gap(
                if kind == SourceKind::Mic { "mic_processed" } else { "system_processed" },
                start,
                end,
                "capture_gap",
            );
        }
        write_frame(writer, &frame);
        shared.emit(EngineEvent::AudioFrame {
            source: kind.source_byte(),
            elapsed_ms: frame.elapsed_ms,
            bytes: frame.bytes,
        });
    }
}

/// The serial echo-canceller queue: 10 ms frames paired by 48 kHz timeline
/// position — the Windows twin of the macOS `DualChannelProcessor.drain`.
///
/// Missing or late reference audio never deletes near-end audio: the mic
/// frame passes through (fed a silent reference so the engine keeps its
/// internal block alignment) and the interval is recorded as degraded.
fn run_aec_thread(
    shared: Arc<EngineShared>,
    mic_writer: Arc<WavTrackWriter>,
    system_writer: Arc<WavTrackWriter>,
) {
    let mut canceller = match create_canceller() {
        Ok(canceller) => canceller,
        Err(error) => {
            log::error!("echo canceller unavailable: {error}");
            return;
        }
    };
    {
        // Record the engine that will actually run in the manifest.
        if let Ok(mut manifest) = shared.manifest.lock() {
            manifest.engine = canceller.engine_id();
        }
    }
    let mut resampler_16 = Resampler::new(PROCESSING_SAMPLE_RATE, RECOGNITION_SAMPLE_RATE);
    // Each track keeps its own frame sequence (independent 20 ms cadence).
    let mut mic_framer = PcmFramer::new();
    let mut system_framer = PcmFramer::new();
    // The 48k→16k ratio is a whole 3:1, so the resampler is stateless in
    // practice; share it (it carries no phase at step 3.0).
    let mut generation_seen = shared.generation.load(Ordering::Relaxed);
    let mut flushed_degraded: Vec<[u64; 2]> = Vec::new();
    let mut mic_output_count: u64 = 0;
    let mut system_output_count: u64 = 0;

    // `emit16k` twin: hand 16 kHz samples to the recognition socket and the
    // track writer at absolute timeline positions (output-sample count ×
    // 1000 / 16000).
    macro_rules! emit_16k {
        ($samples:expr, $count:expr, $source:expr, $framer:expr, $writer:expr) => {{
            let samples: &[f32] = &$samples;
            if !samples.is_empty() {
                let start_ms = ($count as u64) * 1_000 / u64::from(RECOGNITION_SAMPLE_RATE);
                for frame in $framer.append(samples, start_ms) {
                    if let Some((gap_start, gap_end)) = $framer.pending_gap.take() {
                        shared.record_gap(
                            if $source == 0 { "mic_processed" } else { "system_processed" },
                            gap_start,
                            gap_end,
                            "capture_gap",
                        );
                    }
                    write_frame(Some(&$writer), &frame);
                    let _ = shared.events.send(EngineEvent::AudioFrame {
                        source: $source,
                        elapsed_ms: frame.elapsed_ms,
                        bytes: frame.bytes,
                    });
                }
                $count += samples.len() as u64;
            }
        }};
    }

    loop {
        if shared.control().stop {
            break;
        }
        if shared.generation.load(Ordering::Relaxed) != generation_seen {
            generation_seen = shared.generation.load(Ordering::Relaxed);
            canceller.reset();
            if let Some(Ok(mut bridge)) = shared.aec.as_ref().map(|aec| aec.lock()) {
                bridge.reset();
            }
        }
        let Some(aec) = shared.aec.as_ref() else { break };
        let mut processed_any = false;
        let mut degraded_spans: Vec<[u64; 2]> = Vec::new();
        if let Ok(mut bridge) = aec.lock() {
            bridge.mic.trim(&mut degraded_spans);
            bridge.system.trim(&mut degraded_spans);
            loop {
                // Peek head positions without moving the frames.
                let mic_position = bridge.mic.frames.front().map(|(position, _)| *position);
                let system_position = bridge.system.frames.front().map(|(position, _)| *position);
                if mic_position.is_none() && system_position.is_none() {
                    break;
                }

                // System-only head: no mic frame needs this reference.
                if let Some(system_at) = system_position {
                    if mic_position.map(|mic_at| system_at < mic_at).unwrap_or(true) {
                        let (_, system_samples) =
                            bridge.system.frames.pop_front().expect("head checked");
                        let reference_16k = resampler_16.process(&system_samples);
                        emit_16k!(reference_16k, system_output_count, 1, system_framer, system_writer);
                        continue;
                    }
                }
                let Some(mic_at) = mic_position else { break };

                if let Some(system_at) = system_position {
                    if system_at == mic_at {
                        let (_, system_samples) =
                            bridge.system.frames.pop_front().expect("head checked");
                        let (_, mut mic_samples) =
                            bridge.mic.frames.pop_front().expect("head checked");
                        let mut reference = system_samples.clone();
                        if canceller.process_reverse(&mut reference) {
                            // Frames are position-aligned, so the residual
                            // acoustic delay is small; AEC3's internal delay
                            // estimator absorbs it. (A correlation-based
                            // estimator like the macOS one is a refinement.)
                            if !canceller.process_near(&mut mic_samples, 0) {
                                degraded_spans.push([
                                    position_ms(mic_at),
                                    position_ms(mic_at + ENGINE_FRAME_SAMPLES as i64),
                                ]);
                            }
                        } else {
                            degraded_spans.push([
                                position_ms(mic_at),
                                position_ms(mic_at + ENGINE_FRAME_SAMPLES as i64),
                            ]);
                        }
                        bridge.reference_lost = false;
                        let mic_16 = resampler_16.process(&mic_samples);
                        emit_16k!(mic_16, mic_output_count, 0, mic_framer, mic_writer);
                        let reference_16k = resampler_16.process(&system_samples);
                        emit_16k!(reference_16k, system_output_count, 1, system_framer, system_writer);
                        processed_any = true;
                        continue;
                    }
                    // system_at > mic_at: the reference for this position no
                    // longer exists (a system-side gap jumped past it) —
                    // cancel with silence and record the degradation.
                }

                // No system frame buffered. A reference may still arrive.
                bridge.frames_since_system += 1;
                let stalled = bridge.frames_since_system >= REFERENCE_STALL_LIMIT_FRAMES
                    || bridge.mic.frames.len() >= REFERENCE_STALL_LIMIT_FRAMES;
                if !stalled {
                    break;
                }
                let (_, mut mic_samples) = bridge.mic.frames.pop_front().expect("head checked");
                if canceller.process_reverse(&mut vec![0.0; ENGINE_FRAME_SAMPLES]) {
                    let _ = canceller.process_near(&mut mic_samples, 0);
                }
                degraded_spans.push([
                    position_ms(mic_at),
                    position_ms(mic_at + ENGINE_FRAME_SAMPLES as i64),
                ]);
                bridge.reference_lost = true;
                let mic_16 = resampler_16.process(&mic_samples);
                emit_16k!(mic_16, mic_output_count, 0, mic_framer, mic_writer);
                processed_any = true;
            }
        }
        if !degraded_spans.is_empty() {
            flushed_degraded.extend(degraded_spans);
            if let Ok(mut manifest) = shared.manifest.lock() {
                for span in flushed_degraded.drain(..) {
                    manifest.mark_degraded(span[0], span[1]);
                }
            } else {
                flushed_degraded.clear();
            }
        }
        if !processed_any {
            std::thread::sleep(Duration::from_millis(8));
        }
    }
    for frame in mic_framer.finish() {
        write_frame(Some(&mic_writer), &frame);
        let _ = shared.events.send(EngineEvent::AudioFrame {
            source: 0,
            elapsed_ms: frame.elapsed_ms,
            bytes: frame.bytes,
        });
    }
    for frame in system_framer.finish() {
        write_frame(Some(&system_writer), &frame);
        let _ = shared.events.send(EngineEvent::AudioFrame {
            source: 1,
            elapsed_ms: frame.elapsed_ms,
            bytes: frame.bytes,
        });
    }
    let _ = mic_writer.close();
    let _ = system_writer.close();
}

fn run_levels_thread(shared: Arc<EngineShared>) {
    loop {
        if shared.control().stop {
            break;
        }
        std::thread::sleep(Duration::from_millis(LEVELS_INTERVAL_MS));
        let mic = f32::from_bits(shared.mic_level.load(Ordering::Relaxed));
        let system = f32::from_bits(shared.system_level.load(Ordering::Relaxed));
        shared.emit(EngineEvent::Levels { mic, system });
    }
}
