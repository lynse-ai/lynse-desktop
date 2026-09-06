//! Recording-card (NewView) device integration for the desktop app.
//!
//! Owns the BLE session lifecycle: scanning, connecting, vendor
//! authentication, record control, the live Opus audio stream and file
//! management. All device interaction happens on a session actor task that
//! owns the btleplug peripheral; Tauri commands talk to it through channels
//! and read shared snapshots.

mod decode;
mod protocol;
mod transfer;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager as PlatformManager, Peripheral, PeripheralId};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::{app_data_dir, get_store_value, now, save_store_value, CommandResult};
use decode::CardOpusDecoder;
use protocol::{parse_advertisement, OpusFormat, RecordMode, RecordStatus, StreamReassembler};

const EVENT: &str = "recording-card-event";
const STORE_DIR: &str = "recording-card";
const SETTINGS_ID: &str = "settings";
const DEVICE_ID: &str = "device";
const AUTH_TIMEOUT: Duration = Duration::from_secs(3);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const DELETE_TIMEOUT: Duration = Duration::from_secs(35);
const FILE_LIST_TIMEOUT: Duration = Duration::from_secs(8);
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const RECONNECT_SCAN_ROUNDS: u32 = 10;

/// Whether decoded card audio is routed into a running live-translation
/// session ("我" channel). Global because the audio actor reads it per frame.
static LIVE_FEED: AtomicBool = AtomicBool::new(true);

