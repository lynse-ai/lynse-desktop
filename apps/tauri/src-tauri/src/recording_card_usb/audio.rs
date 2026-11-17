//! Convert raw recording-card Opus packets into a playable WAV file.
//!
//! The card stores constant-size Opus packets (normally 80 compressed bytes =
//! 40 ms at 16 kHz stereo), with no container or RIFF header. The previous
//! NewView integration decoded these to 16 kHz mono PCM and wrote a WAV header;
//! USB downloads now do the same so a saved recording opens in any player and
//! can be fed to the existing transcription pipeline.

use std::ffi::OsStr;
use std::io::SeekFrom;
use std::path::Path;

use chrono::{Local, TimeZone};
use opus::{Channels, Decoder};
use tokio::fs::File;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

pub const OUTPUT_SAMPLE_RATE: u32 = 16_000;

const DEFAULT_FRAME_BYTES: usize = 80;
const MAX_FRAME_BYTES: usize = 320;
/// Longest Opus packet: 120 ms of 48 kHz stereo, in i16 samples.
const MAX_SAMPLES_PER_PACKET: usize = OUTPUT_SAMPLE_RATE as usize * 120 / 1000 * 2;

/// Human-readable title for the file list and transfer progress. The device
/// names recordings as random `.raw` files, so use its RTC start time when
/// available and only fall back to the raw name for corrupt timestamps.
pub fn recording_card_title(name: &str, start_time: u64) -> String {
    timestamp_name(start_time).unwrap_or_else(|| name.to_string())
}

/// Suggested save-dialog name. Uses the same timestamp as the UI, with the
/// caller's extension (`.wav` after decoding on desktop).
pub fn suggested_download_name(name: &str, start_time: u64, extension: &str) -> String {
    let base = timestamp_name(start_time)
        .unwrap_or_else(|| original_stem(name).to_string_lossy().into_owned());
    format!("{base}.{}", extension.trim_start_matches('.'))
}

fn timestamp_name(start_time: u64) -> Option<String> {
    if start_time == 0 {
        return None;
    }
    let seconds = i64::try_from(start_time).ok()?;
    let local = Local.timestamp_opt(seconds, 0).single()?;
    Some(local.format("%Y-%m-%d %H:%M:%S").to_string())
}

fn original_stem(name: &str) -> &OsStr {
    Path::new(name)
        .file_name()
        .filter(|value| !value.is_empty())
        .and_then(|value| Path::new(value).file_stem())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsStr::new("recording"))
}

/// Card `frameSize` is compressed bytes per packet. Treat 0 as the common
/// 40 ms frame and cap absurd values so a corrupt list cannot drive huge
/// per-packet buffers.
pub fn normalized_frame_bytes(frame_size: u64) -> usize {
    if frame_size == 0 {
        DEFAULT_FRAME_BYTES
    } else {
        (frame_size as usize).min(MAX_FRAME_BYTES)
    }
}

/// Streaming decoder over the concatenated Opus packet stream.
pub struct CardOpusDecoder {
    decoder: Decoder,
    frame_bytes: usize,
    carry: Vec<u8>,
    decode_errors: usize,
}

impl CardOpusDecoder {
    pub fn new(frame_size: u64) -> Result<Self, String> {
        let decoder = Decoder::new(OUTPUT_SAMPLE_RATE, Channels::Stereo)
            .map_err(|error| format!("opus decoder init: {error}"))?;
        Ok(Self {
            decoder,
            frame_bytes: normalized_frame_bytes(frame_size),
            carry: Vec::new(),
            decode_errors: 0,
        })
    }

    /// Push compressed bytes; returns mono PCM for every complete packet.
    /// Broken packets become silence so one bad frame cannot abort a download.
    pub fn push(&mut self, data: &[u8]) -> Vec<i16> {
        let mut buffer = std::mem::take(&mut self.carry);
        buffer.extend_from_slice(data);
        let frame = self.frame_bytes;
        let mut mono = Vec::new();
        let mut offset = 0usize;
        while buffer.len() - offset >= frame {
            let packet = &buffer[offset..offset + frame];
            offset += frame;
            mono.extend_from_slice(&self.decode_packet(packet));
        }
        self.carry = buffer[offset..].to_vec();
        mono
    }

    fn decode_packet(&mut self, packet: &[u8]) -> Vec<i16> {
        let mut output = [0i16; MAX_SAMPLES_PER_PACKET];
        let packet_ms = (self.frame_bytes / 2).min(120);
        let silence_samples = packet_ms * OUTPUT_SAMPLE_RATE as usize / 1000 * 2;
        let decoded = match self.decoder.decode(packet, &mut output, false) {
            Ok(samples) => samples.min(MAX_SAMPLES_PER_PACKET),
            Err(error) => {
                self.decode_errors += 1;
                if self.decode_errors <= 3 || self.decode_errors % 100 == 0 {
                    log::warn!(
                        "[recording-card] opus packet {} failed: {error}; using silence",
                        self.decode_errors
                    );
                }
                silence_samples.min(MAX_SAMPLES_PER_PACKET)
            }
        };
        stereo_to_mono(&output[..decoded])
    }
}

