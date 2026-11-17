//! Recording-card USB session manager.
//!
//! Owns the opened `CardDevice` behind a mutex, serializes operations, and
//! performs downloads straight to disk with bounded memory. The pairing
//! password is passed in per-connect from the authenticated web session
//! (packages/views/recording-card/credentials.ts) and is never logged or
//! persisted.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use super::audio::{recording_card_title, suggested_download_name, CardOpusDecoder, WavWriter};
use super::device::{find_device, CardDevice, DeviceError};
use super::protocol::{
    delete_file_frame, end_file_list_frame, factory_reset_frame, file_cancel_frame,
    file_download_frame, file_list_packet_frame, format_storage_frame, frame_prefix,
    get_auto_off_frame, get_file_list_frame, get_identity_frame, get_mic_gain_frame,
    get_storage_frame, is_delete_accepted, is_storage_placeholder, parse_action_result,
    parse_auto_off, parse_file_list_json, parse_identity, parse_mic_gain, parse_storage,
    set_auto_off_frame, set_bound_frame, set_mic_gain_frame, set_time_frame,
    start_file_list_frame, unbind_frame, validate_response, CardFile, MicGain, StorageInfo,
};

pub const DEFAULT_VENDOR_ID: u16 = super::device::DEFAULT_VENDOR_ID;
pub const DEFAULT_PRODUCT_ID: u16 = super::device::DEFAULT_PRODUCT_ID;

const LIST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_FRAME_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_LIST_PACKETS: usize = 4096;
const MAX_LIST_BYTES: usize = 64 * 1024 * 1024;
const MAX_DOWNLOAD_PACKETS: u64 = 1_000_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SessionEvent {
    #[serde(rename_all = "camelCase")]
    DownloadProgress {
        file_name: String,
        loaded: u64,
        total: u64,
    },
    #[serde(rename_all = "camelCase")]
    DeviceDisconnected { reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub vendor_id: u16,
    pub product_id: u16,
    pub device_sn: Option<String>,
    pub storage: Option<StorageInfo>,
    /// Whether the best-effort RTC sync during connect was acknowledged.
    pub clock_synced: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("{0}")]
    Device(#[from] DeviceError),
    #[error("not connected")]
    NotConnected,
    #[error("a transfer is already in progress")]
    Busy,
    #[error("I/O error: {0}")]
    Io(String),
    #[error("protocol error: {0}")]
    Protocol(String),
}

impl Serialize for SessionError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Progress payload sent through a Tauri Channel during a download.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub file_name: String,
    pub loaded: u64,
    pub total: u64,
}

pub struct RecordingCardSession {
    device: Mutex<Option<Arc<CardDevice>>>,
    /// Serializes whole USB command sequences. The vendor SDK uses an
    /// `exclusive(fn)` queue for the same reason: frames from two concurrent
    /// commands would otherwise be mixed in one bulk stream / pending buffer.
    io: Mutex<()>,
    transferring: Mutex<bool>,
}

impl RecordingCardSession {
    pub fn new() -> Self {
        Self {
            device: Mutex::new(None),
            io: Mutex::new(()),
            transferring: Mutex::new(false),
        }
    }