// ---------------------------------------------------------------------------
// State visible to the UI
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDevice {
    pub id: String,
    pub name: String,
    pub rssi: Option<i16>,
    pub device_code: String,
    pub protocol_version: u8,
    pub sku: Option<String>,
    pub has_storage: bool,
    pub has_meeting_recording: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDeviceInfo {
    pub id: String,
    pub name: String,
    pub mac: Option<String>,
    pub protocol_version: Option<u8>,
    pub sku: Option<String>,
    pub software_version: Option<String>,
    pub hardware_version: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardMemory {
    pub free_kb: i64,
    pub total_kb: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRecordingState {
    pub status: String,
    pub mode: Option<String>,
    pub duration_ms: Option<u64>,
    pub file_sn: Option<i64>,
    pub file_name: Option<String>,
    pub sample_rate_hz: Option<i64>,
    pub channels: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub sn: i64,
    pub name: String,
    pub received_bytes: i64,
    pub total_bytes: i64,
    pub auto_delete: bool,
    pub finished: bool,
    pub error: Option<String>,
    pub wav_path: Option<String>,
    pub opus_path: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardStateSnapshot {
    pub bluetooth_ready: bool,
    pub bluetooth_error: Option<String>,
    pub connected: bool,
    pub scanning: bool,
    pub discovered: Vec<DiscoveredDevice>,
    pub device: CardDeviceInfo,
    pub battery: Option<protocol::Battery>,
    pub memory: Option<CardMemory>,
    pub recording: Option<CardRecordingState>,
    pub files: Vec<transfer::CardFile>,
    pub transfer: Option<TransferProgress>,
    pub live_feed_enabled: bool,
    pub manufacturer_code_set: bool,
    pub saved_device: Option<SavedDevice>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CardSettings {
    manufacturer_code: String,
    live_feed: bool,
    auto_reconnect: bool,
}

impl Default for CardSettings {
    fn default() -> Self {
        Self {
            manufacturer_code: String::new(),
            live_feed: true,
            auto_reconnect: true,
        }
    }
}

#[derive(Clone, Default)]
struct SharedSession {
    device: CardDeviceInfo,
    connected: bool,
    battery: Option<protocol::Battery>,
    memory: Option<CardMemory>,
    recording: Option<CardRecordingState>,
    files: Vec<transfer::CardFile>,
    transfer: Option<TransferProgress>,
}

// ---------------------------------------------------------------------------
// Session actor
// ---------------------------------------------------------------------------

enum ActorCommand {
    Request {
        frame: Vec<u8>,
        expect: String,
        reply: oneshot::Sender<Result<protocol::ControlResponse, String>>,
    },
    FileList {
        reply: oneshot::Sender<Result<Vec<transfer::CardFile>, String>>,
    },
    StartTransfer {
        file: transfer::CardFile,
        auto_delete: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    CancelTransfer {
        reply: oneshot::Sender<Result<(), String>>,
    },
    StartRecord {
        mode: RecordMode,
        reply: oneshot::Sender<Result<protocol::RecordStateUpdate, String>>,
    },
    StopRecord {
        reply: oneshot::Sender<Result<protocol::RecordStateUpdate, String>>,
    },
    PauseResume {
        pause: bool,
        reply: oneshot::Sender<Result<protocol::RecordStateUpdate, String>>,
    },
    RecordMark {
        reply: oneshot::Sender<Result<(), String>>,
    },
}

struct SessionActorHandle {
    commands: mpsc::UnboundedSender<ActorCommand>,
    shared: Arc<Mutex<SharedSession>>,
    closed: Arc<AtomicBool>,
}

impl Clone for SessionActorHandle {
    fn clone(&self) -> Self {
        Self {
            commands: self.commands.clone(),
            shared: self.shared.clone(),
            closed: self.closed.clone(),
        }
    }
}

/// Core actor resources, destructured out of [`SessionActor`] before the main
/// loop so `tokio::select!` futures borrow disjoint locals instead of `self`.
struct ActorCore {
    app: AppHandle,
    peripheral: Peripheral,
    protocol_version: u8,
    manufacturer_code: String,
    shared: Arc<Mutex<SharedSession>>,
    closed: Arc<AtomicBool>,
}

struct ActorState {
    pending: Option<PendingRequest>,
    stream: StreamReassembler,
    opus: Option<CardOpusDecoder>,
    opus_frame_bytes: i64,
    stream_samples: u64,
    transfer: Option<ActiveTransfer>,
    file_list: Option<FileListWait>,
    last_level_emit: Instant,
}

struct PendingRequest {
    expect: String,
    reply: oneshot::Sender<Result<protocol::ControlResponse, String>>,
}

struct FileListWait {
    accumulator: Vec<u8>,
    page: usize,
    deadline: Instant,
    reply: oneshot::Sender<Result<Vec<transfer::CardFile>, String>>,
}

struct ActiveTransfer {
    file: transfer::CardFile,
    auto_delete: bool,
    protocol_v2: bool,
    received: Vec<u8>,
    last_progress: Instant,
}

async fn ble_write(
    peripheral: &Peripheral,
    characteristic: &btleplug::api::Characteristic,
    frame: Vec<u8>,
) -> Result<(), String> {
    peripheral
        .write(characteristic, &frame, WriteType::WithoutResponse)
        .await
        .map_err(|error| format!("BLE write failed: {error}"))
}

fn update_shared(core: &ActorCore, update: impl FnOnce(&mut SharedSession)) {
    update(&mut core.shared.lock().expect("session lock"));
}

fn emit_event(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit(EVENT, payload);
}

async fn actor_run(
    mut core: ActorCore,
    mut commands: mpsc::UnboundedReceiver<ActorCommand>,
    write_characteristic: btleplug::api::Characteristic,
) {
    let notifications = match core.peripheral.notifications().await {
        Ok(stream) => stream,
        Err(error) => {
            actor_fail(&core, format!("subscribe failed: {error}"));
            return;
        }
    };
    tokio::pin!(notifications);

    let mut state = ActorState {
        pending: None,
        stream: StreamReassembler::default(),
        opus: None,
        opus_frame_bytes: 80,
        stream_samples: 0,
        transfer: None,
        file_list: None,
        last_level_emit: Instant::now(),
    };

    // -- connect phase: authenticate, then read initial device info ----------
    if let Err(error) = authenticate(&core, &write_characteristic, &mut notifications).await {
        core.closed.store(true, Ordering::SeqCst);
        emit_event(&core.app, json!({ "type": "connection", "connected": false, "reason": error.clone() }));
        emit_event(&core.app, json!({ "type": "error", "message": error }));
        return;
    }
    query_initial(&mut core, &write_characteristic, &mut notifications, &mut state).await;
    let device = core.shared.lock().expect("session lock").device.clone();
    emit_event(&core.app, json!({ "type": "connection", "connected": true, "device": device }));

    // -- main loop -------------------------------------------------------------
    let mut connection_watch = tokio::time::interval(Duration::from_secs(2));
    connection_watch.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        if state
            .file_list
            .as_ref()
            .map(|wait| Instant::now() >= wait.deadline)
            .unwrap_or(false)
        {
            let wait = state.file_list.take().expect("checked");
            let message = "文件列表获取超时 / file list timed out".to_owned();
            emit_event(&core.app, json!({ "type": "error", "message": message }));
            let _ = wait.reply.send(Err(message));
        }
        tokio::select! {
            notification = notifications.next() => {
                match notification {
                    Some(value) => handle_notification(&mut core, &mut state, &value.value),
                    None => break,
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { break };
                handle_command(&mut core, &mut state, command, &write_characteristic).await;
            }
            _ = connection_watch.tick() => {
                if !core.peripheral.is_connected().await.unwrap_or(false) {
                    break;
                }
            }
        }
    }
    core.closed.store(true, Ordering::SeqCst);
    update_shared(&core, |shared| {
        shared.connected = false;
        shared.transfer = None;
    });
    emit_event(&core.app, json!({ "type": "connection", "connected": false, "reason": "session closed" }));
}

fn actor_fail(core: &ActorCore, message: String) {
    emit_event(&core.app, json!({ "type": "connection", "connected": false, "reason": message.clone() }));
    emit_event(&core.app, json!({ "type": "error", "message": message }));
}

/// Vendor authentication: send the manufacturer-code frame, wait for the
/// `*DEV#sdkkey#` / `*DEV#appkey#` acknowledgement, retry once.
async fn authenticate(
    core: &ActorCore,
    write_characteristic: &btleplug::api::Characteristic,
    notifications: &mut (impl futures_util::Stream<Item = btleplug::api::ValueNotification> + Unpin),
) -> Result<(), String> {
    if core.manufacturer_code.is_empty() {
        return Err("厂商码未设置，请先输入厂商码 / manufacturer code not set".to_owned());
    }
    for _ in 0..2 {
        ble_write(
            &core.peripheral,
            write_characteristic,
            protocol::auth_frame(core.protocol_version, &core.manufacturer_code),
        )
        .await?;
        let deadline = Instant::now() + AUTH_TIMEOUT;
        while Instant::now() < deadline {
            match timeout(AUTH_TIMEOUT, notifications.next()).await {
                Ok(Some(value)) => {
                    if protocol::is_auth_response(&value.value) {
                        return Ok(());
                    }
                    // Early record-state or other chatter is ignored during
                    // the auth window.
                }
                _ => break,
            }
        }
    }
    Err("鉴权失败：厂商码不正确，或固件需要加密 appkey（等待厂商提供算法）/ authentication failed: check the manufacturer code".to_owned())
}

/// Read version / battery / memory right after connect. Failures are
/// non-fatal: the user can re-query from the devices page.
async fn query_initial(
    core: &mut ActorCore,
    write_characteristic: &btleplug::api::Characteristic,
    notifications: &mut (impl futures_util::Stream<Item = btleplug::api::ValueNotification> + Unpin),
    state: &mut ActorState,
) {
    for (name, apply) in [
        ("version", Apply::Version),
        ("battery", Apply::Battery),
        ("memory", Apply::Memory),
    ] {
        if ble_write(&core.peripheral, write_characteristic, protocol::control_frame(name))
            .await
            .is_err()
        {
            continue;
        }
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            match timeout(Duration::from_millis(500), notifications.next()).await {
                Ok(Some(value)) => {
                    let data = value.value;
                    match protocol::parse_control_response(&data) {
                        Some(parsed) if parsed.name == name => {
                            apply_to_shared(&core.shared, &parsed, &apply);
                            break;
                        }
                        Some(parsed) => route_control_response(core, state, &parsed, &data),
                        None => {
                            // Live-audio or binary traffic before queries
                            // finish — route through the normal path.
                            handle_notification(core, state, &data);
                        }
                    }                }
                _ => break,
            }
        }
    }
}

enum Apply {
    Version,
    Battery,
    Memory,
}

fn apply_to_shared(shared: &Arc<Mutex<SharedSession>>, response: &protocol::ControlResponse, apply: &Apply) {
    let mut shared = shared.lock().expect("session lock");
    match apply {
        Apply::Version => {
            shared.device.software_version =
                Some(response.field(2).unwrap_or_default().to_owned()).filter(|value| !value.is_empty());
            shared.device.hardware_version =
                Some(response.field(3).unwrap_or_default().to_owned()).filter(|value| !value.is_empty());
        }
        Apply::Battery => {
            shared.battery = Some(protocol::Battery {
                left: response.number(2).unwrap_or(0),
                right: response.number(3).unwrap_or(0),
                main: response.number(4).unwrap_or(0),
            });
        }
        Apply::Memory => {
            shared.memory = Some(CardMemory {
                free_kb: response.number(2).unwrap_or(0),
                total_kb: response.number(3).unwrap_or(0),
            });
        }
    }
}

async fn handle_command(
    core: &mut ActorCore,
    state: &mut ActorState,
    command: ActorCommand,
    write_characteristic: &btleplug::api::Characteristic,
) {
    match command {
        ActorCommand::Request { frame, expect, reply } => {
            state.pending = Some(PendingRequest { expect, reply });
            if let Err(error) = ble_write(&core.peripheral, write_characteristic, frame).await {
                if let Some(pending) = state.pending.take() {
                    let _ = pending.reply.send(Err(error));
                }
            }
        }
        ActorCommand::FileList { reply } => {
            state.file_list = Some(FileListWait {
                accumulator: Vec::new(),
                page: 1,
                deadline: Instant::now() + FILE_LIST_TIMEOUT,
                reply,
            });
            if let Err(error) = ble_write(&core.peripheral, write_characteristic, transfer::get_file_list_frame()).await
            {
                if let Some(wait) = state.file_list.take() {
                    let _ = wait.reply.send(Err(error));
                }
            }
        }
        ActorCommand::StartTransfer { file, auto_delete, reply } => {
            let protocol_v2 = core.protocol_version >= 16;
            let outcome = ble_write(
                &core.peripheral,
                write_characteristic,
                transfer::ble_file_request_frame(protocol_v2, 1, file.sn, 0, auto_delete, None),
            )
            .await;
            match outcome {
                Ok(()) => {
                    let progress = TransferProgress {
                        sn: file.sn,
                        name: file.name.clone(),
                        received_bytes: 0,
                        total_bytes: file.size,
                        auto_delete,
                        finished: false,
                        error: None,
                        wav_path: None,
                        opus_path: None,
                    };
                    update_shared(core, |shared| shared.transfer = Some(progress.clone()));
                    emit_event(&core.app, json!({ "type": "transfer", "transfer": progress }));
                    state.transfer = Some(ActiveTransfer {
                        file,
                        auto_delete,
                        protocol_v2,
                        received: Vec::new(),
                        last_progress: Instant::now(),
                    });
                    let _ = reply.send(Ok(()));
                }
                Err(error) => {
                    let _ = reply.send(Err(error));
                }
            }
        }
        ActorCommand::CancelTransfer { reply } => {
            let outcome = match state.transfer.take() {
                Some(active) => {
                    let frame = transfer::ble_file_cancel_frame(active.protocol_v2, active.file.sn);
                    let written = ble_write(&core.peripheral, write_characteristic, frame).await;
                    let progress = active.progress_value(Some("canceled".to_owned()), true, None, None);
                    update_shared(core, |shared| shared.transfer = Some(progress.clone()));
                    emit_event(&core.app, json!({ "type": "transfer", "transfer": progress }));
                    written
                }
                None => Err("no active transfer".to_owned()),
            };
            let _ = reply.send(outcome);
        }
        ActorCommand::StartRecord { mode, reply } => {
            let frame = protocol::record_frame(1, mode, 1);
            let _ = reply.send(request_record(core, state, frame).await);
        }
        ActorCommand::StopRecord { reply } => {
            let frame = protocol::record_frame(0, current_mode(core), 1);
            let _ = reply.send(request_record(core, state, frame).await);
        }
        ActorCommand::PauseResume { pause, reply } => {
            let frame = protocol::record_frame(if pause { 2 } else { 3 }, current_mode(core), 1);
            let _ = reply.send(request_record(core, state, frame).await);
        }
        ActorCommand::RecordMark { reply } => {
            let outcome = request(core, state, protocol::control_frame("recmark"), "recmark")
                .await
                .and_then(|response| match response.number(2) {
                    Some(0) | None => Ok(()),
                    Some(status) => Err(format!("device rejected mark (status {status})")),
                });
            emit_event(&core.app, json!({ "type": "mark" }));
            let _ = reply.send(outcome);
        }
    }
}

fn current_mode(core: &ActorCore) -> RecordMode {
    core.shared
        .lock()
        .expect("session lock")
        .recording
        .as_ref()
        .and_then(|recording| recording.mode.as_deref())
        .map(|mode| match mode {
            "call" => RecordMode::Call,
            "media" => RecordMode::Media,
            _ => RecordMode::Meeting,
        })
        .unwrap_or(RecordMode::Meeting)
}

async fn request(
    core: &mut ActorCore,
    state: &mut ActorState,
    frame: Vec<u8>,
    expect: &str,
) -> Result<protocol::ControlResponse, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    state.pending = Some(PendingRequest {
        expect: expect.to_owned(),
        reply: reply_tx,
    });
    ble_write(&core.peripheral, &find_characteristic(&core.peripheral)?, frame).await?;
    match timeout(COMMAND_TIMEOUT, reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            state.pending = None;
            Err(format!("{expect} request interrupted"))
        }
        Err(_) => {
            state.pending = None;
            Err(format!("{expect} request timed out"))
        }
    }
}

fn find_characteristic(peripheral: &Peripheral) -> Result<btleplug::api::Characteristic, String> {
    peripheral
        .characteristics()
        .into_iter()
        .find(|characteristic| characteristic.uuid == protocol::WRITE_CHARACTERISTIC_UUID)
        .ok_or_else(|| "device write characteristic missing".to_owned())
}

async fn request_record(
    core: &mut ActorCore,
    state: &mut ActorState,
    frame: Vec<u8>,
) -> Result<protocol::RecordStateUpdate, String> {
    let response = request(core, state, frame, "record").await?;
    protocol::parse_record_response(&response).ok_or_else(|| "malformed record response".to_owned())
}

fn handle_notification(core: &mut ActorCore, state: &mut ActorState, data: &[u8]) {
    // Live-audio frames: stream headers or binary continuations.
    if data.starts_with(b"*DEV#stream#") {
        if let Some(frame) = state.stream.feed(data) {
            handle_audio_frame(core, state, frame);
        }
        return;
    }
    if !data.starts_with(b"*DEV#") {
        if state.transfer.is_some() {
            handle_transfer_data(core, state, data);
        } else if state.file_list.is_some() {
            handle_file_list_data(core, state, data);
        } else if let Some(frame) = state.stream.feed(data) {
            handle_audio_frame(core, state, frame);
        }
        return;
    }
    if protocol::is_auth_response(data) {
        return;
    }
    let Some(response) = protocol::parse_control_response(data) else {
        return;
    };
    route_control_response(core, state, &response, data);
}

fn route_control_response(
    core: &mut ActorCore,
    state: &mut ActorState,
    response: &protocol::ControlResponse,
    raw: &[u8],
) {
    match response.name.as_str() {
        "record" => {
            if let Some(update) = protocol::parse_record_response(response) {
                apply_record_update(core, state, &update);
            }
            resolve_pending(state, response);
        }
        "filecmd" => {
            if let Some(outcome) = transfer::parse_transfer_terminal(response) {
                if let Some(active) = state.transfer.take() {
                    active.finish(&core.app, &core.shared, outcome);
                }
            }
            resolve_pending(state, response);
        }
        "list" | "flist" => {
            handle_file_list_data(core, state, raw);
        }
        _ => resolve_pending(state, response),
    }
}

fn resolve_pending(state: &mut ActorState, response: &protocol::ControlResponse) {
    if let Some(pending) = state.pending.take() {
        if pending.expect == response.name || response.name == "error" {
            let _ = pending.reply.send(Ok(response.clone()));
        } else {
            state.pending = Some(pending);
        }
    }
}

fn apply_record_update(core: &mut ActorCore, state: &mut ActorState, update: &protocol::RecordStateUpdate) {
    let recording = CardRecordingState {
        status: match update.status {
            RecordStatus::Recording => "recording",
            RecordStatus::Paused => "paused",
            RecordStatus::Idle => "idle",
        }
        .to_owned(),
        mode: update
            .mode
            .map(|mode| match mode {
                RecordMode::Meeting => "meeting",
                RecordMode::Call => "call",
                RecordMode::Media => "media",
            })
            .map(str::to_owned),
        duration_ms: update.duration_ms,
        file_sn: update.file_sn,
        file_name: update.file_name.clone(),
        sample_rate_hz: update.opus_format.map(|format| format.sample_rate_hz),
        channels: update.opus_format.map(|format| format.channels),
    };
    if let Some(format) = update.opus_format {
        ensure_decoder(core, state, format);
    }
    update_shared(core, |shared| shared.recording = Some(recording.clone()));
    emit_event(&core.app, json!({ "type": "record", "recording": recording }));
}

fn ensure_decoder(core: &ActorCore, state: &mut ActorState, format: OpusFormat) {
    let frame_bytes = format.frame_bytes.max(1);
    if state.opus_frame_bytes == frame_bytes && state.opus.is_some() {
        return;
    }
    match CardOpusDecoder::new(format) {
        Ok(decoder) => {
            state.opus_frame_bytes = frame_bytes;
            state.opus = Some(decoder);
        }
        Err(error) => {
            emit_event(&core.app, json!({ "type": "error", "message": format!("opus decoder init failed: {error}") }));
        }
    }
}

fn handle_audio_frame(core: &mut ActorCore, state: &mut ActorState, frame: protocol::ReassembledStream) {
    let Some(mono) = state.opus.as_mut().map(|decoder| decoder.push(&frame.payload)) else {
        return;
    };
    state.stream_samples = state.stream_samples.saturating_add(mono.len() as u64);
    let elapsed_ms = state.stream_samples.saturating_mul(1000) / decode::OUTPUT_SAMPLE_RATE as u64;
    if LIVE_FEED.load(Ordering::Relaxed) {
        crate::live_translation::feed_recording_card_pcm(&mono, elapsed_ms);
    }
    if state.last_level_emit.elapsed() >= Duration::from_millis(200) {
        state.last_level_emit = Instant::now();
        emit_event(&core.app, json!({ "type": "level", "level": rms_level(&mono), "elapsedMs": elapsed_ms }));
    }
}

fn handle_transfer_data(core: &mut ActorCore, state: &mut ActorState, data: &[u8]) {
    let payload = transfer::strip_packet_header(data);
    let Some(active) = state.transfer.as_mut() else {
        return;
    };
    active.received.extend_from_slice(payload);
    let complete = active.file.size > 0 && active.received.len() as i64 >= active.file.size;
    if complete || active.last_progress.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
        active.last_progress = Instant::now();
        let progress = active.progress_value(None, false, None, None);
        update_shared(core, |shared| shared.transfer = Some(progress.clone()));
        emit_event(&core.app, json!({ "type": "transfer", "transfer": progress }));
    }
    if complete {
        let active = state.transfer.take().expect("checked");
        active.finish(&core.app, &core.shared, Ok(()));
    }
}

fn handle_file_list_data(core: &mut ActorCore, state: &mut ActorState, data: &[u8]) {
    let Some(wait) = state.file_list.as_mut() else {
        return;
    };
    wait.accumulator.extend_from_slice(data);
    match transfer::parse_file_list(&wait.accumulator) {
        transfer::FileListParse::Records(files, more) => {
            if more {
                wait.accumulator.clear();
                wait.page += 1;
                let peripheral = core.peripheral.clone();
                let characteristic = match find_characteristic(&peripheral) {
                    Ok(characteristic) => characteristic,
                    Err(_) => return,
                };
                let frame = transfer::list_chunk_frame(wait.page, 1);
                tokio::spawn(async move {
                    let _ = ble_write(&peripheral, &characteristic, frame).await;
                });
                return;
            }
            let wait = state.file_list.take().expect("checked");
            update_shared(core, |shared| shared.files = files.clone());
            emit_event(&core.app, json!({ "type": "files", "files": files.clone() }));
            let _ = wait.reply.send(Ok(files));
        }
        transfer::FileListParse::Incomplete => {}
        transfer::FileListParse::Invalid => {
            let wait = state.file_list.take().expect("checked");
            let message = format!(
                "无法识别的文件列表格式（{} 字节，hex 前缀 {}）；需厂商文件列表编解码",
                wait.accumulator.len(),
                wait.accumulator
                    .iter()
                    .take(24)
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            emit_event(&core.app, json!({ "type": "error", "message": message }));
            let _ = wait.reply.send(Err(message));
        }
    }
}

impl ActiveTransfer {
    fn progress_value(
        &self,
        error: Option<String>,
        finished: bool,
        wav_path: Option<String>,
        opus_path: Option<String>,
    ) -> TransferProgress {
        TransferProgress {
            sn: self.file.sn,
            name: self.file.name.clone(),
            received_bytes: self.received.len() as i64,
            total_bytes: self.file.size,
            auto_delete: self.auto_delete,
            finished,
            error,
            wav_path,
            opus_path,
        }
    }

    fn finish(self, app: &AppHandle, shared: &Arc<Mutex<SharedSession>>, outcome: Result<(), String>) {
        let (wav_path, opus_path, error) = match outcome {
            Ok(()) => match persist_transfer(app, &self.file, &self.received) {
                Ok((wav, opus)) => (Some(wav), Some(opus), None),
                Err(error) => (None, None, Some(error)),
            },
            Err(error) => (None, None, Some(error)),
        };
        let progress = self.progress_value(error, true, wav_path, opus_path);
        shared.lock().expect("session lock").transfer = Some(progress.clone());
        emit_event(app, json!({ "type": "transfer", "transfer": progress }));
    }
}

fn rms_level(mono: &[i16]) -> f32 {
    if mono.is_empty() {
        return 0.0;
    }
    let sum: f64 = mono.iter().map(|sample| (*sample as f64 / 32768.0).powi(2)).sum();
    ((sum / mono.len() as f64).sqrt()).min(1.0) as f32
}

fn persist_transfer(
    app: &AppHandle,
    file: &transfer::CardFile,
    opus_bytes: &[u8],
) -> Result<(String, String), String> {
    let base = card_recordings_dir(app)?;
    std::fs::create_dir_all(&base).map_err(|error| format!("create dir: {error}"))?;
    let opus_path = base.join(format!("{}-{}.opus", file.name, file.sn));
    std::fs::write(&opus_path, opus_bytes).map_err(|error| format!("write opus: {error}"))?;

    let format = OpusFormat {
        sample_rate_hz: decode::OUTPUT_SAMPLE_RATE as i64,
        channels: 2,
        frame_bytes: file.frame_bytes.max(1),
    };
    let mut decoder = CardOpusDecoder::new(format).map_err(|error| format!("decoder init: {error}"))?;
    let mut mono = decoder.push(opus_bytes);
    mono.extend(decoder.push(&[])); // flush the carry buffer
    let wav_path = base.join(format!("{}-{}.wav", file.name, file.sn));
    decode::write_wav(&wav_path, &mono).map_err(|error| format!("write wav: {error}"))?;
    Ok((
        wav_path.to_string_lossy().into_owned(),
        opus_path.to_string_lossy().into_owned(),
    ))
}

pub(crate) fn card_recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("recordings").join("card"))
}

// ---------------------------------------------------------------------------
// Manager (tauri State)
// ---------------------------------------------------------------------------

pub struct RecordingCardManager {
    app: AppHandle,
    inner: Mutex<ManagerInner>,
}

struct ManagerInner {
    adapter: Option<Adapter>,
    bluetooth_error: Option<String>,
    scanning: bool,
    discovered: HashMap<String, DiscoveredDevice>,
    discovered_ids: HashMap<String, PeripheralId>,
    session: Option<SessionActorHandle>,
    settings: CardSettings,
    saved_device: Option<SavedDevice>,
    settings_loaded: bool,
}

impl RecordingCardManager {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Mutex::new(ManagerInner {
                adapter: None,
                bluetooth_error: None,
                scanning: false,
                discovered: HashMap::new(),
                discovered_ids: HashMap::new(),
                session: None,
                settings: CardSettings::default(),
                saved_device: None,
                settings_loaded: false,
            }),
        }
    }

    fn load_settings(&self) {
        let mut inner = self.inner.lock().expect("card manager lock");
        if inner.settings_loaded {
            return;
        }
        inner.settings_loaded = true;
        if let Some(value) = get_store_value(&self.app, STORE_DIR, SETTINGS_ID).ok().flatten() {
            if let Ok(parsed) = serde_json::from_value::<CardSettings>(value) {
                inner.settings = parsed;
            }
        }
        if let Some(value) = get_store_value(&self.app, STORE_DIR, DEVICE_ID).ok().flatten() {
            if let Ok(parsed) = serde_json::from_value::<SavedDevice>(value) {
                inner.saved_device = Some(parsed);
            }
        }
        LIVE_FEED.store(inner.settings.live_feed, Ordering::Relaxed);
    }

    fn persist_settings(&self, settings: &CardSettings) {
        let mut value = serde_json::to_value(settings).expect("settings serialize");
        if let Some(object) = value.as_object_mut() {
            object.insert("id".into(), json!(SETTINGS_ID));
            object.insert("createdAt".into(), json!(now()));
        }
        let _ = save_store_value(&self.app, STORE_DIR, value);
    }

    fn persist_device(&self, device: &SavedDevice) {
        let mut value = serde_json::to_value(device).expect("device serialize");
        if let Some(object) = value.as_object_mut() {
            object.insert("id".into(), json!(DEVICE_ID));
            object.insert("createdAt".into(), json!(now()));
        }
        let _ = save_store_value(&self.app, STORE_DIR, value);
    }

    async fn ensure_adapter(&self) -> Result<Adapter, String> {
        {
            let inner = self.inner.lock().expect("card manager lock");
            if let Some(adapter) = &inner.adapter {
                return Ok(adapter.clone());
            }
            if let Some(error) = &inner.bluetooth_error {
                return Err(error.clone());
            }
        }
        let manager =
            PlatformManager::new()
                .await
                .map_err(|error| format!("蓝牙初始化失败 / bluetooth init failed: {error}"))?;
        let adapters = manager
            .adapters()
            .await
            .map_err(|error| format!("没有可用蓝牙适配器 / no bluetooth adapters: {error}"))?;
        let adapter = adapters
            .into_iter()
            .next()
            .ok_or_else(|| "没有可用的蓝牙适配器 / No Bluetooth adapter available".to_string())?;
        let mut inner = self.inner.lock().expect("card manager lock");
        inner.adapter = Some(adapter.clone());
        inner.bluetooth_error = None;
        Ok(adapter)
    }

    fn snapshot(&self) -> CardStateSnapshot {
        let inner = self.inner.lock().expect("card manager lock");
        let session = inner
            .session
            .as_ref()
            .map(|handle| handle.shared.lock().expect("session lock").clone());
        CardStateSnapshot {
            bluetooth_ready: inner.adapter.is_some(),
            bluetooth_error: inner.bluetooth_error.clone(),
            connected: session.as_ref().map(|session| session.connected).unwrap_or(false),
            scanning: inner.scanning,
            discovered: sorted_discovered(&inner.discovered),
            device: session.as_ref().map(|session| session.device.clone()).unwrap_or_default(),
            battery: session.as_ref().and_then(|session| session.battery),
            memory: session.as_ref().and_then(|session| session.memory.clone()),
            recording: session.as_ref().and_then(|session| session.recording.clone()),
            files: session.as_ref().map(|session| session.files.clone()).unwrap_or_default(),
            transfer: session.as_ref().and_then(|session| session.transfer.clone()),
            live_feed_enabled: LIVE_FEED.load(Ordering::Relaxed),
            manufacturer_code_set: !inner.settings.manufacturer_code.is_empty(),
            saved_device: inner.saved_device.clone(),
        }
    }

    fn emit(&self, payload: serde_json::Value) {
        emit_event(&self.app, payload);
    }
}

