// WASAPI endpoint discovery and microphone consent (Windows).
//
// Device identity is the WASAPI endpoint id string (stable across reboots),
// never just the friendly name — the persisted selection must survive
// reconnection order changes. Enumeration powers the settings device pickers;
// the IMMNotificationClient registration lives here too and signals
// default/removal changes to the running capture threads.

use windows::core::PCWSTR;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eMultimedia, eRender, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE, EDataFlow, ERole,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, STGM_READ, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

/// One selectable endpoint, as surfaced to the UI.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    /// Stable WASAPI endpoint id (e.g. `{0.0.1.00000000}.{guid}`).
    pub id: String,
    pub name: String,
    /// Default *multimedia/playback* endpoint of its flow.
    pub is_default: bool,
    /// Default *communications* endpoint — what conferencing apps pick. The
    /// mic default follows this per the product spec.
    pub is_default_communications: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevicesSnapshot {
    pub inputs: Vec<AudioDeviceInfo>,
    pub outputs: Vec<AudioDeviceInfo>,
    /// Endpoint ids of the defaults at enumeration time.
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

/// COM init for the calling thread (idempotent; harmless on error).
pub fn ensure_com() {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

fn device_id(device: &IMMDevice) -> Option<String> {
    unsafe { device.GetId() }
        .ok()
        .and_then(|id| unsafe { id.to_string() }.ok())
}

/// Friendly name via the property store; never fails (falls back to a
/// placeholder so UI lists stay usable).
pub fn device_name_of(device: &IMMDevice) -> String {
    device_name(device)
}

fn device_name(device: &IMMDevice) -> String {
    let store: IPropertyStore = match unsafe { device.OpenPropertyStore(STGM_READ) } {
        Ok(store) => store,
        Err(_) => return "Unknown device".to_owned(),
    };
    let value = match unsafe { store.GetValue(&PKEY_Device_FriendlyName) } {
        Ok(value) => value,
        Err(_) => return "Unknown device".to_owned(),
    };
    // VT_LPWSTR allocation freed with CoTaskMemFree; a conversion failure
    // degrades to a placeholder rather than hiding the device.
    let name = match unsafe { PropVariantToStringAlloc(&value) } {
        Ok(name) => name,
        Err(_) => return "Unknown device".to_owned(),
    };
    let text = unsafe { name.to_string() }.unwrap_or_else(|_| "Unknown device".to_owned());
    unsafe { CoTaskMemFree(Some(name.as_ptr().cast())) };
    if text.is_empty() {
        "Unknown device".to_owned()
    } else {
        text
    }
}

fn enumerate_flow(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
    role: ERole,
) -> (Vec<AudioDeviceInfo>, Option<String>) {
    let mut devices = Vec::new();
    let default_flow_id = unsafe { enumerator.GetDefaultAudioEndpoint(flow, role) }
        .ok()
        .and_then(|device| device_id(&device));
    let default_communications_id =
        unsafe { enumerator.GetDefaultAudioEndpoint(flow, eCommunications) }
            .ok()
            .and_then(|device| device_id(&device));
    let collection = match unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) } {
        Ok(collection) => collection,
        Err(_) => return (devices, default_flow_id),
    };
    let count = match unsafe { collection.GetCount() } {
        Ok(count) => count,
        Err(_) => return (devices, default_flow_id),
    };
    for index in 0..count {
        let device = match unsafe { collection.Item(index) } {
            Ok(device) => device,
            Err(_) => continue,
        };
        let Some(id) = device_id(&device) else { continue };
        let name = device_name(&device);
        let is_default = default_flow_id.as_ref() == Some(&id);
        let is_default_communications = default_communications_id.as_ref() == Some(&id);
        devices.push(AudioDeviceInfo {
            id,
            name,
            is_default,
            is_default_communications,
        });
    }
    (devices, default_flow_id)
}

/// Enumerate all active capture + render endpoints with their defaults.
pub fn enumerate_devices() -> AudioDevicesSnapshot {
    ensure_com();
    let enumerator = match unsafe {
        CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
    } {
        Ok(enumerator) => enumerator,
        Err(_) => return AudioDevicesSnapshot::default(),
    };
    // Mic default = communications role (what Zoom/Teams pick); system
    // playback default = multimedia role (what media playback uses).
    let (inputs, default_input) = enumerate_flow(&enumerator, eCapture, eMultimedia);
    let (outputs, default_output) = enumerate_flow(&enumerator, eRender, eMultimedia);
    AudioDevicesSnapshot {
        inputs,
        outputs,
        default_input,
        default_output,
    }
}

/// Resolve the mic endpoint to capture: the explicit selection, else the
/// default communications input device.
pub fn resolve_capture_endpoint(
    enumerator: &IMMDeviceEnumerator,
    endpoint_id: Option<&str>,
) -> windows::core::Result<IMMDevice> {
    match endpoint_id {
        Some(id) => {
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
        }
        None => unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications) },
    }
}

/// Resolve the loopback endpoint to capture: the explicit selection, else the
/// default multimedia render device.
pub fn resolve_render_endpoint(
    enumerator: &IMMDeviceEnumerator,
    endpoint_id: Option<&str>,
) -> windows::core::Result<IMMDevice> {
    match endpoint_id {
        Some(id) => {
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
        }
        None => unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) },
    }
}

// ---------------------------------------------------------------------------
// Microphone consent (privacy settings)
// ---------------------------------------------------------------------------

