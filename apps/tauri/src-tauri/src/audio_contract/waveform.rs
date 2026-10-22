use super::wav::inspect;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const BARS: usize = 256;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    pub peaks: Vec<f32>,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UploadedWaveform {
    pub path: String,
    pub waveform: Waveform,
}

impl UploadedWaveform {
    pub fn for_path(self, path: &str) -> Option<Waveform> {
        (self.path == path).then_some(self.waveform)
    }
}

#[derive(Serialize, Deserialize)]
struct Cache {
    version: u32,
    bytes: u64,
    modified_nanos: u128,
    waveform: Waveform,
}

/// The capture sidecar accumulates 200 ms peaks from the actual playback
/// master. Seeding these avoids rescanning hours of audio at stop time.
pub fn seed_from_windows(path: &Path, windows: &[(u64, f32)]) -> Result<(), String> {
    if windows.is_empty() {
        return Ok(());
    }
    let info = inspect(path)?;
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let duration_ms = info.frames() * 1000 / u64::from(info.format.sample_rate.max(1));
    let mut peaks = vec![0.0f32; BARS];
    for &(at, peak) in windows {
        let index =
            (at.saturating_mul(BARS as u64) / duration_ms.max(1)).min((BARS - 1) as u64) as usize;
        if peak.is_finite() {
            peaks[index] = peaks[index].max(peak.clamp(0.0, 1.0));
        }
    }
    let cache = Cache {
        version: 1,
        bytes: metadata.len(),
        modified_nanos: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        waveform: Waveform { peaks, duration_ms },
    };
    crate::atomic_write(
        &path.with_extension("wav.peaks.json"),
        &serde_json::to_vec(&cache).map_err(|e| e.to_string())?,
    )
}

/// Reads bounded chunks of PCM instead of decoding the complete meeting into
/// a browser AudioBuffer. Every channel contributes, including right-only audio.
pub fn cached(path: &Path) -> Result<Waveform, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let cache_path = path.with_extension("wav.peaks.json");
    if let Ok(bytes) = fs::read(&cache_path) {
        if let Ok(cache) = serde_json::from_slice::<Cache>(&bytes) {
            if cache.version == 1
                && cache.bytes == metadata.len()
                && cache.modified_nanos == modified_nanos
            {
                return Ok(cache.waveform);
            }
        }
    }
    let waveform = extract(path)?;
    let cache = Cache {
        version: 1,
        bytes: metadata.len(),
        modified_nanos,
        waveform: waveform.clone(),
    };
    if let Ok(bytes) = serde_json::to_vec(&cache) {
        let _ = crate::atomic_write(&cache_path, &bytes);
    }
    Ok(waveform)
}