fn sorted_discovered(discovered: &HashMap<String, DiscoveredDevice>) -> Vec<DiscoveredDevice> {
    let mut devices: Vec<DiscoveredDevice> = discovered.values().cloned().collect();
    devices.sort_by(|left, right| {
        right
            .rssi
            .unwrap_or(i16::MIN)
            .cmp(&left.rssi.unwrap_or(i16::MIN))
    });
    devices
}

fn properties_to_device(
    id: &PeripheralId,
    properties: &btleplug::api::PeripheralProperties,
) -> Option<DiscoveredDevice> {
    for (_company, payload) in &properties.manufacturer_data {
        let facts = parse_advertisement(payload)?;
        let has_storage = facts.has_local_storage();
        let has_meeting_recording = facts.has_meeting_recording();
        return Some(DiscoveredDevice {
            id: format!("{id:?}"),
            name: properties
                .local_name
                .clone()
                .unwrap_or_else(|| facts.device_code.clone()),
            rssi: properties.rssi,
            device_code: facts.device_code,
            protocol_version: facts.protocol_version,
            sku: facts.sku,
            has_storage,
            has_meeting_recording,
        });
    }
    None
}

async fn open_session(
    app: &AppHandle,
    target: &DiscoveredDevice,
    settings: &CardSettings,
    peripheral: Peripheral,
) -> Result<SessionActorHandle, String> {
    peripheral
        .connect()
        .await
        .map_err(|error| format!("连接失败 / connect failed: {error}"))?;
    peripheral
        .discover_services()
        .await
        .map_err(|error| format!("service discovery failed: {error}"))?;

    if !peripheral.services().iter().any(|service| service.uuid == protocol::SERVICE_UUID) {
        return Err("设备缺少录音卡主服务 / device missing NewView primary service".to_owned());
    }

    let characteristics = peripheral.characteristics();
    let write_characteristic = characteristics
        .iter()
        .find(|characteristic| characteristic.uuid == protocol::WRITE_CHARACTERISTIC_UUID)
        .ok_or("设备缺少写特征 / device missing write characteristic")?
        .clone();
    let notify_characteristic = characteristics
        .iter()
        .find(|characteristic| characteristic.uuid == protocol::NOTIFY_CHARACTERISTIC_UUID)
        .ok_or("设备缺少通知特征 / device missing notify characteristic")?
        .clone();
    peripheral
        .subscribe(&notify_characteristic)
        .await
        .map_err(|error| format!("subscribe failed: {error}"))?;

    let facts = peripheral
        .properties()
        .await
        .ok()
        .flatten()
        .and_then(|properties| {
            properties
                .manufacturer_data
                .values()
                .find_map(|payload| parse_advertisement(payload))
        });
    let protocol_version = facts
        .as_ref()
        .map(|facts| facts.protocol_version)
        .unwrap_or(target.protocol_version);
    let device = CardDeviceInfo {
        id: target.id.clone(),
        name: target.name.clone(),
        mac: Some(target.id.clone()),
        protocol_version: Some(protocol_version),
        sku: facts.as_ref().and_then(|facts| facts.sku.clone()),
        software_version: None,
        hardware_version: None,
    };

    let shared = Arc::new(Mutex::new(SharedSession {
        connected: true,
        device: device.clone(),
        ..Default::default()
    }));
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let closed = Arc::new(AtomicBool::new(false));

    let core = ActorCore {
        app: app.clone(),
        peripheral,
        protocol_version,
        manufacturer_code: settings.manufacturer_code.clone(),
        shared: shared.clone(),
        closed: closed.clone(),
    };
    let handle = SessionActorHandle {
        commands: command_tx,
        shared,
        closed,
    };
    tokio::spawn(actor_run(core, command_rx, write_characteristic));
    Ok(handle)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

type CardManagerState<'a> = State<'a, RecordingCardManager>;

#[tauri::command]
pub async fn recording_card_state(manager: CardManagerState<'_>) -> CommandResult<CardStateSnapshot> {
    manager.load_settings();
    Ok(manager.snapshot())
}

#[tauri::command]
pub async fn recording_card_scan_start(manager: CardManagerState<'_>) -> CommandResult<()> {
    manager.load_settings();
    let adapter = manager.ensure_adapter().await?;
    {
        let mut inner = manager.inner.lock().expect("card manager lock");
        if inner.scanning {
            return Ok(());
        }
        inner.scanning = true;
        inner.discovered.clear();
        inner.discovered_ids.clear();
    }
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|error| format!("scan failed: {error}"))?;

    let scan_app = manager.app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let peripherals = {
                let manager = scan_app.state::<RecordingCardManager>();
                let keep_scanning = manager.inner.lock().expect("card manager lock").scanning;
                if !keep_scanning {
                    break;
                }
                let adapter = manager.inner.lock().expect("card manager lock").adapter.clone();
                match adapter {
                    Some(adapter) => adapter.peripherals().await.ok(),
                    None => None,
                }
            };
            let Some(peripherals) = peripherals else { continue };
            let manager = scan_app.state::<RecordingCardManager>();
            let mut found: Vec<(DiscoveredDevice, PeripheralId)> = Vec::new();
            for peripheral in peripherals {
                let id = peripheral.id();
                if let Ok(Some(properties)) = peripheral.properties().await {
                    if let Some(device) = properties_to_device(&id, &properties) {
                        found.push((device, id));
                    }
                }
            }
            let mut inner = manager.inner.lock().expect("card manager lock");
            for (device, id) in found {
                let key = device.id.clone();
                let is_new = !inner.discovered.contains_key(&key);
                inner.discovered.insert(key.clone(), device.clone());
                inner.discovered_ids.insert(key, id);
                if is_new {
                    emit_event(&scan_app, json!({ "type": "scan", "device": device }));
                }
            }
        }
    });
    manager.emit(json!({ "type": "scan-state", "scanning": true }));
    Ok(())
}

