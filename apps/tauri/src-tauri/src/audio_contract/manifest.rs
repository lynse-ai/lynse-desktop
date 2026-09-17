//! Versioned track manifest (`tracks.json`) written into every session
//! directory.
//!
//! **Frozen schema** — shared with the macOS capture sidecar
//! (`audio-capture/Sources/AudioCaptureCore/TrackManifest.swift` writes the
//! identical shape, and its comment freezes these field names):
//!
//! ```json
//! {
//!   "version": 1,
//!   "engine": "webrtc-aec3-1.3",
//!   "sampleRate": 48000,
//!   "tracks": [
//!     { "id": "mic_raw", "file": "mic_raw.wav", "role": "mic",
//!       "processed": false, "sampleRate": 48000, "channels": 1 }
//!   ],
//!   "degradedIntervalsMs": [[1200, 1500]]
//! }
//! ```
//!
//! The Windows engine adds optional, forward-compatible fields (`sessionId`,
//! `createdAt`, `devices`, `gaps`, per-track `bitsPerSample`/`sampleFormat`)
//! that the macOS writer does not emit; readers on both sides must default
//! missing additive fields.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{PROCESSING_SAMPLE_RATE, RECOGNITION_SAMPLE_RATE};

pub const MANIFEST_VERSION: u32 = 1;
/// Frozen file name (the macOS sidecar writes the same file).
pub const MANIFEST_FILE: &str = "tracks.json";

/// Logical source. Fixed mapping, never rewritten by speaker diarisation or
/// models: mic → 本机/local, system → 远端/remote.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackRole {
    Mic,
    System,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackEntry {
    /// Frozen ids: `mic_raw`, `system_raw`, `mic_processed`, `system_processed`.
    pub id: String,
    pub file: String,
    pub role: TrackRole,
    pub processed: bool,
    pub sample_rate: u32,
    pub channels: u16,
    /// Additive (Windows): 16 — raw tracks are archived as 16-bit PCM so both
    /// platforms store byte-identical formats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bits_per_sample: Option<u16>,
    /// Additive (Windows): `int`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_format: Option<String>,
}

impl TrackEntry {
    /// Frozen track layout for a dual-channel session (mirrors the macOS
    /// `TrackManifest.dualChannel` table exactly).
    pub fn dual_channel_tracks() -> Vec<Self> {
        let entry = |id: &str, file: &str, role: TrackRole, processed: bool, rate: u32, channels: u16| Self {
            id: id.to_owned(),
            file: file.to_owned(),
            role,
            processed,
            sample_rate: rate,
            channels,
            bits_per_sample: Some(16),
            sample_format: Some("int".to_owned()),
        };
        vec![
            entry("mic_raw", "mic_raw.wav", TrackRole::Mic, false, PROCESSING_SAMPLE_RATE, 1),
            entry("system_raw", "system_raw.wav", TrackRole::System, false, PROCESSING_SAMPLE_RATE, 2),
            entry(
                "mic_processed",
                "mic_processed.wav",
                TrackRole::Mic,
                true,
                RECOGNITION_SAMPLE_RATE,
                1,
            ),
            entry(
                "system_processed",
                "system.wav",
                TrackRole::System,
                false,
                RECOGNITION_SAMPLE_RATE,
                1,
            ),
        ]
    }
}

/// Half-open `[start_ms, end_ms)` span where the microphone could not be
/// echo-cancelled (reference lost, engine frame failure). Adjacent spans are
/// merged by the writer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradedInterval {
    pub start_ms: u64,
    pub end_ms: u64,
}

impl DegradedInterval {
    pub fn new(start_ms: u64, end_ms: u64) -> Self {
        Self { start_ms, end_ms }
    }

    pub fn to_pair(&self) -> [u64; 2] {
        [self.start_ms, self.end_ms]
    }
}

/// Additive (Windows) gap bookkeeping: every padded span on any track with
/// its cause. The macOS writer does not emit these yet.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapRecord {
    pub track: String,
    pub start_ms: u64,
    pub end_ms: u64,
    /// `device_reconnect` | `device_position_jump` | `timestamp_error` |
    /// `capture_gap`.
    pub reason: String,
}

