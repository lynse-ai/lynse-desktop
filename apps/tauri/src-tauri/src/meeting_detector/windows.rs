// Windows meeting-audio poller.
//
// WASAPI exposes per-application audio sessions on every active endpoint.
// Enumerating render (speaker) + capture (microphone) endpoints through
// `IAudioSessionManager2` and keeping only sessions in the `Active` state
// yields exactly the processes currently sending or receiving audio — the
// same precision as the macOS CoreAudio process enumeration. PIDs are then
// resolved to executable names (`QueryFullProcessImageNameW`) and matched
// against the whitelist by the shared state machine.
//
// Lynse captures in-process with cpal on Windows, so own-PID exclusion (done
// centrally) keeps our own recordings from triggering the detector.

use super::ActiveProcess;

use std::collections::HashSet;

use windows::core::Interface;

use windows::Win32::Media::Audio::{
    AudioSessionStateActive, eCapture, eRender, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

/// One-time COM initialization for the dedicated polling thread.
pub fn init_thread() {
    // A changed-apartment error would only matter if this thread used STA
    // assumptions; it does not, so any outcome is fine as long as COM exists.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

fn endpoint_pids(
    enumerator: &IMMDeviceEnumerator,
    flow: windows::Win32::Media::Audio::EDataFlow,
) -> Vec<u32> {
    let collection = match unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) } {
        Ok(collection) => collection,
        Err(_) => return Vec::new(),
    };
    let device_count = match unsafe { collection.GetCount() } {
        Ok(count) => count,
        Err(_) => return Vec::new(),
    };
    let mut pids = Vec::new();
    for device_index in 0..device_count {
        let device = match unsafe { collection.Item(device_index) } {
            Ok(device) => device,
            Err(_) => continue,
        };
        let manager = match unsafe { device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) } {
            Ok(manager) => manager,
            Err(_) => continue,
        };
        let sessions = match unsafe { manager.GetSessionEnumerator() } {
            Ok(sessions) => sessions,
            Err(_) => continue,
        };
        let session_count = match unsafe { sessions.GetCount() } {
            Ok(count) => count,
            Err(_) => continue,
        };
        for session_index in 0..session_count {
            let control = match unsafe { sessions.GetSession(session_index) } {
                Ok(control) => control,
                Err(_) => continue,
            };
            // Only sessions with an actively running stream count; idle
            // registrations (e.g. an app that once played audio) stay silent.
            let state = match unsafe { control.GetState() } {
                Ok(state) => state,
                Err(_) => continue,
            };
            if state != AudioSessionStateActive {
                continue;
            }
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(pid) = (unsafe { control2.GetProcessId() }) else {
                continue;
            };
            // PID 0 belongs to system sounds.
            if pid != 0 {
                pids.push(pid);
            }
        }
    }
    pids
}

fn process_image_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        result.ok()?;
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        (!path.is_empty()).then_some(path)
    }
}

fn path_basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub fn poll(_allow_coarse: bool) -> Vec<ActiveProcess> {
    let enumerator =
        match unsafe { CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
            Ok(enumerator) => enumerator,
            Err(_) => {
                log::debug!("WASAPI device enumerator unavailable");
                return Vec::new();
            }
        };

    let mut pids: HashSet<u32> = HashSet::new();
    for flow in [eRender, eCapture] {
        for pid in endpoint_pids(&enumerator, flow) {
            pids.insert(pid);
        }
    }

    pids.into_iter()
        .filter_map(|pid| {
            let path = process_image_name(pid)?;
            Some(ActiveProcess {
                pid,
                // Windows whitelist matching is by executable name only.
                bundle_id: None,
                process_name: Some(path_basename(&path)),
            })
        })
        .collect()
}
