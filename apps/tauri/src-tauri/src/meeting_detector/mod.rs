// Meeting detection for auto-recording.
//
// A background thread polls the OS for processes that are actively sending or
// receiving audio (CoreAudio process objects on macOS, WASAPI audio sessions
// on Windows), matches them against a user-configurable whitelist of meeting
// apps (Tencent Meeting, Feishu, DingTalk, Zoom, Otter, …) and drives a small
// debounce state machine. `meeting_started` / `meeting_ended` are emitted as
// Tauri events; the webview-side agent (`MeetingAutoRecordAgent`) turns them
// into recording-session start/stop calls.
//
// The state machine in this file is platform-independent and unit-tested; the
// platform pollers live in `macos.rs` / `windows.rs`.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::CommandResult;

pub const MEETING_DETECTOR_EVENT: &str = "meeting-detector-event";

/// How often the poller samples audio activity.
pub const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// Signal persistence required before a meeting is confirmed, so short
/// notification sounds / media playback blips never start a recording.
pub const DEFAULT_START_DEBOUNCE_SECS: u64 = 15;
/// Silence tolerated inside a meeting before it is considered over (mic
/// breaks, everybody-muted stretches). A match arriving inside the grace
/// window merges back into the same meeting instead of starting a new one.
pub const DEFAULT_END_GRACE_SECS: u64 = 90;

/// One whitelist entry. On macOS a process matches by bundle ID (or executable
/// name for unbundled helpers); on Windows by executable name. Either list may
/// be empty — a list only participates when non-empty.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingApp {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub bundle_ids: Vec<String>,
    #[serde(default)]
    pub process_names: Vec<String>,
}

/// Full detector configuration, owned by the webview (persisted in
/// localStorage there) and pushed down on startup and on every change.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorConfig {
    pub enabled: bool,
    #[serde(default = "default_start_debounce")]
    pub start_debounce_secs: u64,
    #[serde(default = "default_end_grace")]
    pub end_grace_secs: u64,
    #[serde(default)]
    pub apps: Vec<MeetingApp>,
}

fn default_start_debounce() -> u64 {
    DEFAULT_START_DEBOUNCE_SECS
}

fn default_end_grace() -> u64 {
    DEFAULT_END_GRACE_SECS
}

impl Default for DetectorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            start_debounce_secs: DEFAULT_START_DEBOUNCE_SECS,
            end_grace_secs: DEFAULT_END_GRACE_SECS,
            apps: Vec::new(),
        }
    }
}

/// A process the platform poller observed with active audio IO (own process
/// tree already excluded by the pollers).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ActiveProcess {
    pub pid: u32,
    pub bundle_id: Option<String>,
    pub process_name: Option<String>,
}

/// A whitelist app matched by at least one active audio process.
#[derive(Clone, Debug, PartialEq)]
struct MatchedApp {
    id: String,
    name: String,
}

/// State-machine transitions surfaced to the webview.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetectorEvent {
    #[serde(rename = "type")]
    kind: String,
    app_id: Option<String>,
    app_name: Option<String>,
    detected_at: String,
    duration_secs: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    /// No matched audio.
    Idle,
    /// Matched audio present but the start debounce has not elapsed yet.
    Starting,
    /// Debounce elapsed; a confirmed meeting is (or recently was) running.
    InMeeting,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Starting => "starting",
            Phase::InMeeting => "in_meeting",
        }
    }
}

/// Snapshot served to the settings UI / diagnostics.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorStatus {
    pub enabled: bool,
    pub phase: String,
    pub app: Option<String>,
    pub meeting_started_at: Option<String>,
}

struct DetectorRuntime {
    phase: Phase,
    /// First sample of the current match streak (drives the start debounce,
    /// and becomes the meeting start time once confirmed).
    first_match_at: Option<Instant>,
    /// Most recent sample of the current match streak (drives the end grace).
    last_match_at: Option<Instant>,
    matched_app: Option<MatchedApp>,
    meeting_started_at: Option<Instant>,
    /// Start of the match streak that produced the current meeting — kept so
    /// the reported duration covers the whole meeting, not just post-debounce.
    meeting_start_wall: Option<String>,
}

