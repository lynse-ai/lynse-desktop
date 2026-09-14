// macOS meeting-audio poller.
//
// Primary signal: the CoreAudio "Process" object model (macOS 14.2+, the app
// already requires 15.0). `kAudioHardwarePropertyProcessObjectList` enumerates
// every client process connected to the HAL; each object exposes its PID
// (`'ppid'`), bundle ID (`'pbid'`) and whether it currently has active input /
// output streams (`'piri'` / `'piro'`). A meeting app showing up with audio IO
// is a precise "meeting in progress" signal — no accessibility or window-title
// access involved. Bundle IDs come straight from the HAL, so no AppKit is
// needed on this path.
//
// Coarse fallback (only when the HAL query errors, and only while Lynse is not
// recording): the default input device is "running somewhere" (some process
// has it open) plus a whitelist app is merely running via NSWorkspace. Weaker,
// but keeps detection alive if Apple ever restricts the process enumeration.

use super::ActiveProcess;

use std::ffi::{c_char, c_void, CStr};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

type OSStatus = i32;
type AudioObjectID = u32;

/// Rate limiter for repeating diagnostics (one line per window) so a persistent
/// failure on the 3s poll does not flood the log.
struct RateLimiter(AtomicU64);

impl RateLimiter {
    const fn new() -> Self {
        Self(AtomicU64::new(0))
    }

    fn ready(&self, window_secs: u64) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_secs())
            .unwrap_or(0);
        if now < self.0.load(Ordering::Relaxed) + window_secs {
            return false;
        }
        self.0.store(now, Ordering::Relaxed);
        true
    }
}

static ENUMERATION_FAILURE_LOG: RateLimiter = RateLimiter::new();
static COARSE_BLIND_LOG: RateLimiter = RateLimiter::new();

const NO_ERROR: OSStatus = 0;
const K_AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectID = 1;
const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = fourcc(b"glob");
const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;
const K_AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST: u32 = fourcc(b"prs#");
const K_AUDIO_PROCESS_PROPERTY_PID: u32 = fourcc(b"ppid");
const K_AUDIO_PROCESS_PROPERTY_BUNDLE_ID: u32 = fourcc(b"pbid");
const K_AUDIO_PROCESS_PROPERTY_IS_RUNNING_INPUT: u32 = fourcc(b"piri");
const K_AUDIO_PROCESS_PROPERTY_IS_RUNNING_OUTPUT: u32 = fourcc(b"piro");
const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: u32 = fourcc(b"dIn ");
const K_AUDIO_DEVICE_PROPERTY_DEVICE_IS_RUNNING_SOMEWHERE: u32 = fourcc(b"gone");
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

const fn fourcc(bytes: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*bytes)
}

#[repr(C)]
struct AudioObjectPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        data_size: *mut u32,
    ) -> OSStatus;
    fn AudioObjectGetPropertyData(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> OSStatus;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *mut c_void);
    fn CFStringGetCString(
        string: *mut c_void,
        buffer: *mut c_char,
        buffer_size: isize,
        encoding: u32,
    ) -> u8;
}

#[link(name = "proc")]
extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_char, size: u32) -> i32;
}

fn property(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        selector,
        scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    }
}

/// Read a `UInt32`/`pid_t`-sized scalar property. `None` on any error.
fn get_u32(object_id: AudioObjectID, selector: u32) -> Option<u32> {
    let address = property(selector);
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            object_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut value as *mut u32 as *mut c_void,
        )
    };
    (status == NO_ERROR && size == 4).then_some(value)
}

/// Read a `CFString` property. `None` on any error; the returned CF object is
/// always released.
fn get_cf_string(object_id: AudioObjectID, selector: u32) -> Option<String> {
    let address = property(selector);
    let mut value: *mut c_void = ptr::null_mut();
    let mut size = std::mem::size_of::<*mut c_void>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            object_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut value as *mut *mut c_void as *mut c_void,
        )
    };
    if status != NO_ERROR || value.is_null() {
        return None;
    }
    let mut buffer = [0 as c_char; 1024];
    let ok = unsafe {
        CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, K_CF_STRING_ENCODING_UTF8)
    };
    let string = if ok != 0 {
        Some(unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().to_string())
    } else {
        None
    };
    unsafe { CFRelease(value) };
    string
}

/// Executable path of a pid (libproc), or None when the process is gone or
/// inaccessible. Used to (a) recognize our own capture sidecar and (b) match
/// whitelist entries by executable name for unbundled helper processes.
fn process_path(pid: i32) -> Option<String> {
    let mut buffer = [0 as c_char; 4096];
    let written = unsafe { proc_pidpath(pid, buffer.as_mut_ptr(), buffer.len() as u32) };
    if written <= 0 {
        return None;
    }
    let path = unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().to_string();
    (!path.is_empty()).then_some(path)
}