#[tauri::command]
pub async fn recording_card_scan_stop(manager: CardManagerState<'_>) -> CommandResult<()> {
    let adapter = {
        let mut inner = manager.inner.lock().expect("card manager lock");
        inner.scanning = false;
        inner.adapter.clone()
    };
    if let Some(adapter) = adapter {
        let _ = adapter.stop_scan().await;
    }
    manager.emit(json!({ "type": "scan-state", "scanning": false }));
    Ok(())
}

#[tauri::command]
pub async fn recording_card_set_manufacturer_code(
    manager: CardManagerState<'_>,
    code: String,
) -> CommandResult<()> {
    manager.load_settings();
    let mut inner = manager.inner.lock().expect("card manager lock");
    inner.settings.manufacturer_code = code.trim().to_owned();
    let settings = inner.settings.clone();
    drop(inner);
    manager.persist_settings(&settings);
    manager.emit(json!({ "type": "settings", "manufacturerCodeSet": !settings.manufacturer_code.is_empty() }));
    Ok(())
}

#[tauri::command]
pub async fn recording_card_set_live_feed(
    manager: CardManagerState<'_>,
    enabled: bool,
) -> CommandResult<()> {
    manager.load_settings();
    LIVE_FEED.store(enabled, Ordering::Relaxed);
    let mut inner = manager.inner.lock().expect("card manager lock");
    inner.settings.live_feed = enabled;
    let settings = inner.settings.clone();
    drop(inner);
    manager.persist_settings(&settings);
    manager.emit(json!({ "type": "settings", "liveFeed": enabled }));
    Ok(())
}