    pub async fn connect(
        &self,
        password: &str,
        vendor_id: u16,
        product_id: u16,
    ) -> Result<ConnectResult, SessionError> {
        // Replace any existing session (a reconnect after unplug).
        self.disconnect().await;
        // Wait for any in-flight command on the old device before opening a
        // new one, then keep the lock for the whole handshake/preload.
        let _io_guard = self.io.lock().await;

        let info = find_device(vendor_id, product_id).await?;
        let device = CardDevice::open_and_authenticate(&info, password).await?;
        let device = Arc::new(device);

        // Best-effort clock sync (Unix seconds) and storage preload. The sync
        // result is reported to the UI instead of being silently discarded.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let clock_synced = match device
            .exchange("rtc", &set_time_frame(frame_prefix(), now))
            .await
        {
            Ok(response) => match validate_response(&response)
                .map_err(SessionError::Protocol)
                .and_then(|_| parse_action_result(&response).map_err(SessionError::Protocol))
            {
                Ok(()) => true,
                Err(error) => {
                    log::warn!("[recording-card] rtc sync rejected: {error}");
                    false
                }
            },
            Err(error) => {
                log::warn!("[recording-card] rtc sync failed: {error}");
                false
            }
        };

        let storage = match self.query_storage(&device).await {
            Ok(storage) => Some(storage),
            Err(error) => {
                log::warn!("[recording-card] storage query failed: {error}");
                None
            }
        };
        let device_sn = self.query_identity(&device).await;
        *self.device.lock().await = Some(device);
        Ok(ConnectResult {
            vendor_id,
            product_id,
            device_sn,
            storage,
            clock_synced,
        })
    }

    /// Read the card serial via the `authsn` command; None when the device
    /// does not answer (display falls back to the USB descriptor).
    async fn query_identity(&self, device: &CardDevice) -> Option<String> {
        let response = match device
            .exchange("authsn", &get_identity_frame(frame_prefix()))
            .await
        {
            Ok(response) => response,
            Err(error) => {
                log::warn!("[recording-card] identity query failed: {error}");
                return None;
            }
        };
        match parse_identity(&response) {
            Ok(sn) => Some(sn),
            Err(error) => {
                log::warn!(
                    "[recording-card] identity parse failed: {error}; fields={:?}",
                    response.fields
                );
                None
            }
        }
    }

    async fn query_storage(&self, device: &CardDevice) -> Result<StorageInfo, SessionError> {
        // The device first answers a placeholder (0,0) then reports the real
        // capacity; retry briefly until it does.
        for _ in 0..8 {
            let response = match device
                .exchange("mem", &get_storage_frame(frame_prefix()))
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    log::warn!("[recording-card] storage exchange failed: {error}");
                    return Err(SessionError::Device(error));
                }
            };
            validate_response(&response).map_err(SessionError::Protocol)?;
            if !is_storage_placeholder(&response) {
                return parse_storage(&response).map_err(SessionError::Protocol);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(SessionError::Protocol(
            "storage capacity did not arrive".to_string(),
        ))
    }

    pub async fn disconnect(&self) {
        let device = self.device.lock().await.take();
        drop(device); // dropping the last Arc releases the USB interface
        *self.transferring.lock().await = false;
    }

    pub async fn is_connected(&self) -> bool {
        self.device
            .lock()
            .await
            .as_ref()
            .map(|device| device.is_authenticated())
            .unwrap_or(false)
    }

    pub async fn list_files(&self) -> Result<Vec<CardFile>, SessionError> {
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let request_prefix = frame_prefix();
        let result = self.read_file_list(&device, request_prefix).await;
        // Always close the list transfer, including on a parse error.
        if let Err(error) = device
            .write_frame(&end_file_list_frame(request_prefix))
            .await
        {
            log::warn!("[recording-card] list close frame failed: {error}");
        }
        result
    }

