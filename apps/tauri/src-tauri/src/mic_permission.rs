//! Microphone permission asked from the main app process (AVFoundation).
//!
//! TCC attributes a microphone grant to the process that requests it. The
//! audio-capture sidecar used to request it, but a bare helper binary cannot
//! be attributed to the app bundle under App Store / TestFlight packaging
//! (hardened runtime + App Sandbox), so the grant never stuck for distributed
//! builds — users saw "请先在左侧「音频源」中点击「授权」" forever. Asking
//! from the main bundle records the grant under "Lynse" in System Settings;
//! the sidecar — kept a plain child process (the dev-only `setsid` detach in
//! `sidecar_command` must not apply to packaged builds) — then inherits the
//! grant via responsible-process attribution when it opens the capture device.

/// Mirror of `AVCaptureAuthorizationStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAuthorization {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
}

impl MicAuthorization {
    /// The sidecar's JSON vocabulary for permission status, so every consumer
    /// (frontend, start guard) reads one set of strings.
    pub fn as_str(self) -> &'static str {
        match self {
            MicAuthorization::Authorized => "granted",
            MicAuthorization::NotDetermined => "notDetermined",
            MicAuthorization::Denied | MicAuthorization::Restricted => "denied",
        }
    }
}

#[cfg(target_os = "macos")]
pub fn authorization_status() -> MicAuthorization {
    use objc2_av_foundation::{
        AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio,
    };

    // AVMediaTypeAudio is a plain constant; its absence would be an Apple-side
    // ABI break, so unwrapping is fine.
    let media_type: &AVMediaType =
        unsafe { AVMediaTypeAudio.expect("AVMediaTypeAudio constant") };
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    match status {
        AVAuthorizationStatus::Authorized => MicAuthorization::Authorized,
        AVAuthorizationStatus::Denied => MicAuthorization::Denied,
        AVAuthorizationStatus::Restricted => MicAuthorization::Restricted,
        _ => MicAuthorization::NotDetermined,
    }
}

/// Runs the native TCC prompt (attributed to the Lynse bundle) and blocks
/// until the user answers. Safe to call when already decided — it returns
/// the current status without prompting.
#[cfg(target_os = "macos")]
pub fn request_access() -> MicAuthorization {
    use block2::RcBlock;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::mpsc;

    let current = authorization_status();
    if current != MicAuthorization::NotDetermined {
        return current;
    }

    let (tx, rx) = mpsc::channel();
    let completion = RcBlock::new(move |granted: objc2::runtime::Bool| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe {
        AVCaptureDevice::requestAccessForMediaType_completionHandler(
            AVMediaTypeAudio.expect("AVMediaTypeAudio constant"),
            &completion,
        );
    }
    // The prompt is user-facing; wait as long as the user needs to answer.
    match rx.recv() {
        Ok(true) => MicAuthorization::Authorized,
        Ok(false) => MicAuthorization::Denied,
        Err(_) => MicAuthorization::NotDetermined,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn authorization_status() -> MicAuthorization {
    MicAuthorization::Authorized
}

#[cfg(not(target_os = "macos"))]
pub fn request_access() -> MicAuthorization {
    MicAuthorization::Authorized
}