#[tauri::command]
pub async fn recording_card_connect(
    manager: CardManagerState<'_>,
    device: DiscoveredDevice,
) -> CommandResult<CardStateSnapshot> {
    manager.load_settings();
    let adapter = manager.ensure_adapter().await?;
    let peripheral_id = {
        let mut inner = manager.inner.lock().expect("card manager lock");
        if inner
            .session
            .as_ref()
            .map(|session| !session.closed.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            return Err("已连接设备，请先断开 / already connected".into());
        }
        inner.session = None;
        inner
            .discovered_ids
            .get(&device.id)
            .cloned()
            .ok_or("设备不在扫描结果中，请重新扫描 / device not in scan results")?
    };
    let peripheral = adapter
        .peripheral(&peripheral_id)
        .await
        .map_err(|error| format!("device lookup failed: {error}"))?;
    let settings = {
        manager.inner.lock().expect("card manager lock").settings.clone()
    };
    let handle = open_session(&manager.app, &device, &settings, peripheral).await?;
    {
        let mut inner = manager.inner.lock().expect("card manager lock");
        inner.session = Some(handle);
        inner.saved_device = Some(SavedDevice {
            id: device.id.clone(),
            name: device.name.clone(),
        });
    }
    manager.persist_device(&SavedDevice {
        id: device.id.clone(),
        name: device.name.clone(),
    });
    manager.emit(json!({ "type": "connected", "deviceId": device.id }));
    Ok(manager.snapshot())
}

