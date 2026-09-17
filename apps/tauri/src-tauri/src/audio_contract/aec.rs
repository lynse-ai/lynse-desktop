//! Echo cancellation contract — the Rust mirror of `dsp/lynse_aec.h`
//! (the frozen C ABI the macOS sidecar links; see the file for the canonical
//! comments).
//!
//! ```c
//! lynse_aec_t *lynse_aec_create(int sample_rate_hz);
//! void         lynse_aec_destroy(lynse_aec_t *aec);
//! const char  *lynse_aec_engine_id(void);          // "webrtc-aec3-1.3"
//! int lynse_aec_process_reverse(lynse_aec_t*, const float* samples, int frame_count);
//! int lynse_aec_process_near(lynse_aec_t*, float* samples, int frame_count, int delay_ms);
//! void lynse_aec_reset(lynse_aec_t *aec);
//! ```
//!
//! Every frame is 10 ms of MONO float at the engine rate (48 kHz here); the
//! reference is the downmixed system playback. `process_near` works in place
//! and takes the caller's acoustic-delay hint. The default backend is the
//! pure-Rust correlation gate (macOS `EchoGate` semantics); the `aec3` cargo
//! feature calls the statically linked vendored WebRTC build of the same ABI.

use super::PROCESSING_SAMPLE_RATE;

pub const ENGINE_FRAME_SAMPLES: usize = PROCESSING_SAMPLE_RATE as usize / 100; // 480
pub const MIC_CHANNEL_COUNT: u32 = 1;

pub trait EchoCanceller: Send {
    /// Feed one 10 ms far-end (system playback) reference frame.
    fn process_reverse(&mut self, samples: &mut [f32]) -> bool;

    /// Process one 10 ms near-end (microphone) frame in place. `delay_ms` is
    /// the caller's acoustic-path delay estimate between reference and mic.
    fn process_near(&mut self, samples: &mut [f32], delay_ms: i32) -> bool;

    /// Drop all learned state (pause/resume, device switch).
    fn reset(&mut self);

    /// Engine id recorded in the session manifest ("webrtc-aec3-1.3" for the
    /// vendored build; "gate" for the fallback).
    fn engine_id(&self) -> String;
}

/// Create the best available backend for this build.
pub fn create() -> Result<Box<dyn EchoCanceller>, String> {
    #[cfg(feature = "aec3")]
    {
        match crate::audio_contract::aec3::Aec3Canceller::new() {
            Ok(canceller) => return Ok(Box::new(canceller)),
            Err(error) => log::warn!("AEC3 unavailable, falling back to correlation gate: {error}"),
        }
    }
    #[cfg(not(feature = "aec3"))]
    {
        Ok(Box::new(GateCanceller::new()))
    }
    #[cfg(feature = "aec3")]
    {
        Ok(Box::new(GateCanceller::new()))
    }
}

// ---------------------------------------------------------------------------
// Default backend: correlation gate (macOS EchoGate semantics)
// ---------------------------------------------------------------------------

/// Cross-stream acoustic-echo detector. When the speakers play the system
/// audio, the mic signal is a delayed, attenuated copy of it; high normalized
/// cross-correlation between the streams means the mic currently carries only
/// echo, and its frames are silenced in the processed track (the raw track
/// keeps everything). A human speaking into the mic is uncorrelated with the
/// system stream, which reopens the gate within one decision window.
///
/// Hysteresis is asymmetric on purpose: closing requires two consecutive
/// correlated windows (no flapping on brief musical passages), while any
/// uncorrelated window — or mic energy the echo path cannot explain — opens
/// the gate immediately so speech is never clipped for long.
///
/// Internally the gate evaluates on a 16 kHz signal (48 kHz ÷ 3) to keep the
/// correlation search cheap; the output path is untouched 48 kHz. The
/// `delay_ms` hint is accepted but unused — the correlation search scans all
/// physically plausible lags.
pub struct GateCanceller {
    /// 500 ms of 16 kHz samples.
    buffer_samples: usize,
    /// 250 ms decision window.
    decision_samples: usize,
    /// Speaker-to-mic path delay rarely exceeds 30 ms (480 samples @16k).
    max_lag_samples: usize,
    lag_stride: usize,
    correlated_threshold: f64,
    echo_ratio_ceiling: f64,
    voice_ratio_floor: f64,
    system_silence_rms: f64,