    /// SDK `getFileList()` sequence: getlist status -> flist header ->
    /// listreq JSON packets -> listreq close.
    async fn read_file_list(
        &self,
        device: &CardDevice,
        request_prefix: &str,
    ) -> Result<Vec<CardFile>, SessionError> {
        let getlist = device
            .exchange("getlist", &get_file_list_frame(request_prefix))
            .await?;
        validate_response(&getlist).map_err(SessionError::Protocol)?;
        if getlist.fields.first().map(String::as_str) != Some("0") {
            return Err(SessionError::Protocol(format!(
                "device refused file list: {:?}",
                getlist.fields
            )));
        }
        log::info!("[recording-card] getlist accepted: {:?}", getlist.fields);

        let flist = device
            .read_text_frame("flist", 2, LIST_FRAME_TIMEOUT)
            .await?;
        validate_response(&flist).map_err(SessionError::Protocol)?;
        let total_bytes: usize = flist
            .fields
            .first()
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| {
                SessionError::Protocol(format!("invalid flist byte count: {:?}", flist.fields))
            })?;
        let packet_count: usize = flist
            .fields
            .get(1)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| {
                SessionError::Protocol(format!("invalid flist packet count: {:?}", flist.fields))
            })?;
        if total_bytes > MAX_LIST_BYTES || packet_count > MAX_LIST_PACKETS {
            return Err(SessionError::Protocol(format!(
                "file list too large: {total_bytes} bytes / {packet_count} packets"
            )));
        }
        log::info!(
            "[recording-card] flist header: total_bytes={} packet_count={}",
            total_bytes,
            packet_count
        );

        device
            .write_frame(&start_file_list_frame(request_prefix))
            .await?;

        let mut payload = Vec::with_capacity(total_bytes);
        for index in 1..=packet_count {
            device
                .write_frame(&file_list_packet_frame(request_prefix, index as u64))
                .await?;
            let frame = device
                .read_payload_frame("listreq", 3, LIST_FRAME_TIMEOUT)
                .await?;
            let expected_index = index.to_string();
            if frame.parts.get(2).map(String::as_str) != Some(expected_index.as_str()) {
                return Err(SessionError::Protocol(format!(
                    "listreq packet index mismatch: want {expected_index}, got {:?}",
                    frame.parts
                )));
            }
            let declared_len: usize = frame
                .parts
                .get(3)
                .and_then(|value| value.parse().ok())
                .ok_or_else(|| {
                    SessionError::Protocol(format!("invalid listreq length: {:?}", frame.parts))
                })?;
            if declared_len != frame.payload.len() {
                return Err(SessionError::Protocol(format!(
                    "listreq short: declared {declared_len}, got {}",
                    frame.payload.len()
                )));
            }
            log::info!(
                "[recording-card] list packet {}/{}: {} bytes",
                index,
                packet_count,
                frame.payload.len()
            );
            payload.extend_from_slice(&frame.payload);
        }

        if payload.len() != total_bytes {
            return Err(SessionError::Protocol(format!(
                "file list length mismatch: expected {total_bytes}, got {}",
                payload.len()
            )));
        }
        let files = parse_file_list_json(&payload).map_err(SessionError::Protocol)?;
        log::info!(
            "[recording-card] file list ok: {} files, {} bytes",
            files.len(),
            payload.len()
        );
        Ok(files)
    }

    pub async fn storage(&self) -> Result<StorageInfo, SessionError> {
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        self.query_storage(&device).await
    }

    async fn current_device(&self) -> Result<Arc<CardDevice>, SessionError> {
        self.device
            .lock()
            .await
            .clone()
            .ok_or(SessionError::NotConnected)
    }

    async fn ensure_not_transferring(&self) -> Result<(), SessionError> {
        if *self.transferring.lock().await {
            Err(SessionError::Busy)
        } else {
            Ok(())
        }
    }

    pub async fn delete_file(&self, name: &str) -> Result<(), SessionError> {
        if *self.transferring.lock().await {
            return Err(SessionError::Busy);
        }
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let response = device
            .exchange("delfile", &delete_file_frame(frame_prefix(), name))
            .await?;
        if !is_delete_accepted(&response) {
            return Err(SessionError::Protocol(format!(
                "device rejected deleting {name}: {:?}",
                response.fields
            )));
        }
        Ok(())
    }

    pub async fn auto_off(&self) -> Result<u64, SessionError> {
        self.ensure_not_transferring().await?;
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let response = device
            .exchange("cofftime", &get_auto_off_frame(frame_prefix()))
            .await?;
        parse_auto_off(&response).map_err(SessionError::Protocol)
    }

    pub async fn set_auto_off(&self, minutes: u64) -> Result<(), SessionError> {
        if !(1..=36_000).contains(&minutes) {
            return Err(SessionError::Protocol(
                "auto-off minutes must be between 1 and 36000".to_string(),
            ));
        }
        self.ensure_not_transferring().await?;
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let response = device
            .exchange("offtime", &set_auto_off_frame(frame_prefix(), minutes))
            .await?;
        parse_auto_off(&response).map(|_| ()).map_err(SessionError::Protocol)
    }

    pub async fn mic_gain(&self, mode: u64) -> Result<MicGain, SessionError> {
        if mode > 1 {
            return Err(SessionError::Protocol("mic mode must be 0 or 1".to_string()));
        }
        self.ensure_not_transferring().await?;
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let response = device
            .exchange("cmicgain", &get_mic_gain_frame(frame_prefix(), mode))
            .await?;
        parse_mic_gain(&response).map_err(SessionError::Protocol)
    }

    pub async fn set_mic_gain(
        &self,
        mode: u64,
        mic1: u64,
        mic2: u64,
    ) -> Result<MicGain, SessionError> {
        if mode > 1 || mic1 > 19 || mic2 > 19 {
            return Err(SessionError::Protocol(
                "mic mode must be 0/1 and gains 0-19".to_string(),
            ));
        }
        self.ensure_not_transferring().await?;
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let response = device
            .exchange(
                "micgain",
                &set_mic_gain_frame(frame_prefix(), mode, mic1, mic2),
            )
            .await?;
        parse_mic_gain(&response).map_err(SessionError::Protocol)
    }

    pub async fn set_bound(&self, bound: bool) -> Result<(), SessionError> {
        self.ensure_not_transferring().await?;
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let response = device
            .exchange("bound", &set_bound_frame(frame_prefix(), bound))
            .await?;
        parse_action_result(&response).map_err(SessionError::Protocol)
    }

    pub async fn unbind(&self, format: bool) -> Result<(), SessionError> {
        self.ensure_not_transferring().await?;
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let response = device
            .exchange("unbound", &unbind_frame(frame_prefix(), format))
            .await?;
        parse_action_result(&response).map_err(SessionError::Protocol)
    }

    pub async fn factory_reset(&self) -> Result<(), SessionError> {
        self.ensure_not_transferring().await?;
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        let response = device
            .exchange("default", &factory_reset_frame(frame_prefix()))
            .await?;
        parse_action_result(&response).map_err(SessionError::Protocol)
    }

    pub async fn format_storage(&self) -> Result<(), SessionError> {
        self.ensure_not_transferring().await?;
        let _io_guard = self.io.lock().await;
        let device = self.current_device().await?;
        device
            .write_frame(&format_storage_frame(frame_prefix()))
            .await?;
        let response = device
            .read_text_frame("fmtret", 1, Duration::from_secs(15))
            .await?;
        parse_action_result(&response).map_err(SessionError::Protocol)
    }

    /// Download a file straight to `dest`, streaming bulk frames to disk.
    /// Progress is reported through `on_progress`; a download is serialized
    /// and rejects concurrent attempts.
    pub async fn download_file(
        &self,
        file: &CardFile,
        dest: &PathBuf,
        on_progress: Channel<DownloadProgress>,
    ) -> Result<PathBuf, SessionError> {
        {
            let mut transferring = self.transferring.lock().await;
            if *transferring {
                return Err(SessionError::Busy);
            }
            *transferring = true;
        }
        // Hold the command lock across the whole transfer so list/storage/
        // delete cannot interleave frames. Cancellation deliberately does not
        // take this lock: it only needs the bulk OUT endpoint to send stop.
        let _io_guard = self.io.lock().await;
        let result = self.download_inner(file, dest, &on_progress).await;
        *self.transferring.lock().await = false;
        result
    }

    async fn download_inner(
        &self,
        file: &CardFile,
        dest: &PathBuf,
        on_progress: &Channel<DownloadProgress>,
    ) -> Result<PathBuf, SessionError> {
        let device = self.current_device().await?;
        let request_prefix = frame_prefix();
        // USB firmware uses `filect`, not the old BLE `filecmd` layout.
        let request = file_download_frame(request_prefix, file.sn, 0);
        device.write_frame(&request).await?;

        let mut decoder = CardOpusDecoder::new(file.frame_size)
            .map_err(|error| SessionError::Protocol(format!("opus decoder init: {error}")))?;
        let mut writer = WavWriter::create(dest)
            .await
            .map_err(SessionError::Io)?;

        // Patch the WAV header even when the transfer fails, so a partial
        // download is still a valid (short) WAV file.
        let transfer = async {
            let mut packets: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
            let mut total_packets: Option<u64> = None;
            let mut received: u64 = 0;

            // SDK `readFile()` collects 1-based `filect` packets into a map and
            // stops when every packet 1..=total has arrived, so out-of-order
            // packets are normal and must not be treated as a protocol error.
            while total_packets.map_or(true, |total| {
                (1..=total).any(|index| !packets.contains_key(&index))
            }) {
                let frame = device
                    .read_payload_frame("filect", 5, DOWNLOAD_FRAME_TIMEOUT)
                    .await?;
                if payload_u64(&frame.parts, 2, "download sn")? != file.sn {
                    continue;
                }
                let total = payload_u64(&frame.parts, 3, "download packet count")?;
                if total == 0 || total > MAX_DOWNLOAD_PACKETS {
                    return Err(SessionError::Protocol(format!(
                        "invalid download packet count: {total}"
                    )));
                }
                if let Some(previous) = total_packets {
                    if previous != total {
                        return Err(SessionError::Protocol(format!(
                            "download packet count changed: {previous} -> {total}"
                        )));
                    }
                }
                let index = payload_u64(&frame.parts, 4, "download packet index")?;
                if index == 0 || index > total {
                    return Err(SessionError::Protocol(format!(
                        "download packet index out of range: {index}/{total}"
                    )));
                }
                let declared_len = payload_u64(&frame.parts, 5, "download packet length")? as usize;
                if declared_len != frame.payload.len() {
                    return Err(SessionError::Protocol(format!(
                        "download packet short: declared {declared_len}, got {}",
                        frame.payload.len()
                    )));
                }
                received += frame.payload.len() as u64;
                packets.insert(index, frame.payload);
                total_packets = Some(total);
                let _ = on_progress.send(DownloadProgress {
                    file_name: recording_card_title(&file.name, file.start_time),
                    loaded: received.min(file.size),
                    total: file.size,
                });
            }

            let total = total_packets.unwrap_or(0);
            let mut written = 0u64;
            for index in 1..=total {
                let bytes = packets.remove(&index).ok_or_else(|| {
                    SessionError::Protocol(format!("missing download packet {index}/{total}"))
                })?;
                written += bytes.len() as u64;
                let samples = decoder.push(&bytes);
                writer
                    .write_samples(&samples)
                    .await
                    .map_err(SessionError::Io)?;
            }
            if written != file.size {
                return Err(SessionError::Protocol(format!(
                    "download incomplete: got {written} of {} bytes",
                    file.size
                )));
            }
            Ok::<(), SessionError>(())
        }
        .await;

        let finalize = writer.finish().await.map_err(SessionError::Io);
        transfer?;
        finalize?;
        Ok(dest.clone())
    }

    pub async fn cancel_transfer(&self) {
        if let Some(device) = self.device.lock().await.as_ref() {
            // SDK cancelTransfer() sends exactly `*APP#filecmd#0#`.
            let frame = file_cancel_frame(frame_prefix());
            let _ = device.write_frame(&frame).await;
        }
        *self.transferring.lock().await = false;
    }
}

