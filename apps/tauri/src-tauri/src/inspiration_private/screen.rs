//! OS session-lock hooks. Browser focus alone is not treated as a screen lock.
use tauri::AppHandle;
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) {
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSString};
    use std::ptr::NonNull;
    let app = app.clone();
    let callback = block2::RcBlock::new(move |_: NonNull<NSNotification>| super::lock(&app));
    let name = NSString::from_str("com.apple.screenIsLocked");
    let observer =
        unsafe {
            NSDistributedNotificationCenter::defaultCenter()
                .addObserverForName_object_queue_usingBlock(Some(&name), None, None, &callback)
        };
    // The notification center owns the callback until process exit. Keeping
    // its observer alive avoids an unsafe cross-thread Objective-C wrapper.
    std::mem::forget(observer);
}
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) {}
#[cfg(target_os = "windows")]
pub fn locked() -> bool {
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
    };
    unsafe {
        match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) {
            Ok(desktop) => {
                let _ = CloseDesktop(desktop);
                false
            }
            Err(_) => true,
        }
    }
}
#[cfg(not(target_os = "windows"))]
pub fn locked() -> bool {
    false
}