    decimation: usize,
    /// 16 kHz decimated history, capped at `buffer_samples`.
    mic_buffer: Vec<f32>,
    ref_buffer: Vec<f32>,
    mic_since_decision: usize,
    correlated_windows: u32,
    suppressed: bool,
}

impl GateCanceller {
    pub fn new() -> Self {
        Self {
            buffer_samples: 8_000,
            decision_samples: 4_000,
            max_lag_samples: 480,
            lag_stride: 4,
            correlated_threshold: 0.65,
            echo_ratio_ceiling: 0.5,
            voice_ratio_floor: 0.8,
            system_silence_rms: 0.004,
            decimation: (PROCESSING_SAMPLE_RATE / 16_000) as usize,
            mic_buffer: Vec::new(),
            ref_buffer: Vec::new(),
            mic_since_decision: 0,
            correlated_windows: 0,
            suppressed: false,
        }
    }

    fn decimate(&self, samples: &[f32]) -> Vec<f32> {
        samples
            .chunks(self.decimation)
            .filter(|chunk| chunk.len() == self.decimation)
            .map(|chunk| chunk.iter().sum::<f32>() / self.decimation as f32)
            .collect()
    }

    fn append_capped(buffer: &mut Vec<f32>, chunk: &[f32], cap: usize) {
        buffer.extend_from_slice(chunk);
        if buffer.len() > cap {
            let overflow = buffer.len() - cap;
            buffer.drain(..overflow);
        }
    }

    fn evaluate(&mut self) {
        if self.mic_buffer.len() < self.decision_samples
            || self.ref_buffer.len() < self.decision_samples
        {
            return;
        }
        let mic = &self.mic_buffer[self.mic_buffer.len() - self.decision_samples..];
        let reference = &self.ref_buffer[self.ref_buffer.len() - self.decision_samples..];
        let ref_rms = rms(reference);
        let mic_rms = rms(mic);
        // Nothing playing through the system stream: correlation undefined,
        // the microphone is the only live source — keep it open.
        if ref_rms <= self.system_silence_rms {
            self.correlated_windows = 0;
            self.suppressed = false;
            return;
        }
        let ratio = mic_rms / ref_rms;
        // A voice in the room dominates any echo path — open immediately.
        if ratio > self.voice_ratio_floor {
            self.correlated_windows = 0;
            self.suppressed = false;
            return;
        }
        // A silent mic while audio plays is echo (or nothing at all):
        // silencing it saves the duplicate recognition feed.
        if mic_rms < self.system_silence_rms {
            self.correlated_windows += 1;
            if self.correlated_windows >= 2 {
                self.suppressed = true;
            }
            return;
        }
        let best = max_normalized_correlation(mic, reference, self.max_lag_samples, self.lag_stride);
        if best >= self.correlated_threshold && ratio < self.echo_ratio_ceiling {
            self.correlated_windows += 1;
            if self.correlated_windows >= 2 {
                self.suppressed = true;
            }
        } else {
            self.correlated_windows = 0;
            self.suppressed = false;
        }
    }
}

impl Default for GateCanceller {
    fn default() -> Self {
        Self::new()
    }
}

impl EchoCanceller for GateCanceller {
    fn process_reverse(&mut self, samples: &mut [f32]) -> bool {
        let decimated = self.decimate(samples);
        Self::append_capped(&mut self.ref_buffer, &decimated, self.buffer_samples);
        true
    }

    fn process_near(&mut self, samples: &mut [f32], _delay_ms: i32) -> bool {
        let decimated = self.decimate(samples);
        Self::append_capped(&mut self.mic_buffer, &decimated, self.buffer_samples);
        self.mic_since_decision += decimated.len();
        if self.mic_since_decision >= self.decision_samples {
            self.mic_since_decision = 0;
            self.evaluate();
        }
        if self.suppressed {
            samples.fill(0.0);
        }
        true
    }

    fn reset(&mut self) {
        self.mic_buffer.clear();
        self.ref_buffer.clear();
        self.mic_since_decision = 0;
        self.correlated_windows = 0;
        self.suppressed = false;
    }

    fn engine_id(&self) -> String {
        "gate".to_owned()
    }
}

fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    (sum / samples.len() as f64).sqrt()
}