impl Default for DetectorRuntime {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            first_match_at: None,
            last_match_at: None,
            matched_app: None,
            meeting_started_at: None,
            meeting_start_wall: None,
        }
    }
}

impl DetectorRuntime {
    /// Advance the state machine by one poll sample. Returns the event to
    /// emit, if any. `matched` is the deduplicated list of whitelist apps
    /// seen with active audio in this sample.
    fn tick(
        &mut self,
        config: &DetectorConfig,
        now: Instant,
        now_wall: &str,
        matched: &[MatchedApp],
    ) -> Option<MeetingDetectorEvent> {
        let debounce = Duration::from_secs(config.start_debounce_secs.max(1));
        let grace = Duration::from_secs(config.end_grace_secs.max(1));

        if matched.is_empty() {
            match self.phase {
                Phase::Idle => {}
                // Unconfirmed blip: the debounce was never satisfied, so the
                // streak simply resets instead of emitting anything.
                Phase::Starting => {
                    self.phase = Phase::Idle;
                    self.first_match_at = None;
                    self.last_match_at = None;
                    self.matched_app = None;
                }
                Phase::InMeeting => {
                    let last = self.last_match_at?;
                    if now.duration_since(last) >= grace {
                        let duration_secs = self
                            .first_match_at
                            .map(|start| now.duration_since(start).as_secs())
                            .unwrap_or(0);
                        let event = MeetingDetectorEvent {
                            kind: "meeting_ended".to_owned(),
                            app_id: self.matched_app.as_ref().map(|app| app.id.clone()),
                            app_name: self.matched_app.as_ref().map(|app| app.name.clone()),
                            detected_at: now_wall.to_owned(),
                            duration_secs: Some(duration_secs),
                        };
                        self.phase = Phase::Idle;
                        self.first_match_at = None;
                        self.last_match_at = None;
                        self.matched_app = None;
                        self.meeting_started_at = None;
                        self.meeting_start_wall = None;
                        return Some(event);
                    }
                }
            }
            return None;
        }

        let app = matched
            .iter()
            .find(|candidate| Some(&candidate.id) == self.matched_app.as_ref().map(|m| &m.id))
            .or_else(|| matched.first())?
            .clone();

        match self.phase {
            Phase::Idle => {
                self.phase = Phase::Starting;
                self.first_match_at = Some(now);
                self.last_match_at = Some(now);
                self.matched_app = Some(app);
            }
            Phase::Starting => {
                self.last_match_at = Some(now);
                self.matched_app = Some(app.clone());
                let first = self.first_match_at?;
                if now.duration_since(first) >= debounce {
                    self.phase = Phase::InMeeting;
                    self.meeting_started_at = Some(first);
                    self.meeting_start_wall = Some(now_wall.to_owned());
                    return Some(MeetingDetectorEvent {
                        kind: "meeting_started".to_owned(),
                        app_id: Some(app.id),
                        app_name: Some(app.name),
                        detected_at: now_wall.to_owned(),
                        duration_secs: None,
                    });
                }
            }
            Phase::InMeeting => {
                self.last_match_at = Some(now);
                self.matched_app = Some(app);
            }
        }
        None
    }

    fn reset(&mut self) {
        *self = Self::default();
    }

    fn status(&self, config: &DetectorConfig) -> DetectorStatus {
        DetectorStatus {
            enabled: config.enabled,
            phase: self.phase.as_str().to_owned(),
            app: self.matched_app.as_ref().map(|app| app.name.clone()),
            meeting_started_at: self.meeting_start_wall.clone(),
        }
    }
}

/// Managed handle: config written by the settings command, runtime advanced by
/// the polling thread and read by the status command.
pub struct MeetingDetectorHandle {
    config: Mutex<DetectorConfig>,
    runtime: Mutex<DetectorRuntime>,
}

impl Default for MeetingDetectorHandle {
    fn default() -> Self {
        Self {
            config: Mutex::new(DetectorConfig::default()),
            runtime: Mutex::new(DetectorRuntime::default()),
        }
    }
}