const CONSENT_STORE: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MicConsent {
    Granted,
    Denied,
    /// The master switch state cannot be read — proceed and rely on capture
    /// failure reporting instead of blocking the user.
    Unknown,
}

fn read_reg_sz(key: windows::Win32::System::Registry::HKEY, subkey: &[u16], value: &[u16]) -> Option<String> {
    use windows::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let mut buffer = [0u16; 512];
    let mut size = (buffer.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            key,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != windows::Win32::Foundation::ERROR_SUCCESS {
        return None;
    }
    let len = size as usize / 2;
    let mut text = String::from_utf16_lossy(&buffer[..len.min(buffer.len())]);
    while text.ends_with('\0') {
        text.pop();
    }
    Some(text)
}

/// Best-effort read of the microphone privacy master switch. Windows keeps
/// per-app consent under `NonPackaged\<exe>\Value`; an explicit Deny for our
/// exe beats an Allow master switch.
pub fn microphone_consent() -> MicConsent {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let subkey: Vec<u16> = CONSENT_STORE.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = "Value\0".encode_utf16().collect();
    for key in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        match read_reg_sz(key, &subkey, &value).as_deref() {
            Some("Allow") => return MicConsent::Granted,
            Some("Deny") => return MicConsent::Denied,
            _ => continue,
        }
    }
    // Master switch on: honour a per-app Deny if one exists for this exe.
    let exe = std::env::current_exe().ok().and_then(|path| {
        path.file_stem().map(|stem| stem.to_string_lossy().into_owned())
    });
    if let Some(exe) = exe {
        let per_app: Vec<u16> = format!("{CONSENT_STORE}\\NonPackaged\\{exe}\\Value")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        if read_reg_sz(HKEY_CURRENT_USER, &subkey, &per_app).as_deref() == Some("Deny") {
            return MicConsent::Denied;
        }
    }
    MicConsent::Granted
}

/// Open the Windows microphone privacy page (`ms-settings:privacy-microphone`)
/// so the user can flip the switch. Unlike macOS TCC, no restart is required.
pub fn open_microphone_privacy_settings() {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:privacy-microphone"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn();
}

// ---------------------------------------------------------------------------
// Device-change notifications (IMMNotificationClient)
// ---------------------------------------------------------------------------

/// Flags the capture threads poll after notification callbacks fire. The
/// callback itself only records *that* something changed (and what); the
/// control loop decides whether and how to rebuild the streams.
#[derive(Default)]
pub struct DeviceChangeFlags {
    /// The default capture or render endpoint changed (follow-default mode
    /// must switch over).
    pub defaults_changed: std::sync::atomic::AtomicBool,
    /// An endpoint was added, removed or changed state (fixed-device mode
    /// re-checks whether its endpoint came back).
    pub endpoints_changed: std::sync::atomic::AtomicBool,
}

static DEVICE_CHANGE_FLAGS: std::sync::OnceLock<DeviceChangeFlags> = std::sync::OnceLock::new();

fn flags() -> &'static DeviceChangeFlags {
    DEVICE_CHANGE_FLAGS.get_or_init(DeviceChangeFlags::default)
}

pub fn take_default_change() -> bool {
    flags()
        .defaults_changed
        .swap(false, std::sync::atomic::Ordering::Relaxed)
}

pub fn take_endpoints_change() -> bool {
    flags()
        .endpoints_changed
        .swap(false, std::sync::atomic::Ordering::Relaxed)
}

/// Registered once per process; the COM object intentionally lives as long as
/// the process so repeated sessions don't accumulate notifications.
#[windows::core::implement(windows::Win32::Media::Audio::IMMNotificationClient)]
struct DeviceNotificationClient;

impl windows::Win32::Media::Audio::IMMNotificationClient_Impl for DeviceNotificationClient_Impl {
    fn OnDeviceStateChanged(
        &self,
        _device_id: &windows::core::PCWSTR,
        _device_state: DEVICE_STATE,
    ) -> windows::core::Result<()> {
        flags()
            .endpoints_changed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    fn OnDeviceAdded(&self, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        flags()
            .endpoints_changed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    fn OnDeviceRemoved(&self, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        flags()
            .endpoints_changed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        _flow: EDataFlow,
        _role: ERole,
        _device_id: &windows::core::PCWSTR,
    ) -> windows::core::Result<()> {
        flags()
            .defaults_changed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _device_id: &windows::core::PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

/// Install the global notification client (idempotent). Returns false when
/// registration failed — capture still works, only automatic device-follow
/// degrades to polling.
pub fn install_device_notifications() -> bool {
    ensure_com();
    static INSTALLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *INSTALLED.get_or_init(|| {
        let enumerator = match unsafe {
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        } {
            Ok(enumerator) => enumerator,
            Err(_) => return false,
        };
        let client: windows::Win32::Media::Audio::IMMNotificationClient =
            DeviceNotificationClient.into();
        if unsafe { enumerator.RegisterEndpointNotificationCallback(&client) }.is_err() {
            return false;
        }
        // The enumerator calls back without owning a reference of its own, so
        // releasing these leaves it dispatching into freed memory: the next
        // device event becomes an indirect call through a dead vtable (CFG
        // fastfail) or through whatever reused that block. The callback is
        // never unregistered, so holding these for the whole process is the
        // documented lifetime — one leaked pair of refs, by design.
        std::mem::forget((enumerator, client));
        true
    })
}