fn path_basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Enumerate every HAL client process with active audio IO.
fn poll_process_objects() -> Result<Vec<ActiveProcess>, String> {
    let address = property(K_AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST);
    let mut size: u32 = 0;
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            K_AUDIO_OBJECT_SYSTEM_OBJECT,
            &address,
            0,
            ptr::null(),
            &mut size,
        )
    };
    if status != NO_ERROR {
        return Err(format!("process list size query failed: {status}"));
    }
    let count = (size / std::mem::size_of::<AudioObjectID>() as u32) as usize;
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut objects = vec![0u32; count];
    let status = unsafe {
        AudioObjectGetPropertyData(
            K_AUDIO_OBJECT_SYSTEM_OBJECT,
            &address,
            0,
            ptr::null(),
            &mut size,
            objects.as_mut_ptr() as *mut c_void,
        )
    };
    if status != NO_ERROR {
        return Err(format!("process list query failed: {status}"));
    }

    let mut active = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for object_id in objects {
        if !seen.insert(object_id) {
            continue;
        }
        // `kAudioProcessPropertyIsRunningInput`/`Output`: 1 while the process
        // has at least one active input/output stream.
        let running_input = get_u32(object_id, K_AUDIO_PROCESS_PROPERTY_IS_RUNNING_INPUT);
        let running_output = get_u32(object_id, K_AUDIO_PROCESS_PROPERTY_IS_RUNNING_OUTPUT);
        let is_running_input = running_input.unwrap_or(0) != 0;
        let is_running_output = running_output.unwrap_or(0) != 0;
        if !is_running_input && !is_running_output {
            continue;
        }
        let Some(pid) = get_u32(object_id, K_AUDIO_PROCESS_PROPERTY_PID) else {
            continue;
        };
        let bundle_id = get_cf_string(object_id, K_AUDIO_PROCESS_PROPERTY_BUNDLE_ID);
        let process_name = process_path(pid as i32).map(|path| path_basename(&path));
        active.push(ActiveProcess {
            pid,
            bundle_id,
            process_name,
        });
    }
    Ok(active)
}

/// True when any process on the system currently holds the default input
/// device open (microphone in use).
fn default_input_in_use() -> bool {
    let address = property(K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE);
    let mut device: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            K_AUDIO_OBJECT_SYSTEM_OBJECT,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut device as *mut AudioObjectID as *mut c_void,
        )
    };
    if status != NO_ERROR || device == 0 {
        return false;
    }
    get_u32(device, K_AUDIO_DEVICE_PROPERTY_DEVICE_IS_RUNNING_SOMEWHERE).unwrap_or(0) != 0
}

/// Coarse fallback: whitelist apps that are merely running (no audio-IO
/// attribution), gated on the microphone actually being in use. Only used
/// while Lynse itself is not capturing.
fn poll_coarse_fallback() -> Vec<ActiveProcess> {
    if !default_input_in_use() {
        if COARSE_BLIND_LOG.ready(60) {
            log::info!(
                "Meeting detector: coarse fallback skipped — default input device not in use (or none present), so detection is blind until CoreAudio enumeration recovers"
            );
        }
        return Vec::new();
    }
    run_appkit(|apps| {
        apps.iter()
            .filter_map(|application| {
                let bundle_id = application.bundleIdentifier()?.to_string();
                Some(ActiveProcess {
                    pid: application.processIdentifier() as u32,
                    bundle_id: Some(bundle_id),
                    // Deliberately no process name: localized display names
                    // must never participate in name-based whitelist matching.
                    process_name: None,
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Run `body` with the workspace's running applications. Kept as a helper so
/// the AppKit calls sit in one place.
fn run_appkit<T>(
    body: impl FnOnce(&objc2_foundation::NSArray<objc2_app_kit::NSRunningApplication>) -> T,
) -> Option<T> {
    use objc2_app_kit::NSWorkspace;
    let workspace = NSWorkspace::sharedWorkspace();
    let applications = workspace.runningApplications();
    Some(body(&applications))
}

/// No per-thread setup needed on macOS; symmetric with the Windows poller.
pub fn init_thread() {}

pub fn poll(allow_coarse: bool) -> Vec<ActiveProcess> {
    match poll_process_objects() {
        Ok(active) => active,
        Err(error) => {
            if ENUMERATION_FAILURE_LOG.ready(60) {
                log::warn!(
                    "Meeting detector: CoreAudio process enumeration failed: {error}; {}",
                    if allow_coarse {
                        "falling back to coarse detection"
                    } else {
                        "no fallback available while recording"
                    }
                );
            }
            if allow_coarse {
                poll_coarse_fallback()
            } else {
                Vec::new()
            }
        }
    }
}