/// Lowercase helpers so "WemeetApp" / "COM.TENCENT.wemeetapp" still match.
fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Match one sample of active-audio processes against the whitelist,
/// deduplicating by app id (several processes of the same app are one match).
fn match_apps(config: &DetectorConfig, active: &[ActiveProcess]) -> Vec<MatchedApp> {
    let mut matched: Vec<MatchedApp> = Vec::new();
    for process in active {
        let bundle = process.bundle_id.as_deref().map(normalize);
        let name = process.process_name.as_deref().map(normalize);
        for app in &config.apps {
            let already = matched.iter().any(|m| m.id == app.id);
            let by_bundle = !app.bundle_ids.is_empty()
                && bundle
                    .as_deref()
                    .is_some_and(|bundle| app.bundle_ids.iter().any(|id| normalize(id) == bundle));
            let by_name = !app.process_names.is_empty()
                && name
                    .as_deref()
                    .is_some_and(|name| app.process_names.iter().any(|n| normalize(n) == name));
            if !already && (by_bundle || by_name) {
                matched.push(MatchedApp {
                    id: app.id.clone(),
                    name: app.name.clone(),
                });
            }
        }
    }
    matched
}

fn wall_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// True when the executable belongs to Lynse's own capture sidecar; those
/// processes hold the mic/system audio while *we* record and must never
/// trigger the detector.
fn is_own_capture_process(process_name: Option<&str>) -> bool {
    process_name
        .map(|name| name.contains("audio-capture"))
        .unwrap_or(false)
}

#[tauri::command]
pub fn meeting_detector_set_config(
    handle: State<'_, MeetingDetectorHandle>,
    config: DetectorConfig,
) -> CommandResult<DetectorStatus> {
    {
        let mut guard = handle
            .config
            .lock()
            .map_err(|_| "meeting detector config lock is poisoned")?;
        *guard = config;
    }
    meeting_detector_get_state(handle)
}

#[tauri::command]
pub fn meeting_detector_get_state(
    handle: State<'_, MeetingDetectorHandle>,
) -> CommandResult<DetectorStatus> {
    let config = handle
        .config
        .lock()
        .map_err(|_| "meeting detector config lock is poisoned")?
        .clone();
    let runtime = handle
        .runtime
        .lock()
        .map_err(|_| "meeting detector runtime lock is poisoned")?;
    Ok(runtime.status(&config))
}

