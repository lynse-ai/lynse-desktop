// Windows dual-track capture engine (WASAPI loopback + microphone).
// Contract and track layout are defined by `crate::audio_contract`.

pub mod device;
pub mod engine;

pub use device::{
    enumerate_devices, microphone_consent, open_microphone_privacy_settings, AudioDeviceInfo,
    AudioDevicesSnapshot, MicConsent,
};
pub use engine::{CaptureConfig, CaptureEngine, EngineEvent, Sources};
