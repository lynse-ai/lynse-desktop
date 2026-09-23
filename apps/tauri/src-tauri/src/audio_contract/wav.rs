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
use std::io::{Read, Seek, SeekFrom, Write};
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

/// What a WAV file actually holds: the chunk walk gives the real `data`
/// offset (a canonical 44-byte header is *not* assumed) and the payload is
/// clamped to the bytes on disk, so a track whose writer was killed before
/// `close` still reads back at full length instead of as zero samples.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WavInfo {
    pub format: WavFormat,
    pub data_offset: u64,
    /// Payload bytes actually readable — the header's claim, clamped to the
    /// size on disk.
    pub data_bytes: u64,
    /// What the `data` chunk header declares, before that clamp. Differs from
    /// `data_bytes` exactly when the header lies.
    pub declared_bytes: u64,
}

impl WavInfo {
    /// Payload frames (per-channel sample groups) available to read.
    pub fn frames(&self) -> u64 {
        let frame_bytes = self.frame_bytes();
        if frame_bytes == 0 {
            return 0;
        }
        self.data_bytes / frame_bytes as u64
    }

    pub fn frame_bytes(&self) -> usize {
        self.format.channels.max(1) as usize * (self.format.bits_per_sample / 8) as usize
    }

    /// Whether the header sizes still describe the file (a writer that reached
    /// `close` patched them; one that was killed did not).
    pub fn header_matches_contents(&self, file_len: u64) -> bool {
        self.data_offset + self.declared_bytes == file_len
    }
}

/// Parse RIFF/WAVE chunks. Returns `Err` for anything that is not a PCM or
/// IEEE-float WAV we can read; `Ok` clamps a bogus `data` size to the file.
/// Only the header region is read — an hour of 48 kHz stereo must not be
/// slurped into memory to learn its format.
pub fn inspect(path: &Path) -> Result<WavInfo, String> {
    let file_len = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
    let mut prefix = Vec::with_capacity(INSPECT_PREFIX_BYTES);
    File::open(path)
        .map_err(|error| error.to_string())?
        .take(INSPECT_PREFIX_BYTES as u64)
        .read_to_end(&mut prefix)
        .map_err(|error| error.to_string())?;
    inspect_bytes(&prefix, file_len).ok_or_else(|| format!("not a readable WAV: {}", path.display()))
}

/// Bytes of header region [`inspect`] reads before giving up on the chunk walk.
const INSPECT_PREFIX_BYTES: usize = 64 * 1024;

/// Frozen physical format of each track name the capture engines write. The
/// Swift sidecar and the Windows engine must keep agreeing with this table —
/// it is what reads a track back when its header is gone. `directory`
/// disambiguates `master.wav`: the dual-channel and system-only writers
/// archive it stereo, the legacy mic-only writer mono, told apart by whether
/// any other track sits beside it.
pub fn capture_track_format(track: &str, directory: &Path) -> Option<WavFormat> {
    let raw = |channels: u16| WavFormat {
        sample_rate: super::PROCESSING_SAMPLE_RATE,
        channels,
        bits_per_sample: 16,
        sample_format: "int",
    };
    let format = match track {
        "mic.wav" | "mic_processed.wav" | "system.wav" => WavFormat::RECOGNITION,
        "mic_raw.wav" => raw(1),
        "system_raw.wav" => raw(2),
        "master.wav" => raw(if directory.join("mic_processed.wav").exists()
            || directory.join("mic_raw.wav").exists()
            || directory.join("system.wav").exists()
        {
            2
        } else {
            1
        }),
        _ => return None,
    };
    Some(format)
}