#[tauri::command]
pub async fn recording_card_disconnect(manager: CardManagerState<'_>) -> CommandResult<()> {
    let handle = {
        let mut inner = manager.inner.lock().expect("card manager lock");
        inner.session.take()
    };
    // Dropping the sender ends the actor loop at its next poll; the platform
    // releases the BLE connection when the peripheral handle goes away.
    drop(handle);
    manager.emit(json!({ "type": "connection", "connected": false, "reason": "disconnected by user" }));
    Ok(())
}

fn session_handle(manager: &RecordingCardManager) -> Result<SessionActorHandle, String> {
    manager
        .inner
        .lock()
        .expect("card manager lock")
        .session
        .clone()
        .ok_or_else(|| "设备未连接 / device not connected".to_owned())
}

async fn send_request(
    handle: &SessionActorHandle,
    frame: Vec<u8>,
    expect: String,
) -> oneshot::Receiver<Result<protocol::ControlResponse, String>> {
    let (reply_tx, reply_rx) = oneshot::channel();
    let _ = handle.commands.send(ActorCommand::Request {
        frame,
        expect,
        reply: reply_tx,
    });
    reply_rx
}

#[tauri::command]
pub async fn recording_card_query(manager: CardManagerState<'_>, kind: String) -> CommandResult<()> {
    let frame = match kind.as_str() {
        "battery" => protocol::control_frame("battery"),
        "version" => protocol::control_frame("version"),
        "memory" => protocol::control_frame("memory"),
        _ => return Err(format!("unknown query kind: {kind}")),
    };
    let handle = session_handle(&manager)?;
    let reply = send_request(&handle, frame, kind.clone()).await;
    let response = timeout(COMMAND_TIMEOUT, reply)
        .await
        .map_err(|_| format!("{kind} timed out"))?
        .map_err(|_| format!("{kind} interrupted"))??;
    let apply = match kind.as_str() {
        "battery" => Apply::Battery,
        "version" => Apply::Version,
        _ => Apply::Memory,
    };
    apply_to_shared(&handle.shared, &response, &apply);
    Ok(())
}