fn payload_u64(parts: &[String], index: usize, name: &str) -> Result<u64, SessionError> {
    parts
        .get(index)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| SessionError::Protocol(format!("invalid {name}: {parts:?}")))
}

// ── Tauri commands ────────────────────────────────────────────────

/// Connect to the recording card. `password` comes from the authenticated
/// web session and is never logged or persisted.
#[tauri::command(async)]
pub async fn recording_card_usb_connect(
    state: tauri::State<'_, RecordingCardSession>,
    password: String,
    vendor_id: Option<u16>,
    product_id: Option<u16>,
) -> Result<ConnectResult, String> {
    state
        .connect(
            &password,
            vendor_id.unwrap_or(DEFAULT_VENDOR_ID),
            product_id.unwrap_or(DEFAULT_PRODUCT_ID),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_disconnect(
    state: tauri::State<'_, RecordingCardSession>,
) -> Result<(), String> {
    state.disconnect().await;
    Ok(())
}

#[tauri::command(async)]
pub async fn recording_card_usb_state(
    state: tauri::State<'_, RecordingCardSession>,
) -> Result<bool, String> {
    Ok(state.is_connected().await)
}

#[tauri::command(async)]
pub async fn recording_card_usb_list_files(
    state: tauri::State<'_, RecordingCardSession>,
) -> Result<Vec<CardFile>, String> {
    state.list_files().await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_storage(
    state: tauri::State<'_, RecordingCardSession>,
) -> Result<StorageInfo, String> {
    state.storage().await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_delete_file(
    state: tauri::State<'_, RecordingCardSession>,
    name: String,
) -> Result<(), String> {
    state.delete_file(&name).await.map_err(|e| e.to_string())
}

/// Download a recording straight to a caller-chosen local path. Progress is
/// streamed back through a Tauri Channel, so memory stays bounded.
#[tauri::command(async)]
pub async fn recording_card_usb_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecordingCardSession>,
    file: CardFile,
    on_progress: Channel<DownloadProgress>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // Native save dialog: no path is passed from the webview, so nothing
    // about the user's filesystem leaks into the frontend. The card holds raw
    // Opus packets, so the saved artifact is a decoded WAV.
    let destination = app
        .dialog()
        .file()
        .set_file_name(&suggested_download_name(&file.name, file.start_time, "wav"))
        .blocking_save_file();
    let Some(destination) = destination else {
        return Ok(None); // user canceled
    };
    let dest: PathBuf = destination.into_path().map_err(|e| e.to_string())?;
    let result = state
        .download_file(&file, &dest, on_progress)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(result.to_string_lossy().to_string()))
}

#[tauri::command(async)]
pub async fn recording_card_usb_cancel_download(
    state: tauri::State<'_, RecordingCardSession>,
) -> Result<(), String> {
    state.cancel_transfer().await;
    Ok(())
}

#[tauri::command(async)]
pub async fn recording_card_usb_get_auto_off(
    state: tauri::State<'_, RecordingCardSession>,
) -> Result<u64, String> {
    state.auto_off().await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_set_auto_off(
    state: tauri::State<'_, RecordingCardSession>,
    minutes: u64,
) -> Result<(), String> {
    state.set_auto_off(minutes).await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_get_mic_gain(
    state: tauri::State<'_, RecordingCardSession>,
    mode: u64,
) -> Result<MicGain, String> {
    state.mic_gain(mode).await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_set_mic_gain(
    state: tauri::State<'_, RecordingCardSession>,
    mode: u64,
    mic1: u64,
    mic2: u64,
) -> Result<MicGain, String> {
    state
        .set_mic_gain(mode, mic1, mic2)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_set_bound(
    state: tauri::State<'_, RecordingCardSession>,
    bound: bool,
) -> Result<(), String> {
    state.set_bound(bound).await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_unbind(
    state: tauri::State<'_, RecordingCardSession>,
    format: bool,
) -> Result<(), String> {
    state.unbind(format).await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_factory_reset(
    state: tauri::State<'_, RecordingCardSession>,
) -> Result<(), String> {
    state.factory_reset().await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn recording_card_usb_format_storage(
    state: tauri::State<'_, RecordingCardSession>,
) -> Result<(), String> {
    state.format_storage().await.map_err(|e| e.to_string())
}