/// Additive (Windows): the endpoints actually used. `endpointId` is the
/// stable WASAPI id — never just the friendly name.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    #[serde(default)]
    pub endpoint_id: String,
    #[serde(default)]
    pub name: String,
    /// True when the mic stream avoided driver-side effects (RAW mode).
    #[serde(default)]
    pub raw_mode: bool,
    /// False when the engine had to fall back from the requested device.
    #[serde(default = "default_true")]
    pub as_requested: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic: Option<DeviceInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<DeviceInfo>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackManifest {
    pub version: u32,
    /// Frozen engine id (`webrtc-aec3-1.3` for the vendored AEC3; the
    /// correlation-gate fallback reports its own id).
    pub engine: String,
    pub sample_rate: u32,
    pub tracks: Vec<TrackEntry>,
    #[serde(default)]
    pub degraded_intervals_ms: Vec<[u64; 2]>,
    // ---- additive, Windows-writer-only (readers default them) ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devices: Option<Devices>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gaps: Vec<GapRecord>,
}

impl TrackManifest {
    pub fn dual_channel(session_id: &str, created_at: &str, engine: String) -> Self {
        Self {
            version: MANIFEST_VERSION,
            engine,
            sample_rate: PROCESSING_SAMPLE_RATE,
            tracks: TrackEntry::dual_channel_tracks(),
            degraded_intervals_ms: Vec::new(),
            session_id: Some(session_id.to_owned()),
            created_at: Some(created_at.to_owned()),
            devices: Some(Devices::default()),
            gaps: Vec::new(),
        }
    }

    /// The `dual_channel = false` rollback shape: both sources record their
    /// 16 kHz tracks directly (no AEC, no raw tracks) — the legacy pipeline
    /// layout, engine "none".
    pub fn dual_legacy(session_id: &str, created_at: &str) -> Self {
        let entry = |id: &str, file: &str, r: TrackRole| TrackEntry {
            id: id.to_owned(),
            file: file.to_owned(),
            role: r,
            processed: false,
            sample_rate: RECOGNITION_SAMPLE_RATE,
            channels: 1,
            bits_per_sample: Some(16),
            sample_format: Some("int".to_owned()),
        };
        Self {
            version: MANIFEST_VERSION,
            engine: "none".to_owned(),
            sample_rate: PROCESSING_SAMPLE_RATE,
            tracks: vec![
                entry("mic", "mic.wav", TrackRole::Mic),
                entry("system_processed", "system.wav", TrackRole::System),
            ],
            degraded_intervals_ms: Vec::new(),
            session_id: Some(session_id.to_owned()),
            created_at: Some(created_at.to_owned()),
            devices: Some(Devices::default()),
            gaps: Vec::new(),
        }
    }

    /// Mic-only (or system-only) session: no canceller runs and only the
    /// involved track exists (unprocessed).
    pub fn single_source(session_id: &str, created_at: &str, role: TrackRole) -> Self {
        let entry = |id: &str, file: &str, r: TrackRole| TrackEntry {
            id: id.to_owned(),
            file: file.to_owned(),
            role: r,
            processed: false,
            sample_rate: RECOGNITION_SAMPLE_RATE,
            channels: 1,
            bits_per_sample: Some(16),
            sample_format: Some("int".to_owned()),
        };
        let tracks = match role {
            TrackRole::Mic => vec![entry("mic", "mic.wav", TrackRole::Mic)],
            TrackRole::System => vec![entry("system_processed", "system.wav", TrackRole::System)],
        };
        Self {
            version: MANIFEST_VERSION,
            engine: "none".to_owned(),
            sample_rate: PROCESSING_SAMPLE_RATE,
            tracks,
            degraded_intervals_ms: Vec::new(),
            session_id: Some(session_id.to_owned()),
            created_at: Some(created_at.to_owned()),
            devices: Some(Devices::default()),
            gaps: Vec::new(),
        }
    }

    pub fn track(&self, id: &str) -> Option<&TrackEntry> {
        self.tracks.iter().find(|track| track.id == id)
    }

    pub fn track_mut(&mut self, id: &str) -> Option<&mut TrackEntry> {
        self.tracks.iter_mut().find(|track| track.id == id)
    }

    /// Record an AEC-degraded span (adjacent spans merge, mirroring the
    /// macOS processor).
    pub fn mark_degraded(&mut self, start_ms: u64, end_ms: u64) {
        if end_ms <= start_ms {
            return;
        }
        if let Some(last) = self.degraded_intervals_ms.last_mut() {
            if last[1] >= start_ms {
                last[1] = last[1].max(end_ms);
                return;
            }
        }
        self.degraded_intervals_ms.push([start_ms, end_ms]);
    }