#[tauri::command]
pub async fn recording_card_record(
    manager: CardManagerState<'_>,
    action: String,
    mode: Option<String>,
) -> CommandResult<()> {
    let handle = session_handle(&manager)?;
    let record_mode = mode.as_deref().map(|mode| match mode {
        "call" => RecordMode::Call,
        "media" => RecordMode::Media,
        _ => RecordMode::Meeting,
    });
    enum Reply {
        Record(oneshot::Receiver<Result<protocol::RecordStateUpdate, String>>),
        Unit(oneshot::Receiver<Result<(), String>>),
    }
    let reply = match action.as_str() {
        "start" => {
            let (reply_tx, reply_rx) = oneshot::channel();
            let _ = handle.commands.send(ActorCommand::StartRecord {
                mode: record_mode.unwrap_or(RecordMode::Meeting),
                reply: reply_tx,
            });
            Reply::Record(reply_rx)
        }
        "stop" => {
            let (reply_tx, reply_rx) = oneshot::channel();
            let _ = handle.commands.send(ActorCommand::StopRecord { reply: reply_tx });
            Reply::Record(reply_rx)
        }
        "pause" | "resume" => {
            let (reply_tx, reply_rx) = oneshot::channel();
            let _ = handle.commands.send(ActorCommand::PauseResume {
                pause: action == "pause",
                reply: reply_tx,
            });
            Reply::Record(reply_rx)
        }
        "mark" => {
            let (reply_tx, reply_rx) = oneshot::channel();
            let _ = handle.commands.send(ActorCommand::RecordMark { reply: reply_tx });
            Reply::Unit(reply_rx)
        }
        _ => return Err(format!("unknown record action: {action}")),
    };
    let result = match reply {
        Reply::Record(reply_rx) => timeout(COMMAND_TIMEOUT + Duration::from_secs(2), reply_rx)
            .await
            .map(|inner| inner.map(|result| result.map(|_update| ()))),
        Reply::Unit(reply_rx) => timeout(COMMAND_TIMEOUT + Duration::from_secs(2), reply_rx).await,
    };
    match result {
        Ok(Ok(result)) => {
            result?;
            Ok(())
        }
        Ok(Err(_)) => Err("请求被中断 / request interrupted".to_owned()),
        Err(_) => Err("设备未响应 / device did not respond".to_owned()),
    }
}

#[tauri::command]
pub async fn recording_card_list_files(
    manager: CardManagerState<'_>,
) -> CommandResult<Vec<transfer::CardFile>> {
    let handle = session_handle(&manager)?;
    let (reply_tx, reply_rx) = oneshot::channel();
    handle
        .commands
        .send(ActorCommand::FileList { reply: reply_tx })
        .map_err(|_| "session closed".to_string())?;
    timeout(FILE_LIST_TIMEOUT + Duration::from_secs(4), reply_rx)
        .await
        .map_err(|_| "file list timed out".to_string())?
        .map_err(|_| "file list interrupted".to_string())?
}