/// Rebuilds the header of a track whose whole 44-byte header region is
/// zeroed. The Swift sidecar writes that placeholder and only patches it on
/// a clean `close`, so a sidecar killed by the finalize budget leaves WAVs
/// without even a RIFF magic — [`inspect`] cannot see them and
/// [`repair_if_stale`] never reaches them. With the header gone, the frozen
/// per-track format is the only remaining description of the payload.
/// Returns whether the header was rewritten.
pub fn rebuild_zeroed_header(path: &Path, format: &WavFormat) -> Result<bool, String> {
    let file_len = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
    if file_len < 44 {
        return Ok(false);
    }
    let mut header = [0u8; 44];
    File::open(path)
        .map_err(|error| error.to_string())?
        .read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    // A real WAV — even one of pure digital silence — carries "RIFF" at byte
    // zero, so an all-zero header region can only be an unpatched placeholder.
    if header.iter().any(|&byte| byte != 0) {
        return Ok(false);
    }
    repair_header(path, format)?;
    Ok(true)
}

/// Repairs the canonical header a capture writer never got to patch: the
/// sidecar is killed when draining takes longer than the finalize budget, and
/// its WAV files then hold full PCM behind a zero-length `data` chunk. Only
/// files that already use the 44-byte layout are touched, so foreign WAVs are
/// left alone. Returns whether the file was rewritten.
pub fn repair_if_stale(path: &Path) -> Result<bool, String> {
    let info = inspect(path)?;
    if info.format.sample_format != "int" {
        // A raw float track is not one of the killed writers' files.
        return Ok(false);
    }
    let file_len = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
    // Only the canonical 44-byte layout is rewritten; anything with extra
    // chunks ahead of `data` belongs to another tool and stays untouched.
    if info.data_offset != 44 || info.header_matches_contents(file_len) {
        return Ok(false);
    }
    repair_header(path, &info.format)?;
    Ok(true)
}

