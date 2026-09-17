// Shared dual-track recording contract (macOS sidecar ⇆ Windows in-process
// capture ⇆ future platforms).
//
// Everything a finished session leaves on disk is described by one versioned
// manifest (`manifest.json`) next to the track files:
//
//   mic.wav        16 kHz mono s16 — microphone after echo processing (the
//                  recognition + default-playback track; on macOS today this
//                  is the unprocessed capture, see the manifest's `processing`
//                  field per track)
//   system.wav     16 kHz mono s16 — system mixdown as recognised
//   mic_raw.wav    device-rate raw microphone capture (Windows only; macOS
//                  archives raw audio in mic.wav/system.wav)
//   system_raw.wav device-rate raw loopback capture (Windows only)
//   manifest.json  this contract
//
// All tracks live on one timeline of milliseconds relative to the recording
// start. Pauses freeze the timeline (the pause is padded with silence in the
// 16 kHz tracks); device faults are padded too *and* recorded in `gaps`, so a
// replay can never silently shift content.
//
// The echo canceller is reached through the small C ABI in `aec` so macOS and
// Windows can share one binary implementation; a pure-Rust correlation gate
// (the macOS EchoGate semantics) is the built-in fallback backend.

// Items unused on a given platform are still part of the cross-platform
// contract surface (the other side consumes them).
#![allow(dead_code)]

pub mod aec;
#[cfg(feature = "aec3")]
pub mod aec3;
pub mod framer;
pub mod manifest;
pub mod resampler;
pub mod wav;


/// Frame length every recognition consumer expects: 20 ms of 16 kHz mono
/// s16 PCM = 640 bytes.
pub const RECOGNITION_SAMPLE_RATE: u32 = 16_000;
pub const RECOGNITION_FRAME_SAMPLES: usize = 320;
pub const RECOGNITION_FRAME_MS: u64 = 20;
pub const RECOGNITION_FRAME_BYTES: usize = RECOGNITION_FRAME_SAMPLES * 2;

/// Internal processing rate: both capture paths resample to this before the
/// echo canceller, which consumes 10 ms (480 sample) frames.
pub const PROCESSING_SAMPLE_RATE: u32 = 48_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognition_constants_match_wire_format() {
        assert_eq!(RECOGNITION_FRAME_BYTES, 640);
        assert_eq!(RECOGNITION_FRAME_SAMPLES, 320);
        assert_eq!(PROCESSING_SAMPLE_RATE / 100, 480);
    }
}
