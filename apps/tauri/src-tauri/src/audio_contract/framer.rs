//! 20 ms recognition framer (16 kHz mono s16, 640 bytes on the wire).
//!
//! Same contract as the macOS `PCMFrameAssembler`: capture arrives in
//! arbitrary chunks tagged with their position on the session timeline; a
//! position jump of at least one frame means audio was actually lost, and the
//! missing span is padded with silence so every later frame keeps its absolute
//! timeline position instead of shifting (dropped audio must never be spliced
//! away).

use super::{RECOGNITION_FRAME_BYTES, RECOGNITION_FRAME_MS, RECOGNITION_FRAME_SAMPLES, RECOGNITION_SAMPLE_RATE};

#[derive(Clone, Debug, PartialEq)]
pub struct RecognitionFrame {
    pub sequence: u64,
    /// Timeline position (ms of active recording) of the frame start.
    pub elapsed_ms: u64,
    /// 16-bit little-endian PCM, [`RECOGNITION_FRAME_BYTES`] long.
    pub bytes: Vec<u8>,
}

pub struct PcmFramer {
    pending: Vec<i16>,
    sequence: u64,
    stream_start_ms: Option<u64>,
    /// Set when a silence gap of at least one frame was inserted; the caller
    /// records these into the manifest.
    pub pending_gap: Option<(u64, u64)>,
}

impl PcmFramer {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            sequence: 0,
            stream_start_ms: None,
            pending_gap: None,
        }
    }

    /// Push one chunk. `chunk_start_ms` is the chunk's first sample position
    /// on the timeline (ms of active recording).
    pub fn append(&mut self, samples: &[f32], chunk_start_ms: u64) -> Vec<RecognitionFrame> {
        let pcm: Vec<i16> = samples
            .iter()
            .map(|value| {
                let scaled = (value.clamp(-1.0, 1.0) * 32_767.0).round() as i64;
                scaled.clamp(-32_768, 32_767) as i16
            })
            .collect();
        self.append_i16(&pcm, chunk_start_ms)
    }

    pub fn append_i16(&mut self, samples: &[i16], chunk_start_ms: u64) -> Vec<RecognitionFrame> {
        if self.stream_start_ms.is_none() {
            self.stream_start_ms = Some(chunk_start_ms);
        }
        self.insert_silence_if_needed(chunk_start_ms);
        self.pending.extend_from_slice(samples);
        self.drain()
    }

    /// Pad a final partial frame so the stream ends on a frame boundary.
    pub fn finish(&mut self) -> Vec<RecognitionFrame> {
        if !self.pending.is_empty() && self.pending.len() < RECOGNITION_FRAME_SAMPLES {
            let pad = RECOGNITION_FRAME_SAMPLES - self.pending.len();
            self.pending.resize(self.pending.len() + pad, 0);
        }
        self.drain()
    }

    fn insert_silence_if_needed(&mut self, chunk_start_ms: u64) {
        let Some(stream_start_ms) = self.stream_start_ms else {
            return;
        };
        let incoming_position =
            chunk_start_ms.saturating_sub(stream_start_ms) as usize * RECOGNITION_SAMPLE_RATE as usize
                / 1_000;
        let current_position = self.sequence as usize * RECOGNITION_FRAME_SAMPLES + self.pending.len();
        // Ignore normal callback jitter. A full-frame gap means capture
        // actually dropped audio — keep the timeline position and mark it.
        let gap = incoming_position as isize - current_position as isize;
        if gap >= RECOGNITION_FRAME_SAMPLES as isize {
            let gap_start_ms = self.sequence * RECOGNITION_FRAME_MS;
            let gap_end_ms = gap_start_ms + gap as u64 * 1_000 / RECOGNITION_SAMPLE_RATE as u64;
            self.pending_gap = Some((gap_start_ms, gap_end_ms));
            self.pending.resize(self.pending.len() + gap as usize, 0);
        } else {
            self.pending_gap = None;
        }
    }

    fn drain(&mut self) -> Vec<RecognitionFrame> {
        let mut frames = Vec::new();
        while self.pending.len() >= RECOGNITION_FRAME_SAMPLES {
            let chunk: Vec<i16> = self.pending.drain(..RECOGNITION_FRAME_SAMPLES).collect();
            let mut bytes = Vec::with_capacity(RECOGNITION_FRAME_BYTES);
            for sample in &chunk {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            frames.push(RecognitionFrame {
                sequence: self.sequence,
                elapsed_ms: self.stream_start_ms.unwrap_or(0) + self.sequence * RECOGNITION_FRAME_MS,
                bytes,
            });
            self.sequence += 1;
        }
        frames
    }
}

impl Default for PcmFramer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_count(total_samples: usize) -> usize {
        total_samples / RECOGNITION_FRAME_SAMPLES
    }

    #[test]
    fn cuts_20ms_frames_and_keeps_positions() {
        let mut framer = PcmFramer::new();
        let frames = framer.append(&vec![0.5; 800], 0);
        assert_eq!(frames.len(), frame_count(800));
        assert_eq!(frames[0].elapsed_ms, 0);
        assert_eq!(frames[0].bytes.len(), RECOGNITION_FRAME_BYTES);
        // 480 more samples at position 40ms: 1280 samples total → 4 frames.
        let frames = framer.append(&vec![0.5; 480], 40);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].elapsed_ms, 40);
        assert_eq!(frames[1].elapsed_ms, 60);
    }

    #[test]
    fn silence_gap_pads_without_shifting_positions() {
        let mut framer = PcmFramer::new();
        let first = framer.append(&vec![0.1; RECOGNITION_FRAME_SAMPLES], 0);
        assert_eq!(first.len(), 1);
        // Next chunk starts 100 ms late — five frames of audio vanished.
        assert_eq!(framer.pending_gap, None);
        let second = framer.append(&vec![0.1; RECOGNITION_FRAME_SAMPLES], 120);
        // The gap (20..120ms → 5 frames of silence) is padded, then the new
        // chunk frames continue; positions must stay absolute.
        assert_eq!(second.len(), 5 + 1);
        assert_eq!(framer.pending_gap, Some((20, 120)));
        assert_eq!(second[0].elapsed_ms, 20);
        assert_eq!(second[5].elapsed_ms, 120);
        // Padded frames are exactly silent.
        assert!(second[..5].iter().all(|frame| frame.bytes.iter().all(|&b| b == 0)));
    }

    #[test]
    fn jitter_below_one_frame_is_swallowed() {
        let mut framer = PcmFramer::new();
        framer.append(&vec![0.0; RECOGNITION_FRAME_SAMPLES], 0);
        // 5 ms of callback jitter: no gap, no padding.
        let frames = framer.append(&vec![0.0; RECOGNITION_FRAME_SAMPLES], 25);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].elapsed_ms, 20);
        assert_eq!(framer.pending_gap, None);
    }

    #[test]
    fn finish_pads_the_partial_tail() {
        let mut framer = PcmFramer::new();
        framer.append(&vec![0.0; 100], 0);
        let tail = framer.finish();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].bytes.len(), RECOGNITION_FRAME_BYTES);
    }
}
