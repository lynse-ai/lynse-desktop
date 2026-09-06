//! Opus decoding for recording-card audio and WAV file production.
//!
//! Card streams and card files are constant-size Opus packets (40 or 80
//! compressed bytes per frame). Decoded PCM is 16 kHz interleaved stereo
//! Int16 (little endian); live feeding and storage use 16 kHz mono Int16.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use opus::{Channels, Decoder};

use super::protocol::OpusFormat;

pub const OUTPUT_SAMPLE_RATE: u32 = 16_000;

/// Streaming decoder that turns a concatenated Opus packet stream into mono
/// PCM samples.
pub struct CardOpusDecoder {
    decoder: Decoder,
    frame_bytes: i64,
    stereo: bool,
    /// Left-over compressed bytes shorter than one packet.
    carry: Vec<u8>,
}

impl CardOpusDecoder {
    pub fn new(format: OpusFormat) -> opus::Result<Self> {
        let stereo = format.channels >= 2;
        let channels = if stereo {
            Channels::Stereo
        } else {
            Channels::Mono
        };
        let decoder = Decoder::new(OUTPUT_SAMPLE_RATE, channels)?;
        Ok(Self {
            decoder,
            frame_bytes: format.frame_bytes.max(1),
            stereo,
            carry: Vec::new(),
        })
    }

    #[allow(dead_code)]
    pub fn frame_bytes(&self) -> i64 {
        self.frame_bytes
    }

    /// Push compressed bytes; returns mono PCM for every complete packet.
    /// Malformed packets decode as silence so one bad BLE notification cannot
    /// take down a whole transfer.
    pub fn push(&mut self, data: &[u8]) -> Vec<i16> {
        let mut buffer = std::mem::take(&mut self.carry);
        buffer.extend_from_slice(data);
        let frame = self.frame_bytes as usize;
        let mut mono: Vec<i16> = Vec::new();
        let mut offset = 0usize;
        while buffer.len() - offset >= frame {
            let packet = &buffer[offset..offset + frame];
            offset += frame;
            mono.extend_from_slice(&self.decode_packet(packet));
        }
        self.carry = buffer.split_off(offset);
        mono
    }

    fn decode_packet(&mut self, packet: &[u8]) -> Vec<i16> {
        // A lost BLE chunk can corrupt packet boundaries; libopus then returns
        // an error and we substitute 20 ms of silence to keep the timeline.
        const SAMPLES_PER_PACKET: usize = OUTPUT_SAMPLE_RATE as usize / 50; // 20 ms
        let channels = if self.stereo { 2 } else { 1 };
        let mut output = [0i16; SAMPLES_PER_PACKET * 2];
        let decoded = self
            .decoder
            .decode(packet, &mut output, false)
            .unwrap_or(SAMPLES_PER_PACKET * channels);
        if self.stereo {
            stereo_to_mono(&output[..decoded]).into_iter().collect()
        } else {
            output[..decoded].to_vec()
        }
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

/// Write mono 16-bit PCM as a 16 kHz RIFF/WAVE file.
pub fn write_wav(path: &Path, mono: &[i16]) -> std::io::Result<()> {
    let file = File::create(path)?;
    let mut writer = BufWriter::new(file);
    let data_bytes = (mono.len() * 2) as u32;
    writer.write_all(b"RIFF")?;
    writer.write_all(&(36 + data_bytes).to_le_bytes())?;
    writer.write_all(b"WAVE")?;
    writer.write_all(b"fmt ")?;
    writer.write_all(&16u32.to_le_bytes())?;
    writer.write_all(&1u16.to_le_bytes())?; // PCM
    writer.write_all(&1u16.to_le_bytes())?; // mono
    writer.write_all(&OUTPUT_SAMPLE_RATE.to_le_bytes())?;
    writer.write_all(&(OUTPUT_SAMPLE_RATE * 2).to_le_bytes())?; // byte rate
    writer.write_all(&2u16.to_le_bytes())?; // block align
    writer.write_all(&16u16.to_le_bytes())?; // bits per sample
    writer.write_all(b"data")?;
    writer.write_all(&data_bytes.to_le_bytes())?;
    for sample in mono {
        writer.write_all(&sample.to_le_bytes())?;
    }
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmixes_stereo() {
        let stereo = [100i16, -100, 200, -200, 10, 20];
        let mono = stereo_to_mono(&stereo);
        assert_eq!(mono, vec![0, 0, 15]);
    }

    #[test]
    fn writes_wav_header() {
        let path = std::env::temp_dir().join(format!("lynse-card-test-{}.wav", std::process::id()));
        write_wav(&path, &[0i16; 320]).expect("wav writes");
        let bytes = std::fs::read(&path).expect("wav reads");
        let _ = std::fs::remove_file(&path);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(bytes.len(), 44 + 640);
    }
}