fn inspect_bytes(bytes: &[u8], file_len: u64) -> Option<WavInfo> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    // RIFF payload size as declared; placeholders and torn writes are handled
    // by the clamp against the real file length.
    let declared_riff = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as u64;
    let riff_end = declared_riff.saturating_add(8).min(file_len).max(12);
    let prefix_len = bytes.len() as u64;
    let mut cursor = 12usize;
    let mut format: Option<WavFormat> = None;
    let mut data: Option<(u64, u64)> = None;
    while (cursor as u64) + 8 <= prefix_len {
        let chunk_id = &bytes[cursor..cursor + 4];
        let size = u32::from_le_bytes(bytes[cursor + 4..cursor + 8].try_into().ok()?) as u64;
        let payload = (cursor + 8) as u64;
        // Never trust a declared size to stay inside the bytes we hold or the
        // span the RIFF header claims.
        let end = (payload + size).min(riff_end).min(prefix_len).max(payload);
        if chunk_id == b"fmt " {
            if end - payload < 16 {
                return None;
            }
            let head = &bytes[payload as usize..end as usize];
            let tag = u16::from_le_bytes(head[0..2].try_into().ok()?);
            let channels = u16::from_le_bytes(head[2..4].try_into().ok()?);
            let sample_rate = u32::from_le_bytes(head[4..8].try_into().ok()?);
            let bits = u16::from_le_bytes(head[14..16].try_into().ok()?);
            let sample_format = match tag {
                1 => "int",
                3 => "float",
                // WAVE_FORMAT_EXTENSIBLE: the real codec lives at byte 24.
                0xFFFE if head.len() >= 25 => match head[24] {
                    1 => "int",
                    3 => "float",
                    _ => return None,
                },
                _ => return None,
            };
            if channels == 0 || sample_rate == 0 {
                return None;
            }
            format = Some(WavFormat {
                sample_rate,
                channels,
                bits_per_sample: bits,
                sample_format,
            });
        } else if chunk_id == b"data" {
            // The raw declared size, unclamped: the difference against what the
            // file actually holds is how a lying header gets detected.
            data = Some((payload, size));
        }
        // Chunks are word-aligned; an odd size carries one pad byte.
        cursor = payload as usize + size as usize + (size as usize & 1);
    }
    let format = format?;
    let (offset, declared) = data?;
    let actual = file_len.saturating_sub(offset);
    Some(WavInfo {
        format,
        data_offset: offset,
        declared_bytes: declared,
        // A header that was never patched (declared 0) still yields its audio.
        data_bytes: if declared == 0 || declared > actual {
            actual
        } else {
            declared
        },
    })
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

    fn chunk(id: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(id);
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
        let payload: Vec<u8> = chunks.iter().flatten().copied().collect();
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&((payload.len() + 4) as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend(payload);
        out
    }

    fn fmt_chunk(rate: u32, channels: u16, bits: u16, tag: u16) -> Vec<u8> {
        let mut head = Vec::new();
        head.extend_from_slice(&tag.to_le_bytes());
        head.extend_from_slice(&channels.to_le_bytes());
        head.extend_from_slice(&rate.to_le_bytes());
        head.extend_from_slice(&(rate * channels as u32 * bits as u32 / 8).to_le_bytes());
        head.extend_from_slice(&(channels * bits / 8).to_le_bytes());
        head.extend_from_slice(&bits.to_le_bytes());
        chunk(b"fmt ", &head)
    }

    #[test]
    fn inspect_walkes_chunks_instead_of_assuming_44_bytes() {
        // A LIST chunk ahead of fmt/data shifts the payload off byte 44.
        let bytes = riff(&[
            chunk(b"LIST", b"INFO"),
            fmt_chunk(48_000, 2, 16, 1),
            chunk(b"data", &[1, 0, 2, 0, 3, 0, 4, 0]),
        ]);
        let info = inspect_bytes(&bytes, bytes.len() as u64).expect("parses");
        assert_eq!(info.data_offset, 44 + 12);
        assert_eq!(info.data_bytes, 8);
        assert_eq!(info.frames(), 2);
        assert_eq!(info.format.sample_rate, 48_000);
        assert_eq!(info.format.channels, 2);
        assert_eq!(info.format.sample_format, "int");
        assert!(info.header_matches_contents(bytes.len() as u64));
    }

    #[test]
    fn inspect_recovers_a_header_the_writer_never_patched() {
        let dir = temp_dir("inspect-killed");
        let path = dir.join("mic.wav");
        let writer = WavTrackWriter::recognition(&path).unwrap();
        writer.write_i16_at(0, &[1, 2, 3, 4]).unwrap();
        drop(writer); // killed before close: `data` still declares 0 bytes
        let file_len = std::fs::metadata(&path).unwrap().len();
        let info = inspect(&path).unwrap();
        assert_eq!(info.data_bytes, 8, "payload must be read from disk size");
        assert_eq!(info.declared_bytes, 0, "the header still lies");
        assert!(!info.header_matches_contents(file_len));
        assert_eq!(info.format, WavFormat::RECOGNITION);
        assert!(repair_if_stale(&path).unwrap());
        let repaired = inspect(&path).unwrap();
        assert_eq!(repaired.data_bytes, 8, "repair keeps the audio");
        assert!(repaired.header_matches_contents(file_len));
        assert!(!repair_if_stale(&path).unwrap(), "repair is idempotent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repair_leaves_a_well_formed_track_alone() {
        let dir = temp_dir("repair-clean");
        let path = dir.join("mic.wav");
        let writer = WavTrackWriter::recognition(&path).unwrap();
        writer.write_i16_at(0, &vec![3i16; 320]).unwrap();
        writer.close().unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(!repair_if_stale(&path).unwrap());
        assert_eq!(before, std::fs::read(&path).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebuilds_the_swift_sidecars_zeroed_placeholder_header() {
        // The Swift WavWriter creates its file with 44 zero bytes and patches
        // a real header only on close; a killed sidecar leaves payload behind
        // a header with no RIFF magic, which inspect cannot parse at all.
        let dir = temp_dir("rebuild-zeroed");
        let path = dir.join("mic_processed.wav");
        let writer_format = capture_track_format("mic_processed.wav", &dir).unwrap();
        std::fs::write(&path, {
            let mut bytes = vec![0u8; 44];
            bytes.extend_from_slice(&[1, 0, 2, 0, 3, 0, 4, 0]);
            bytes
        })
        .unwrap();
        assert!(inspect(&path).is_err(), "zeroed header is not a WAV yet");
        assert!(rebuild_zeroed_header(&path, &writer_format).unwrap());
        let info = inspect(&path).unwrap();
        assert_eq!(info.format, WavFormat::RECOGNITION);
        assert_eq!(info.frames(), 4);
        assert!(info.header_matches_contents(std::fs::metadata(&path).unwrap().len()));
        assert!(
            !rebuild_zeroed_header(&path, &writer_format).unwrap(),
            "a rebuilt header is no longer all-zero"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebuild_leaves_real_wavs_and_foreign_files_alone() {
        let dir = temp_dir("rebuild-skip");
        let real = dir.join("master.wav");
        let writer = WavTrackWriter::raw(
            &real,
            WavFormat {
                sample_rate: 48_000,
                channels: 2,
                bits_per_sample: 16,
                sample_format: "int",
            },
        )
        .unwrap();
        writer.write_i16_at(0, &[9i16, 8]).unwrap();
        writer.close().unwrap();
        let format = capture_track_format("master.wav", &dir).unwrap();
        assert_eq!(format.channels, 1, "no neighbouring track means mono master");
        assert!(!rebuild_zeroed_header(&real, &format).unwrap());

        let tiny = dir.join("mic_raw.wav");
        std::fs::write(&tiny, vec![0u8; 10]).unwrap();
        assert!(!rebuild_zeroed_header(&tiny, &format).unwrap(), "no header region");

        let junk = dir.join("system_raw.wav");
        std::fs::write(&junk, b"not a wav").unwrap();
        assert!(!rebuild_zeroed_header(&junk, &format).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn master_channel_count_follows_the_writers_that_ran() {
        let dir = temp_dir("master-channels");
        let format = |name: &str| capture_track_format(name, &dir).unwrap();
        // Dual-channel sessions always write a mic track beside the master.
        std::fs::write(dir.join("mic_processed.wav"), vec![0u8; 44]).unwrap();
        assert_eq!(format("master.wav").channels, 2);
        std::fs::remove_file(dir.join("mic_processed.wav")).unwrap();
        // Legacy system-only sessions leave the 16 kHz system track.
        std::fs::write(dir.join("system.wav"), vec![0u8; 44]).unwrap();
        assert_eq!(format("master.wav").channels, 2);
        std::fs::remove_file(dir.join("system.wav")).unwrap();
        // Legacy mic-only sessions archive a mono master.
        assert_eq!(format("master.wav").channels, 1);
        assert_eq!(format("mic_raw.wav").channels, 1);
        assert_eq!(format("system_raw.wav").channels, 2);
        assert!(capture_track_format("playback.wav", &dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect_reads_a_closed_recognition_track() {
        let dir = temp_dir("inspect-clean");
        let path = dir.join("mic.wav");
        let writer = WavTrackWriter::recognition(&path).unwrap();
        writer.write_i16_at(0, &vec![5i16; 320]).unwrap();
        writer.close().unwrap();
        let info = inspect(&path).unwrap();
        assert_eq!(info.data_offset, 44);
        assert_eq!(info.data_bytes, 640);
        assert_eq!(info.frames(), 320);
        assert!(info.header_matches_contents(std::fs::metadata(&path).unwrap().len()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect_flags_float_tracks_and_rejects_junk() {
        let dir = temp_dir("inspect-misc");
        let float_path = dir.join("system_raw.wav");
        let format = WavFormat {
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: 32,
            sample_format: "float",
        };
        let writer = WavTrackWriter::raw(&float_path, format).unwrap();
        writer.write_f32_at(0, &[0.5, -0.5]).unwrap();
        writer.close().unwrap();
        let info = inspect(&float_path).unwrap();
        assert_eq!(info.format.sample_format, "float");
        assert_eq!(info.frame_bytes(), 8);

        let junk = dir.join("junk.wav");
        std::fs::write(&junk, b"not a wav at all").unwrap();
        assert!(inspect(&junk).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
