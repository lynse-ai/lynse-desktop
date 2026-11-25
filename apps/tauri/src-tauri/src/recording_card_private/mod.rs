mod audio;
mod device;
mod frames;
mod ownership;
mod protocol;
pub mod session;

pub use device::DEFAULT_PRODUCT_ID as PRODUCT_ID;
pub use device::DEFAULT_VENDOR_ID as VENDOR_ID;
pub use protocol::CardFile;
pub use protocol::StorageInfo;
pub use session::{ConnectResult, DownloadProgress, RecordingCardSession, SessionError};

pub use session::{
    recording_card_usb_cancel_download, recording_card_usb_connect, recording_card_usb_delete_file,
    recording_card_usb_disconnect, recording_card_usb_download, recording_card_usb_list_files,
    recording_card_usb_state, recording_card_usb_storage,
};

pub(super) fn with_commands(
    app_commands: impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let private_commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        session::recording_card_usb_connect,
        session::recording_card_usb_disconnect,
        session::recording_card_usb_state,
        session::recording_card_usb_list_files,
        session::recording_card_usb_storage,
        session::recording_card_usb_delete_file,
        session::recording_card_usb_download,
        session::recording_card_usb_cancel_download,
        session::recording_card_usb_get_auto_off,
        session::recording_card_usb_set_auto_off,
        session::recording_card_usb_get_mic_gain,
        session::recording_card_usb_set_mic_gain,
        session::recording_card_usb_set_bound,
        session::recording_card_usb_unbind,
        session::recording_card_usb_factory_reset,
        session::recording_card_usb_format_storage,
    ];

    move |invoke| {
        if invoke.message.command().starts_with("recording_card_usb_") {
            private_commands(invoke)
        } else {
            app_commands(invoke)
        }
    }
}