/// Spawn the polling thread. Must be called once during app setup, after the
/// handle is managed. The thread lives for the whole process; while disabled
/// it only sleeps and keeps the runtime reset.
pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("meeting-detector".into())
        .spawn(move || {
            platform::init_thread();
            log::info!("Meeting detector polling every {}s", POLL_INTERVAL.as_secs());
            loop {
                std::thread::sleep(POLL_INTERVAL);
                if let Err(error) = poll_once(&app) {
                    log::debug!("Meeting detector poll failed: {error}");
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|error| log::error!("Failed to spawn meeting detector: {error}"));
}

fn poll_once(app: &AppHandle) -> CommandResult<()> {
    let handle = app.state::<MeetingDetectorHandle>();
    let config = handle
        .config
        .lock()
        .map_err(|_| "meeting detector config lock is poisoned")?
        .clone();

    if !config.enabled {
        handle
            .runtime
            .lock()
            .map_err(|_| "meeting detector runtime lock is poisoned")?
            .reset();
        return Ok(());
    }

    // The coarse fallback heuristic (default-input running + app merely
    // running) is only meaningful while *we* are not the ones holding the mic;
    // during our own sessions the precise per-process enumeration is exact.
    let allow_coarse = !app
        .try_state::<crate::live_translation::LiveTranslationManager>()
        .map(|manager| manager.has_active_session())
        .unwrap_or(false);

    // Exclude our own process tree: while Lynse records, its capture sidecar
    // holds the mic/system audio and must never look like "a meeting app is
    // using audio". (Windows captures in-process, hence the own-pid check.)
    let own_pid = std::process::id();
    let active: Vec<ActiveProcess> = platform::poll(allow_coarse)
        .into_iter()
        .filter(|process| process.pid != own_pid && !is_own_capture_process(process.process_name.as_deref()))
        .collect();
    let matched = match_apps(&config, &active);

    let event = handle
        .runtime
        .lock()
        .map_err(|_| "meeting detector runtime lock is poisoned")?
        .tick(&config, Instant::now(), &wall_now(), &matched);

    if let Some(event) = event {
        log::info!(
            "Meeting detector: {} ({})",
            event.kind,
            event.app_name.clone().unwrap_or_default()
        );
        if let Err(error) = app.emit(MEETING_DETECTOR_EVENT, &event) {
            log::error!("Failed to emit meeting detector event: {error}");
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;

#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod platform;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::ActiveProcess;

    pub fn init_thread() {}

    pub fn poll(_allow_coarse: bool) -> Vec<ActiveProcess> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, name: &str, bundle_ids: &[&str], process_names: &[&str]) -> MeetingApp {
        MeetingApp {
            id: id.to_owned(),
            name: name.to_owned(),
            bundle_ids: bundle_ids.iter().map(|s| s.to_string()).collect(),
            process_names: process_names.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn active(pid: u32, bundle_id: Option<&str>, process_name: Option<&str>) -> ActiveProcess {
        ActiveProcess {
            pid,
            bundle_id: bundle_id.map(|s| s.to_string()),
            process_name: process_name.map(|s| s.to_string()),
        }
    }

    fn config(apps: Vec<MeetingApp>) -> DetectorConfig {
        DetectorConfig {
            enabled: true,
            start_debounce_secs: 15,
            end_grace_secs: 90,
            apps,
        }
    }

    fn tick(
        runtime: &mut DetectorRuntime,
        config: &DetectorConfig,
        seconds: u64,
        matched: &[MatchedApp],
    ) -> Option<MeetingDetectorEvent> {
        runtime.tick(config, Instant::now() + Duration::from_secs(seconds), "t", matched)
    }

    fn matched(id: &str, name: &str) -> MatchedApp {
        MatchedApp {
            id: id.to_owned(),
            name: name.to_owned(),
        }
    }

    #[test]
    fn matches_by_bundle_id_case_insensitively() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &[])]);
        let active = vec![active(100, Some("US.Zoom.XOS"), Some("zoom"))];
        let matched = match_apps(&config, &active);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].id, "zoom");
    }

    #[test]
    fn matches_by_process_name() {
        let config = config(vec![app("wemeet", "腾讯会议", &[], &["wemeetapp"])]);
        let active = vec![active(100, None, Some("WemeetApp"))];
        assert_eq!(match_apps(&config, &active).len(), 1);
    }

    #[test]
    fn ignores_unlisted_processes_and_deduplicates_by_app() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &["zoom"])]);
        let active = vec![
            active(1, Some("com.apple.Music"), Some("Music")),
            active(2, Some("us.zoom.xos"), Some("zoom")),
            active(3, Some("us.zoom.xos"), Some("zoomAux")),
        ];
        let matched = match_apps(&config, &active);
        assert_eq!(matched.len(), 1, "several processes of one app match once");
    }

    #[test]
    fn empty_whitelist_list_does_not_match_anything() {
        let config = config(vec![app("zoom", "Zoom", &[], &[])]);
        let active = vec![active(1, Some("us.zoom.xos"), Some("zoom"))];
        assert!(match_apps(&config, &active).is_empty());
    }

    #[test]
    fn start_requires_debounce_of_persistent_signal() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &[])]);
        let match_one = vec![matched("zoom", "Zoom")];
        let mut runtime = DetectorRuntime::default();

        assert!(tick(&mut runtime, &config, 0, &match_one).is_none());
        assert!(tick(&mut runtime, &config, 6, &match_one).is_none());
        let event = tick(&mut runtime, &config, 15, &match_one).expect("debounce elapsed");
        assert_eq!(event.kind, "meeting_started");
        assert_eq!(event.app_name.as_deref(), Some("Zoom"));
        assert!(event.duration_secs.is_none());
    }

    #[test]
    fn a_brief_blip_never_confirms_a_meeting() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &[])]);
        let match_one = vec![matched("zoom", "Zoom")];
        let mut runtime = DetectorRuntime::default();

        assert!(tick(&mut runtime, &config, 0, &match_one).is_none());
        // Signal disappears before the debounce elapses, then never returns.
        assert!(tick(&mut runtime, &config, 6, &[]).is_none());
        assert_eq!(runtime.phase, Phase::Idle);
    }

    #[test]
    fn short_silence_inside_a_meeting_does_not_end_it() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &[])]);
        let match_one = vec![matched("zoom", "Zoom")];
        let mut runtime = DetectorRuntime::default();

        tick(&mut runtime, &config, 0, &match_one);
        assert!(tick(&mut runtime, &config, 15, &match_one).is_some());
        // 60s of silence: inside the grace window, no event.
        assert!(tick(&mut runtime, &config, 75, &[]).is_none());
        assert_eq!(runtime.phase, Phase::InMeeting);
        // Audio comes back: same meeting continues.
        assert!(tick(&mut runtime, &config, 80, &match_one).is_none());
    }

    #[test]
    fn meeting_ends_after_the_grace_window() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &[])]);
        let match_one = vec![matched("zoom", "Zoom")];
        let mut runtime = DetectorRuntime::default();

        tick(&mut runtime, &config, 0, &match_one);
        assert!(tick(&mut runtime, &config, 15, &match_one).is_some());
        let event = tick(&mut runtime, &config, 15 + 91, &[]).expect("grace elapsed");
        assert_eq!(event.kind, "meeting_ended");
        assert!(event.duration_secs.unwrap() >= 90);
        assert_eq!(runtime.phase, Phase::Idle);
    }

    #[test]
    fn a_new_meeting_after_the_grace_starts_a_fresh_session() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &[])]);
        let match_one = vec![matched("zoom", "Zoom")];
        let mut runtime = DetectorRuntime::default();

        tick(&mut runtime, &config, 0, &match_one);
        assert!(tick(&mut runtime, &config, 15, &match_one).is_some());
        assert!(tick(&mut runtime, &config, 15 + 91, &[]).is_some());
        // Fresh streak: debounce applies again.
        assert!(tick(&mut runtime, &config, 200, &match_one).is_none());
        let event = tick(&mut runtime, &config, 216, &match_one).expect("second meeting");
        assert_eq!(event.kind, "meeting_started");
    }

    #[test]
    fn resetting_clears_an_in_flight_meeting() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &[])]);
        let match_one = vec![matched("zoom", "Zoom")];
        let mut runtime = DetectorRuntime::default();

        tick(&mut runtime, &config, 0, &match_one);
        assert!(tick(&mut runtime, &config, 15, &match_one).is_some());
        runtime.reset();
        assert_eq!(runtime.phase, Phase::Idle);
        assert!(runtime.matched_app.is_none());
    }

    #[test]
    fn status_reflects_the_current_phase() {
        let config = config(vec![app("zoom", "Zoom", &["us.zoom.xos"], &[])]);
        let match_one = vec![matched("zoom", "Zoom")];
        let mut runtime = DetectorRuntime::default();

        assert_eq!(runtime.status(&config).phase, "idle");
        tick(&mut runtime, &config, 0, &match_one);
        assert_eq!(runtime.status(&config).phase, "starting");
        tick(&mut runtime, &config, 15, &match_one);
        let status = runtime.status(&config);
        assert_eq!(status.phase, "in_meeting");
        assert_eq!(status.app.as_deref(), Some("Zoom"));
    }

    #[test]
    fn own_capture_sidecar_processes_are_recognized() {
        assert!(is_own_capture_process(Some("/path/to/audio-capture")));
        assert!(!is_own_capture_process(Some("wemeetapp")));
        assert!(!is_own_capture_process(None));
    }
}