/// Downmix interleaved stereo Int16 to mono by averaging both channels.
pub fn stereo_to_mono(interleaved: &[i16]) -> Vec<i16> {
    interleaved
        .chunks_exact(2)
        .map(|pair| {
            let mixed = (pair[0] as i32 + pair[1] as i32) / 2;
            mixed.clamp(i16::MIN as i32, i16::MAX as i32) as i16
        })
        .collect()
}

/// Streams 16 kHz mono PCM into a RIFF/WAVE file. The 44-byte header is
/// written first with placeholder sizes and patched in `finish()`.
pub struct WavWriter {
    file: File,
    data_bytes: u64,
}

impl WavWriter {
    pub async fn create(path: &Path) -> Result<Self, String> {
        let mut file = File::create(path)
            .await
            .map_err(|error| format!("create wav: {error}"))?;
        file.write_all(&[0u8; 44])
            .await
            .map_err(|error| format!("write wav header placeholder: {error}"))?;
        Ok(Self {
            file,
            data_bytes: 0,
        })
    }

    pub async fn write_samples(&mut self, samples: &[i16]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.file
            .write_all(&bytes)
            .await
            .map_err(|error| format!("write wav pcm: {error}"))?;
        self.data_bytes += bytes.len() as u64;
        Ok(())
    }

    pub async fn finish(mut self) -> Result<(), String> {
        let data_bytes = u32::try_from(self.data_bytes)
            .map_err(|_| "recording is too large for a 32-bit WAV header".to_string())?;
        let riff_size = data_bytes
            .checked_add(36)
            .ok_or_else(|| "recording is too large for a WAV header".to_string())?;

        let mut header = Vec::with_capacity(44);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&riff_size.to_le_bytes());
        header.extend_from_slice(b"WAVE");
        header.extend_from_slice(b"fmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes()); // PCM
        header.extend_from_slice(&1u16.to_le_bytes()); // mono
        header.extend_from_slice(&OUTPUT_SAMPLE_RATE.to_le_bytes());
        header.extend_from_slice(&(OUTPUT_SAMPLE_RATE * 2).to_le_bytes());
        header.extend_from_slice(&2u16.to_le_bytes()); // block align
        header.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        header.extend_from_slice(b"data");
        header.extend_from_slice(&data_bytes.to_le_bytes());
        debug_assert_eq!(header.len(), 44);

        self.file
            .seek(SeekFrom::Start(0))
            .await
            .map_err(|error| format!("seek wav header: {error}"))?;
        self.file
            .write_all(&header)
            .await
            .map_err(|error| format!("patch wav header: {error}"))?;
        self.file
            .flush()
            .await
            .map_err(|error| format!("flush wav: {error}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_card_frame_sizes() {
        assert_eq!(normalized_frame_bytes(0), 80);
        assert_eq!(normalized_frame_bytes(40), 40);
        assert_eq!(normalized_frame_bytes(80), 80);
        assert_eq!(normalized_frame_bytes(99_999), 320);
    }

    #[test]
    fn names_use_timestamp_and_fall_back_to_device_name() {
        let title = recording_card_title("c84714.raw", 1763300000);
        assert_ne!(title, "c84714.raw");
        assert!(title.contains('-'));
        assert!(title.contains(':'));
        assert!(!title.contains('：'));

        assert_eq!(recording_card_title("c84714.raw", 0), "c84714.raw");
        assert_eq!(suggested_download_name("c84714.raw", 0, "wav"), "c84714.wav");
        assert!(suggested_download_name("c84714.raw", 1763300000, "wav").ends_with(".wav"));
    }

    #[test]
    fn downmixes_stereo() {
        assert_eq!(stereo_to_mono(&[100, -100, 200, -200, 10, 20]), vec![0, 0, 15]);
    }

    #[tokio::test]
    async fn writes_valid_wav_header() {
        let path = std::env::temp_dir().join(format!(
            "lynse-card-wav-test-{}.wav",
            std::process::id()
        ));
        let mut writer = WavWriter::create(&path).await.expect("create wav");
        writer
            .write_samples(&[0i16; 320])
            .await
            .expect("write pcm");
        writer.finish().await.expect("finish wav");

        let bytes = std::fs::read(&path).expect("read wav");
        let _ = std::fs::remove_file(&path);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[12..16], b"fmt ");
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 36 + 640);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 640);
        assert_eq!(bytes.len(), 44 + 640);
    }
}