/// Peak normalized (Pearson) cross-correlation of mic against reference over
/// positive lags (the mic trails the system — the physical echo direction),
/// searched with `lag_stride`.
fn max_normalized_correlation(mic: &[f32], reference: &[f32], max_lag: usize, stride: usize) -> f64 {
    let count = mic.len().min(reference.len());
    if count <= max_lag {
        return 0.0;
    }
    let pairs = (count - max_lag) as f64;
    let mut best = 0.0;
    let mut lag = 0;
    while lag <= max_lag {
        let (mut sum_xy, mut sum_x, mut sum_y, mut sum_xx, mut sum_yy) =
            (0.0f64, 0.0, 0.0, 0.0, 0.0);
        for index in 0..count - max_lag {
            let x = f64::from(mic[index + lag]);
            let y = f64::from(reference[index]);
            sum_xy += x * y;
            sum_x += x;
            sum_y += y;
            sum_xx += x * x;
            sum_yy += y * y;
        }
        let numerator = sum_xy - sum_x * sum_y / pairs;
        let variance_x = sum_xx - sum_x * sum_x / pairs;
        let variance_y = sum_yy - sum_y * sum_y / pairs;
        if variance_x > 1e-12 && variance_y > 1e-12 {
            let value = numerator / (variance_x.sqrt() * variance_y.sqrt());
            if value > best {
                best = value;
            }
        }
        lag += stride;
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A periodic pattern with non-zero variance (constant signals have no
    /// correlation to measure). Period 12 at 48 kHz → period 4 after the
    /// gate's internal 3:1 decimation.
    fn pattern(scaled: f32) -> Vec<f32> {
        (0..ENGINE_FRAME_SAMPLES)
            .map(|i| ((i % 12) as f32 / 12.0 - 0.5) * scaled)
            .collect()
    }

    fn feed_gate(
        gate: &mut GateCanceller,
        mic: &[f32],
        reference: &[f32],
        frames: usize,
    ) -> Vec<bool> {
        let mut silenced = Vec::new();
        for _ in 0..frames {
            assert!(gate.process_reverse(&mut reference.to_vec()));
            let mut near = mic.to_vec();
            assert!(gate.process_near(&mut near, 0));
            silenced.push(near.iter().all(|v| *v == 0.0));
        }
        silenced
    }

    #[test]
    fn open_gate_passes_mic_through() {
        let mut gate = GateCanceller::new();
        let mut mic = pattern(0.3);
        gate.process_reverse(&mut pattern(0.6));
        gate.process_near(&mut mic, 0);
        // Open gate: the processed output is the mic itself, untouched.
        assert_eq!(mic, pattern(0.3));
    }

    #[test]
    fn correlated_echo_closes_the_gate() {
        let mut gate = GateCanceller::new();
        // Mic is a scaled copy of the reference → perfect correlation at an
        // echo-explaining level → the gate must silence the mic track.
        let silenced = feed_gate(&mut gate, &pattern(0.2), &pattern(0.6), 120);
        assert!(silenced.iter().any(|s| *s), "gate must close on echo");
    }

    #[test]
    fn human_voice_reopens_the_gate_immediately() {
        let mut gate = GateCanceller::new();
        feed_gate(&mut gate, &pattern(0.2), &pattern(0.6), 120);
        // Louder uncorrelated mic: the voice ratio opens the gate at once.
        let noise: Vec<f32> = (0..ENGINE_FRAME_SAMPLES)
            .map(|i| ((i % 7) as f32 / 7.0 - 0.5) * 0.9)
            .collect();
        let mut reopened = false;
        for _ in 0..40 {
            gate.process_reverse(&mut pattern(0.6));
            let mut near = noise.clone();
            gate.process_near(&mut near, 0);
            if near.iter().any(|v| *v != 0.0) {
                reopened = true;
                break;
            }
        }
        assert!(reopened, "voice must reopen the gate within a window");
    }

    #[test]
    fn silent_system_keeps_gate_open() {
        let mut gate = GateCanceller::new();
        // Nothing playing: correlation is meaningless, the mic must stay
        // open — recognition decides what to do with silence.
        let mic = pattern(0.2);
        for _ in 0..120 {
            gate.process_reverse(&mut vec![0.0; ENGINE_FRAME_SAMPLES]);
            let mut near = mic.clone();
            gate.process_near(&mut near, 0);
            assert_eq!(near, mic, "silent reference must never close the gate");
        }
    }

    #[test]
    fn reset_clears_state() {
        let mut gate = GateCanceller::new();
        feed_gate(&mut gate, &pattern(0.2), &pattern(0.6), 120);
        gate.reset();
        assert_eq!(gate.mic_buffer.len(), 0);
        assert_eq!(gate.correlated_windows, 0);
        assert!(!gate.suppressed);
        assert_eq!(gate.engine_id(), "gate");
    }
}