pub fn extract(path: &Path) -> Result<Waveform, String> {
    let info = inspect(path)?;
    let sample_bytes = usize::from(info.format.bits_per_sample / 8);
    if info.format.sample_rate == 0
        || info.format.channels == 0
        || ![1, 2, 3, 4].contains(&sample_bytes)
    {
        return Err("Unsupported waveform format".into());
    }
    let mut reader =
        BufReader::with_capacity(128 * 1024, File::open(path).map_err(|e| e.to_string())?);
    reader
        .seek(SeekFrom::Start(info.data_offset))
        .map_err(|e| e.to_string())?;
    let total_samples = info.data_bytes / sample_bytes as u64;
    let mut peaks = vec![0.0f32; BARS];
    let mut buffer = vec![0u8; 48 * 1024];
    let mut read_samples = 0u64;
    while read_samples < total_samples {
        let samples =
            (total_samples - read_samples).min((buffer.len() / sample_bytes) as u64) as usize;
        let bytes = &mut buffer[..samples * sample_bytes];
        reader.read_exact(bytes).map_err(|e| e.to_string())?;
        for (index, sample) in bytes.chunks_exact(sample_bytes).enumerate() {
            let amplitude = match (info.format.sample_format, sample_bytes) {
                ("float", 4) => f32::from_le_bytes(sample.try_into().expect("float sample")).abs(),
                (_, 1) => (f32::from(sample[0]) - 128.0).abs() / 128.0,
                (_, 2) => {
                    f32::from(i16::from_le_bytes(sample.try_into().expect("s16 sample"))).abs()
                        / 32768.0
                }
                (_, 3) => {
                    ((i32::from_le_bytes([0, sample[0], sample[1], sample[2]]) >> 8) as f32).abs()
                        / 8388608.0
                }
                (_, 4) => {
                    (i32::from_le_bytes(sample.try_into().expect("s32 sample")) as f32).abs()
                        / 2147483648.0
                }
                _ => return Err("Unsupported waveform format".into()),
            };
            let bar = (((read_samples + index as u64) as u128 * BARS as u128)
                / total_samples.max(1) as u128) as usize;
            if amplitude.is_finite() {
                peaks[bar.min(BARS - 1)] = peaks[bar.min(BARS - 1)].max(amplitude.min(1.0));
            }
        }
        read_samples += samples as u64;
    }
    Ok(Waveform {
        peaks,
        duration_ms: info.frames() * 1000 / u64::from(info.format.sample_rate),
    })
}

#[cfg(test)]
mod tests {
    use super::super::wav::{WavFormat, WavTrackWriter};
    use super::*;

    #[test]
    fn cloud_cache_only_matches_the_uploaded_audio_version() {
        let cache = UploadedWaveform {
            path: "/recording/original-uuid.wav".into(),
            waveform: Waveform {
                peaks: vec![0.5],
                duration_ms: 1000,
            },
        };
        assert!(cache
            .clone()
            .for_path("/recording/edited-uuid.wav")
            .is_none());
        assert_eq!(
            cache
                .for_path("/recording/original-uuid.wav")
                .unwrap()
                .peaks,
            [0.5]
        );
    }

    #[test]
    fn two_hour_recording_uses_capture_peaks_without_decoding_the_file() {
        let directory =
            std::env::temp_dir().join(format!("lynse-long-waveform-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("long.wav");
        let writer = WavTrackWriter::raw(
            &path,
            WavFormat {
                sample_rate: 48000,
                channels: 2,
                bits_per_sample: 16,
                sample_format: "int",
            },
        )
        .unwrap();
        writer.write_i16_at(7_199_990, &[0; 960]).unwrap();
        writer.close().unwrap();
        let windows = [(0, 0.0), (3_600_000, 0.8), (7_199_800, 0.2)];
        seed_from_windows(&path, &windows).unwrap();
        let waveform = cached(&path).unwrap();
        assert_eq!(waveform.duration_ms, 7_200_000);
        assert_eq!(waveform.peaks[BARS / 2], 0.8);
        assert_eq!(waveform.peaks[BARS - 1], 0.2);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn right_channel_and_silence_are_preserved() {
        let directory =
            std::env::temp_dir().join(format!("lynse-waveform-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("audio.wav");
        let writer = WavTrackWriter::raw(
            &path,
            WavFormat {
                sample_rate: 48000,
                channels: 2,
                bits_per_sample: 16,
                sample_format: "int",
            },
        )
        .unwrap();
        let samples = (0..48000)
            .flat_map(|i| [0, if i >= 24000 { 16000 } else { 0 }])
            .collect::<Vec<_>>();
        writer.write_i16_at(0, &samples).unwrap();
        writer.close().unwrap();
        let waveform = cached(&path).unwrap();
        assert_eq!(waveform.duration_ms, 1000);
        assert_eq!(waveform.peaks[0], 0.0);
        assert!(waveform.peaks[BARS - 1] > 0.4);
        assert_eq!(cached(&path).unwrap().peaks, waveform.peaks);
        fs::remove_dir_all(directory).unwrap();
    }
}
