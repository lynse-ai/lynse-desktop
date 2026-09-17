//! Streaming WAV track writers.
//!
//! Both platforms archive tracks by appending device chunks as they arrive;
//! the canonical 44-byte header can only be written once the final sample
//! count is known, so the header is fixed up on `close` ("修复文件头"). A
//! `write_*_at` that lands past the current end pads with silence first: gaps
//! keep their timeline position instead of splicing the audio together.
//!
//! Raw float tracks (the shared-mode WASAPI stream) are archived as IEEE-float
//! samples without quantisation; recognition tracks are 16-bit PCM.

use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Physical WAV format of a track. Deliberately independent of the manifest
/// schema: raw tracks are 16-bit PCM at the processing rate on every platform
/// (the frozen raw format), recognition tracks 16 kHz mono.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WavFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    /// `int` or `float`.
    pub sample_format: &'static str,
}

impl WavFormat {
    pub const RECOGNITION: Self = Self {
        sample_rate: super::RECOGNITION_SAMPLE_RATE,
        channels: 1,
        bits_per_sample: 16,
        sample_format: "int",
    };
}

pub struct WavTrackWriter {
    inner: Mutex<Inner>,
    path: PathBuf,
    format: WavFormat,
}

struct Inner {
    file: Option<File>,
    /// Frames (per-channel sample groups) written so far.
    sample_frames: u64,
    closed: bool,
}

impl WavTrackWriter {
    /// 16 kHz mono s16 recognition/playback track.
    pub fn recognition(path: &Path) -> Result<Self, String> {
        Self::create(path, WavFormat::RECOGNITION)
    }

    /// Raw track (48 kHz s16 on every platform; float kept supported for
    /// future bit-exact archiving).
    pub fn raw(path: &Path, format: WavFormat) -> Result<Self, String> {
        Self::create(path, format)
    }

    fn create(path: &Path, format: WavFormat) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|error| error.to_string())?;
        file.write_all(&placeholder_header(&format))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            inner: Mutex::new(Inner {
                file: Some(file),
                sample_frames: 0,
                closed: false,
            }),
            path: path.to_path_buf(),
            format,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn format(&self) -> &WavFormat {
        &self.format
    }

    /// Append interleaved s16 samples whose first frame sits at `start_ms` on
    /// the session timeline.
    pub fn write_i16_at(&self, start_ms: u64, interleaved: &[i16]) -> Result<(), String> {
        let bytes: Vec<u8> = interleaved.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.write_bytes_at(start_ms, &bytes, 2)
    }

    /// Append interleaved f32 samples (raw float tracks), stored as IEEE
    /// float — no quantisation.
    pub fn write_f32_at(&self, start_ms: u64, interleaved: &[f32]) -> Result<(), String> {
        let bytes: Vec<u8> = interleaved.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.write_bytes_at(start_ms, &bytes, 4)
    }

    fn write_bytes_at(&self, start_ms: u64, bytes: &[u8], bytes_per_sample: usize) -> Result<(), String> {
        let frame_bytes = self.format.channels.max(1) as usize * bytes_per_sample;
        let incoming_frames = (bytes.len() / frame_bytes.max(1)) as u64;
        let rate = u64::from(self.format.sample_rate.max(1));
        let intended = start_ms * rate / 1_000;
        let mut inner = self.inner.lock().map_err(|_| "wav track lock poisoned")?;
        let pad_frames = intended.saturating_sub(inner.sample_frames) as usize;
        let mut payload = Vec::with_capacity(bytes.len() + pad_frames * frame_bytes);
        payload.resize(pad_frames * frame_bytes, 0);
        payload.extend_from_slice(bytes);
        let Some(file) = inner.file.as_mut() else {
            return Ok(());
        };
        file.write_all(&payload).map_err(|error| error.to_string())?;
        inner.sample_frames += pad_frames as u64 + incoming_frames;
        Ok(())
    }

    /// Rewrite the header with the final size and flush to disk. Idempotent;
    /// a crash before this leaves a valid placeholder header that recovery
    /// can repair with [`repair_header`].
    pub fn close(&self) -> Result<u64, String> {
        {
            let mut inner = self.inner.lock().map_err(|_| "wav track lock poisoned")?;
            if !inner.closed {
                inner.closed = true;
                if let Some(mut file) = inner.file.take() {
                    let _ = file.sync_all();
                }
            }
        }
        repair_header(&self.path, &self.format)?;
        Ok(self.sample_frames())
    }

    pub fn sample_frames(&self) -> u64 {
        self.inner
            .lock()
            .map(|inner| inner.sample_frames)
            .unwrap_or(0)
    }
}