#[tauri::command]
pub async fn recording_card_download(
    manager: CardManagerState<'_>,
    sn: i64,
    name: String,
    size: i64,
    frame_bytes: i64,
    auto_delete: bool,
) -> CommandResult<()> {
    let handle = session_handle(&manager)?;
    let (reply_tx, reply_rx) = oneshot::channel();
    handle
        .commands
        .send(ActorCommand::StartTransfer {
            file: transfer::CardFile {
                sn,
                name,
                size,
                scene: 0,
                start_timestamp: None,
                end_timestamp: None,
                crc: None,
                frame_bytes,
            },
            auto_delete,
            reply: reply_tx,
        })
        .map_err(|_| "session closed".to_string())?;
    timeout(Duration::from_secs(5), reply_rx)
        .await
        .map_err(|_| "transfer start timed out".to_string())?
        .map_err(|_| "transfer start interrupted".to_string())?
}

#[tauri::command]
pub async fn recording_card_cancel_download(manager: CardManagerState<'_>) -> CommandResult<()> {
    let handle = session_handle(&manager)?;
    let (reply_tx, reply_rx) = oneshot::channel();
    handle
        .commands
        .send(ActorCommand::CancelTransfer { reply: reply_tx })
        .map_err(|_| "session closed".to_string())?;
    timeout(Duration::from_secs(5), reply_rx)
        .await
        .map_err(|_| "cancel timed out".to_string())?
        .map_err(|_| "cancel interrupted".to_string())?
}

#[tauri::command]
pub async fn recording_card_delete_file(
    manager: CardManagerState<'_>,
    sn: i64,
    name: String,
) -> CommandResult<()> {
    let handle = session_handle(&manager)?;
    let reply = send_request(&handle, transfer::delete_file_frame(sn, &name), "delfile".to_owned()).await;
    let response = timeout(DELETE_TIMEOUT, reply)
        .await
        .map_err(|_| "delete timed out (device busy?)".to_string())?
        .map_err(|_| "delete interrupted".to_string())??;
    transfer::parse_delete_response(&response)?;
    handle
        .shared
        .lock()
        .expect("session lock")
        .files
        .retain(|file| !(file.sn == sn && file.name == name));
    Ok(())
}

/// Decode a previously transferred Opus artifact to WAV (used by the
/// import-to-transcription flow when the WAV was regenerated or deleted).
#[tauri::command]
pub async fn recording_card_transcribe_source(
    app: AppHandle,
    name: String,
    sn: i64,
    frame_bytes: i64,
) -> CommandResult<String> {
    let base = card_recordings_dir(&app)?;
    let opus_path = base.join(format!("{name}-{sn}.opus"));
    let bytes = std::fs::read(&opus_path).map_err(|error| format!("read opus: {error}"))?;
    let format = OpusFormat {
        sample_rate_hz: decode::OUTPUT_SAMPLE_RATE as i64,
        channels: 2,
        frame_bytes: frame_bytes.max(1),
    };
    let mut decoder = CardOpusDecoder::new(format).map_err(|error| format!("decoder init: {error}"))?;
    let mut mono = decoder.push(&bytes);
    mono.extend(decoder.push(&[]));
    let wav_path = base.join(format!("{name}-{sn}.wav"));
    decode::write_wav(&wav_path, &mono).map_err(|error| format!("write wav: {error}"))?;
    Ok(wav_path.to_string_lossy().into_owned())
}

/// Watcher started at setup: reconnects to the saved device when the session
/// dies, by scanning for a device with the same local name.
pub fn spawn_reconnect_watcher(app: AppHandle) {
    // Setup runs on the main thread outside any Tokio context, where a bare
    // `tokio::spawn` panics ("no reactor running"). Tauri's wrapper targets
    // its own managed runtime and works from any thread.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let attempt = {
                let manager = app.state::<RecordingCardManager>();
                manager.load_settings();
                let targets = {
                    let mut inner = manager.inner.lock().expect("card manager lock");
                    let dead = inner
                        .session
                        .as_ref()
                        .map(|session| session.closed.load(Ordering::SeqCst))
                        .unwrap_or(true);
                    if dead && inner.session.is_some() {
                        inner.session = None;
                        emit_event(&app, json!({ "type": "connection", "connected": false, "reason": "device disconnected" }));
                    }
                    if inner.session.is_none()
                        && inner.settings.auto_reconnect
                        && !inner.settings.manufacturer_code.is_empty()
                        && inner.saved_device.is_some()
                    {
                        Some((inner.saved_device.clone().expect("checked"), inner.settings.clone()))
                    } else {
                        None
                    }
                };
                targets.map(|(saved, settings)| {
                    let watcher_app = app.clone();
                    Box::pin(async move {
                        let manager = watcher_app.state::<RecordingCardManager>();
                        let adapter = manager.ensure_adapter().await?;
                        reconnect_once(&watcher_app, &adapter, &saved, &settings).await
                    }) as std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>
                })
            };
            if let Some(attempt) = attempt {
                if attempt.await.is_ok() {
                    break;
                }
            }
        }
    });
}

async fn reconnect_once(
    app: &AppHandle,
    adapter: &Adapter,
    saved: &SavedDevice,
    settings: &CardSettings,
) -> Result<(), String> {
    // Short scan, then match the saved device by advertised local name.
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|error| format!("scan failed: {error}"))?;
    let mut found: Option<Peripheral> = None;
    for _ in 0..RECONNECT_SCAN_ROUNDS {
        tokio::time::sleep(Duration::from_millis(600)).await;
        if let Ok(peripherals) = adapter.peripherals().await {
            for peripheral in peripherals {
                if let Ok(Some(properties)) = peripheral.properties().await {
                    if properties.local_name.as_deref() == Some(saved.name.as_str())
                        && properties.manufacturer_data.keys().next().is_some()
                    {
                        found = Some(peripheral);
                        break;
                    }
                }
            }
        }
        if found.is_some() {
            break;
        }
    }
    let _ = adapter.stop_scan().await;
    let peripheral = found.ok_or("device not in range")?;
    let target = DiscoveredDevice {
        id: format!("{:?}", peripheral.id()),
        name: saved.name.clone(),
        rssi: None,
        device_code: String::new(),
        protocol_version: 24,
        sku: None,
        has_storage: true,
        has_meeting_recording: true,
    };
    let handle = open_session(app, &target, settings, peripheral).await?;
    let manager = app.state::<RecordingCardManager>();
    manager.inner.lock().expect("card manager lock").session = Some(handle);
    Ok(())
}
