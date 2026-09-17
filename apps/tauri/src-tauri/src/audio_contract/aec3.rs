//! WebRTC AEC3 backend — compiled only with the `aec3` cargo feature, which
//! statically links the shared `lynse_webrtc_aec` library implementing
//! `dsp/lynse_aec.h` (the frozen C ABI; the vendored WebRTC build is produced
//! by `scripts/build-lynse-aec3.ps1` on Windows and
//! `audio-capture/scripts/build-webrtc-aec.sh` on macOS).
//!
//! Keeping the FFI behind this module means the default build (no feature)
//! never requires the C++ toolchain, while the engine code is identical for
//! both backends — only `audio_contract::aec::create()` chooses.

use std::ffi::{c_char, c_int, CStr};

use super::aec::{EchoCanceller, ENGINE_FRAME_SAMPLES};
use super::PROCESSING_SAMPLE_RATE;

#[repr(C)]
pub struct LynseAec {
    _private: [u8; 0],
}

extern "C" {
    fn lynse_aec_engine_id() -> *const c_char;
    fn lynse_aec_create(sample_rate_hz: c_int) -> *mut LynseAec;
    fn lynse_aec_destroy(aec: *mut LynseAec);
    fn lynse_aec_process_reverse(aec: *mut LynseAec, samples: *const f32, frame_count: c_int) -> c_int;
    fn lynse_aec_process_near(aec: *mut LynseAec, samples: *mut f32, frame_count: c_int, delay_ms: c_int) -> c_int;
    fn lynse_aec_reset(aec: *mut LynseAec);
}

pub struct Aec3Canceller {
    handle: *mut LynseAec,
}

// The WebRTC APM handle is owned exclusively by this struct and all calls are
// serialised by the engine's single AEC queue.
unsafe impl Send for Aec3Canceller {}

impl Aec3Canceller {
    pub fn new() -> Result<Self, String> {
        let handle = unsafe { lynse_aec_create(PROCESSING_SAMPLE_RATE as c_int) };
        if handle.is_null() {
            return Err("lynse_aec_create returned null".to_owned());
        }
        Ok(Self { handle })
    }
}

impl Drop for Aec3Canceller {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { lynse_aec_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

impl EchoCanceller for Aec3Canceller {
    fn process_reverse(&mut self, samples: &mut [f32]) -> bool {
        debug_assert_eq!(samples.len(), ENGINE_FRAME_SAMPLES);
        unsafe { lynse_aec_process_reverse(self.handle, samples.as_ptr(), samples.len() as c_int) } == 0
    }

    fn process_near(&mut self, samples: &mut [f32], delay_ms: i32) -> bool {
        debug_assert_eq!(samples.len(), ENGINE_FRAME_SAMPLES);
        // A rejected frame is signalled by a negative status; the engine
        // passes the raw mic through and marks the span degraded.
        unsafe {
            lynse_aec_process_near(self.handle, samples.as_mut_ptr(), samples.len() as c_int, delay_ms)
        } == 0
    }

    fn reset(&mut self) {
        unsafe { lynse_aec_reset(self.handle) };
    }

    fn engine_id(&self) -> String {
        unsafe {
            let pointer = lynse_aec_engine_id();
            if pointer.is_null() {
                "webrtc-aec3-1.3".to_owned()
            } else {
                CStr::from_ptr(pointer).to_string_lossy().into_owned()
            }
        }
    }
}