fn format_tag(format: &WavFormat) -> u16 {
    if format.sample_format == "float" {
        3 // IEEE float
    } else {
        1 // PCM
    }
}

fn byte_rate(format: &WavFormat) -> u32 {
    format.sample_rate * u32::from(format.channels) * u32::from(format.bits_per_sample) / 8
}

fn block_align(format: &WavFormat) -> u16 {
    format.channels * format.bits_per_sample / 8
}

fn placeholder_header(format: &WavFormat) -> [u8; 44] {
    let mut header = [0u8; 44];
    fill_header(&mut header, format, 0);
    header
}

fn fill_header(header: &mut [u8; 44], format: &WavFormat, data_bytes: u32) {
    let mut cursor = 0;
    let mut push = |chunk: &[u8]| {
        header[cursor..cursor + chunk.len()].copy_from_slice(chunk);
        cursor += chunk.len();
    };
    push(b"RIFF");
    push(&(36 + data_bytes).to_le_bytes());
    push(b"WAVE");
    push(b"fmt ");
    push(&16u32.to_le_bytes());
    push(&format_tag(format).to_le_bytes());
    push(&format.channels.to_le_bytes());
    push(&format.sample_rate.to_le_bytes());
    push(&byte_rate(format).to_le_bytes());
    push(&block_align(format).to_le_bytes());
    push(&format.bits_per_sample.to_le_bytes());
    push(b"data");
    push(&data_bytes.to_le_bytes());
}

/// Recompute the RIFF/data sizes from the actual file length and rewrite the
/// header. Used both by `WavTrackWriter::close` and by crash recovery for
/// tracks whose writer never closed cleanly.
pub fn repair_header(path: &Path, format: &WavFormat) -> Result<(), String> {
    let data_bytes = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len()
        .saturating_sub(44);
    let mut header = [0u8; 44];
    fill_header(&mut header, format, data_bytes.min(u32::MAX as u64) as u32);
    let mut file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.write_all(&header))
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lynse-audio-contract-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recognition_writer_pads_positions_and_closes() {
        let dir = temp_dir("recognition");
        let path = dir.join("mic.wav");
        let writer = WavTrackWriter::recognition(&path).unwrap();
        writer.write_i16_at(0, &[1, 2, 3, 4]).unwrap();
        // Jump ahead 20 ms: 160 frames of silence must appear in between.
        writer.write_i16_at(20, &[5, 6, 7, 8]).unwrap();
        let frames = writer.close().unwrap();
        assert_eq!(frames, 160 + 160 + 4);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        let data_bytes = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        assert_eq!(data_bytes, frames as usize * 2);
        assert_eq!(bytes.len(), 44 + data_bytes);
        // The padded span really is silent.
        let silence = &bytes[44 + 8..44 + 8 + 160 * 2];
        assert!(silence.iter().all(|&b| b == 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn float_raw_writer_stores_ieee_floats_bit_exactly() {
        let dir = temp_dir("raw-float");
        let path = dir.join("system_raw.wav");
        let format = WavFormat {
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: 32,
            sample_format: "float",
        };
        let writer = WavTrackWriter::raw(&path, format).unwrap();
        let samples = [0.5f32, -0.5, 0.25, -0.25];
        writer.write_f32_at(0, &samples).unwrap();
        writer.close().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        // IEEE float tag, stereo, 48 kHz.
        assert_eq!(u16::from_le_bytes(bytes[20..22].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 48_000);
        // The payload is the exact f32 bit pattern, not quantised ints.
        for (index, expected) in samples.iter().enumerate() {
            let stored = f32::from_le_bytes(bytes[44 + index * 4..48 + index * 4].try_into().unwrap());
            assert_eq!(stored, *expected);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repair_header_recovers_size_after_crash() {
        let dir = temp_dir("repair");
        let path = dir.join("system.wav");
        let writer = WavTrackWriter::recognition(&path).unwrap();
        writer.write_i16_at(0, &vec![7i16; 320]).unwrap();
        // Simulate a crash: the writer never closed, the placeholder header
        // still claims zero data bytes.
        drop(writer);
        repair_header(&path, &WavFormat::RECOGNITION).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let data_bytes = u32::from_le_bytes(bytes[40..44].try_into().unwrap());
        assert_eq!(data_bytes, 640);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