    /// Record a padded capture gap on a track (adjacent spans on the same
    /// track merge).
    pub fn record_gap(&mut self, gap: GapRecord) {
        if gap.end_ms <= gap.start_ms {
            return;
        }
        if let Some(last) = self.gaps.last_mut() {
            if last.track == gap.track && last.end_ms >= gap.start_ms {
                last.end_ms = last.end_ms.max(gap.end_ms);
                return;
            }
        }
        self.gaps.push(gap);
    }
}

pub fn write_manifest(path: &Path, manifest: &TrackManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

pub fn read_manifest(path: &Path) -> Result<TrackManifest, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frozen macOS writer shape must parse here byte-for-byte.
    #[test]
    fn parses_the_frozen_macos_writer_output() {
        let json = r#"{
            "version": 1,
            "engine": "webrtc-aec3-1.3",
            "sampleRate": 48000,
            "tracks": [
                {"id": "mic_raw", "file": "mic_raw.wav", "role": "mic", "processed": false, "sampleRate": 48000, "channels": 1},
                {"id": "system_raw", "file": "system_raw.wav", "role": "system", "processed": false, "sampleRate": 48000, "channels": 2},
                {"id": "mic_processed", "file": "mic_processed.wav", "role": "mic", "processed": true, "sampleRate": 16000, "channels": 1},
                {"id": "system_processed", "file": "system.wav", "role": "system", "processed": false, "sampleRate": 16000, "channels": 1}
            ],
            "degradedIntervalsMs": [[1200, 1500]]
        }"#;
        let manifest: TrackManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.engine, "webrtc-aec3-1.3");
        assert_eq!(manifest.tracks.len(), 4);
        assert_eq!(manifest.degraded_intervals_ms, vec![[1200, 1500]]);
        assert!(manifest.track("mic_processed").unwrap().processed);
    }

    #[test]
    fn manifest_round_trips_with_additive_fields() {
        let mut manifest = TrackManifest::dual_channel("s-1", "now", "gate".to_owned());
        manifest.devices.as_mut().unwrap().mic = Some(DeviceInfo {
            endpoint_id: "{0.0.1.00000000}".to_owned(),
            name: "Microphone".to_owned(),
            raw_mode: true,
            as_requested: true,
        });
        manifest.mark_degraded(1_000, 1_100);
        manifest.record_gap(GapRecord {
            track: "system_raw".to_owned(),
            start_ms: 2_000,
            end_ms: 2_300,
            reason: "device_position_jump".to_owned(),
        });
        let parsed: TrackManifest =
            serde_json::from_str(&serde_json::to_string(&manifest).unwrap()).unwrap();
        assert_eq!(parsed, manifest);
    }

    #[test]
    fn degraded_and_gap_spans_coalesce() {
        let mut manifest = TrackManifest::dual_channel("s-1", "now", "gate".to_owned());
        manifest.mark_degraded(1_000, 1_100);
        manifest.mark_degraded(1_100, 1_400);
        manifest.mark_degraded(3_000, 3_100);
        assert_eq!(manifest.degraded_intervals_ms, vec![[1_000, 1_400], [3_000, 3_100]]);

        manifest.record_gap(GapRecord {
            track: "system_raw".to_owned(),
            start_ms: 5_000,
            end_ms: 5_100,
            reason: "device_reconnect".to_owned(),
        });
        manifest.record_gap(GapRecord {
            track: "system_raw".to_owned(),
            start_ms: 5_100,
            end_ms: 5_400,
            reason: "device_reconnect".to_owned(),
        });
        manifest.record_gap(GapRecord {
            track: "mic_raw".to_owned(),
            start_ms: 5_000,
            end_ms: 5_200,
            reason: "device_reconnect".to_owned(),
        });
        assert_eq!(manifest.gaps.len(), 2);
        assert_eq!(manifest.gaps[0].end_ms, 5_400);
    }

    #[test]
    fn frozen_track_table_matches_macos_side() {
        let tracks = TrackEntry::dual_channel_tracks();
        let find = |id: &str| tracks.iter().find(|t| t.id == id).unwrap();
        assert_eq!(find("mic_raw").file, "mic_raw.wav");
        assert_eq!(find("system_raw").channels, 2);
        assert!(find("mic_processed").processed);
        // The 16 kHz system track is deliberately NOT marked processed: it is
        // the reference mixdown as recognised.
        assert!(!find("system_processed").processed);
        assert_eq!(find("system_processed").file, "system.wav");
    }
}
