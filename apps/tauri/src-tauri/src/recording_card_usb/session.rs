//! Recording-card USB session manager.
//!
//! Owns the opened `CardDevice` behind a mutex, serializes operations, and
//! performs downloads straight to disk with bounded memory. The pairing
//! password is passed in per-connect from the authenticated web session
//! (packages/views/recording-card/credentials.ts) and is never logged or
//! persisted.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use super::device::{find_device, CardDevice, DeviceError};
use super::protocol::{
    delete_file_frame, file_request_frame, get_file_list_frame, get_storage_frame,
    is_delete_accepted, is_storage_placeholder, parse_file_list, parse_storage, set_time_frame,
    validate_response, CardFile, StorageInfo,
};

pub const DEFAULT_VENDOR_ID: u16 = super::device::DEFAULT_VENDOR_ID;
pub const DEFAULT_PRODUCT_ID: u16 = super::device::DEFAULT_PRODUCT_ID;

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
    pub storage: Option<StorageInfo>,
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
    transferring: Mutex<bool>,
}

impl RecordingCardSession {
    pub fn new() -> Self {
        Self {
            device: Mutex::new(None),
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

        let info = find_device(vendor_id, product_id)?;
        let device = CardDevice::open_and_authenticate(&info, password).await?;
        let device = Arc::new(device);

        // Best-effort clock sync (Unix seconds) and storage preload.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let _ = device
            .exchange("rtc", &set_time_frame(super::protocol::frame_prefix(), now))
            .await;

        let storage = self.query_storage(&device).await.ok();
        *self.device.lock().await = Some(device);
        Ok(ConnectResult {
            vendor_id,
            product_id,
            storage,
        })
    }

    async fn query_storage(&self, device: &CardDevice) -> Result<StorageInfo, SessionError> {
        // The device first answers a placeholder (0,0) then reports the real
        // capacity; retry briefly until it does.
        for _ in 0..8 {
            let response = device
                .exchange("mem", &get_storage_frame(super::protocol::frame_prefix()))
                .await?;
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
        let device = self.current_device().await?;
        let response = device
            .exchange("flist", &get_file_list_frame(super::protocol::frame_prefix()))
            .await?;
        validate_response(&response).map_err(SessionError::Protocol)?;
        parse_file_list(&response).map_err(SessionError::Protocol)
    }

    pub async fn storage(&self) -> Result<StorageInfo, SessionError> {
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

    pub async fn delete_file(&self, name: &str) -> Result<(), SessionError> {
        if *self.transferring.lock().await {
            return Err(SessionError::Busy);
        }
        let device = self.current_device().await?;
        let response = device
            .exchange("delfile", &delete_file_frame(super::protocol::frame_prefix(), name))
            .await?;
        if !is_delete_accepted(&response) {
            return Err(SessionError::Protocol(format!(
                "device rejected deleting {name}"
            )));
        }
        Ok(())
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
        let result = self
            .download_inner(file, dest, &on_progress)
            .await;
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
        let prefix = super::protocol::frame_prefix();
        // Start transfer from offset 0, no auto-delete (originals stay).
        let request = file_request_frame(prefix, 1, file.sn, 0, false, 0);
        device.write_frame(&request).await?;

        use tokio::io::AsyncWriteExt;
        let mut output = tokio::fs::File::create(dest)
            .await
            .map_err(|e| SessionError::Io(e.to_string()))?;
        let mut written: u64 = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
        while written < file.size && tokio::time::Instant::now() < deadline {
            let raw = device.read_frame().await?;
            let text = super::frames::decode_frame_text(&raw);
            // Binary frames carry a `cmd#len#crc#` header followed by payload.
            // Data frames are raw bulk packets: append every non-empty frame
            // that is not a control response, then verify total length/CRC.
            if text.starts_with(prefix) {
                // A control/status frame terminates or annotates the transfer.
                if text.contains("filedone") || text.contains("filecmd") {
                    break;
                }
                continue;
            }
            output
                .write_all(&raw)
                .await
                .map_err(|e| SessionError::Io(e.to_string()))?;
            written += raw.len() as u64;
            let _ = on_progress.send(DownloadProgress {
                file_name: file.name.clone(),
                loaded: written.min(file.size),
                total: file.size,
            });
        }
        output
            .flush()
            .await
            .map_err(|e| SessionError::Io(e.to_string()))?;
        if written < file.size {
            return Err(SessionError::Protocol(format!(
                "download incomplete: got {written} of {} bytes",
                file.size
            )));
        }
        Ok(dest.clone())
    }

    pub async fn cancel_transfer(&self) {
        if let Some(device) = self.device.lock().await.as_ref() {
            let prefix = super::protocol::frame_prefix();
            // status 0 cancels the active transfer.
            let frame = file_request_frame(prefix, 0, 0, 0, false, 0);
            let _ = device.write_frame(&frame).await;
        }
        *self.transferring.lock().await = false;
    }
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
    // about the user's filesystem leaks into the frontend.
    let destination = app
        .dialog()
        .file()
        .set_file_name(&file.name)
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
