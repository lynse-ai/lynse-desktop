//! NewView recording-card BLE wire protocol.
//!
//! Frame formats implemented here come from the in-house protocol definition
//! (`SDK/lynse-hardware-sdk/first-device/newview/protocol-definition-v1.json`),
//! which was verified against both the iOS and Android vendor SDKs. Pieces
//! that the vendor has not published as a stable reference (file-transfer
//! packet framing) are isolated in `transfer.rs` and marked accordingly.

use serde::{Deserialize, Serialize};

/// Primary BLE service advertised by NewView recording cards.
pub const SERVICE_UUID: uuid::Uuid = uuid::Uuid::from_u128(0x0606_8d0c_6b97_11ef_b864_0240_ac12_0002);
/// Characteristic the app writes control frames to.
pub const WRITE_CHARACTERISTIC_UUID: uuid::Uuid =
    uuid::Uuid::from_u128(0x0606_8d1c_6b97_11ef_b864_0241_ac12_0002);
/// Characteristic the device pushes control responses, live audio and file
/// data through.
pub const NOTIFY_CHARACTERISTIC_UUID: uuid::Uuid =
    uuid::Uuid::from_u128(0x0606_8d2c_6b97_11ef_b864_0242_ac12_0002);

/// ASCII marker every device advertisement carries, inside its manufacturer data.
pub const ADVERTISEMENT_MARKER: &[u8] = b"NvEasy";

/// Minimum gap between BLE writes; the vendor SDK rate limits to the same value.
/// (Control frames in this app are single, spaced writes; kept for future
/// higher-rate writers.)
#[allow(dead_code)]
pub const MIN_WRITE_INTERVAL_MS: u64 = 20;

const RESPONSE_PREFIX: &[u8] = b"*DEV#";
const STREAM_PREFIX: &[u8] = b"*DEV#stream#";
const SDKKEY_PREFIX: &[u8] = b"*DEV#sdkkey#";
const APPKEY_PREFIX: &[u8] = b"*DEV#appkey#";

/// Recording modes supported by the card firmware.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordMode {
    Meeting,
    Call,
    Media,
}

impl RecordMode {
    pub fn as_code(self) -> i64 {
        match self {
            RecordMode::Meeting => 0,
            RecordMode::Call => 1,
            RecordMode::Media => 2,
        }
    }
}

/// Opus stream parameters advertised by the device (packed 32-bit field or
/// derived from sample-rate codes on older protocol generations).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OpusFormat {
    pub sample_rate_hz: i64,
    pub channels: i64,
    /// Compressed bytes per Opus packet (40 = 20 ms, 80 = 40 ms).
    pub frame_bytes: i64,
}

impl Default for OpusFormat {
    fn default() -> Self {
        Self {
            sample_rate_hz: 16_000,
            channels: 2,
            frame_bytes: 80,
        }
    }
}

impl OpusFormat {
    /// Decode the packed format field sent by protocol >= 24 devices.
    ///
    /// Bit layout (MSB first): 31..26 sample rate in kHz, 25..23 channels,
    /// 22..16 frame duration ×2 (ms), 15..6 bitrate kbps, 5..0 reserved.
    /// Compressed bytes ≈ 2 per millisecond (40 bytes ≈ 20 ms, 80 ≈ 40 ms),
    /// so the frame-byte count equals the ×2 duration value.
    pub fn from_packed(packed: u32) -> Self {
        let sample_rate_khz = ((packed >> 26) & 0x3f) as i64;
        let channels = ((packed >> 23) & 0x07) as i64;
        let frame_duration_x2 = ((packed >> 16) & 0x7f) as i64;
        Self {
            sample_rate_hz: if sample_rate_khz > 0 { sample_rate_khz * 1000 } else { 16_000 },
            channels: channels.clamp(1, 2),
            frame_bytes: if (20..=320).contains(&frame_duration_x2) {
                frame_duration_x2
            } else {
                80
            },
        }
    }

    pub fn from_sample_rate_code(code: i64, channel_code: i64) -> Self {
        Self {
            sample_rate_hz: match code {
                0 => 8_000,
                2 => 24_000,
                _ => 16_000,
            },
            channels: if channel_code == 1 { 2 } else { 1 },
            frame_bytes: 80,
        }
    }
}

/// Device facts parsed from the BLE advertisement manufacturer data.
#[derive(Clone, Debug, Serialize)]
pub struct AdvertisementFacts {
    pub device_code: String,
    pub protocol_version: u8,
    pub ability_mask: u32,
    pub sku: Option<String>,
}

impl AdvertisementFacts {
    pub fn has_ability(&self, bit: u32) -> bool {
        self.ability_mask & (1 << bit) != 0
    }

    pub fn has_meeting_recording(&self) -> bool {
        self.has_ability(29)
    }

    #[allow(dead_code)] // capability surface documented for future UI gating
    pub fn has_pause_resume(&self) -> bool {
        self.has_ability(17)
    }

    #[allow(dead_code)] // capability surface documented for future UI gating
    pub fn has_recording_mark(&self) -> bool {
        self.has_ability(18)
    }

    pub fn has_local_storage(&self) -> bool {
        self.has_ability(31)
    }
}

/// Parse the manufacturer-data payload (without the 2-byte company id, which
/// btleplug reports separately). Layout per the verified protocol definition:
/// `[deviceCode(3, ascii)][...][NvEasy marker]` and, relative to the marker:
/// ability mask at 7..11 (big endian u32), protocol version at 11, sku at
/// 12..14 and an "NV" signature at 14..16 for protocol >= 21.
pub fn parse_advertisement(manufacturer_data: &[u8]) -> Option<AdvertisementFacts> {
    let marker = manufacturer_data
        .windows(ADVERTISEMENT_MARKER.len())
        .position(|window| window == ADVERTISEMENT_MARKER)?;
    if manufacturer_data.len() < marker + 12 {
        return None;
    }
    let protocol_version = manufacturer_data[marker + 11];
    let ability_mask = u32::from_be_bytes([
        manufacturer_data[marker + 7],
        manufacturer_data[marker + 8],
        manufacturer_data[marker + 9],
        manufacturer_data[marker + 10],
    ]);
    if protocol_version >= 21 {
        if manufacturer_data.len() < marker + 16 {
            return None;
        }
        if &manufacturer_data[marker + 14..marker + 16] != b"NV" {
            return None;
        }
    }
    let device_code_bytes = manufacturer_data.get(..3)?;
    let device_code = String::from_utf8_lossy(device_code_bytes).into_owned();
    if !device_code.bytes().all(|byte| (32..=126).contains(&byte)) {
        return None;
    }
    let sku = if protocol_version >= 21 && manufacturer_data.len() >= marker + 14 {
        Some(String::from_utf8_lossy(&manufacturer_data[marker + 12..marker + 14]).into_owned())
    } else {
        None
    };
    Some(AdvertisementFacts {
        device_code,
        protocol_version,
        ability_mask,
        sku,
    })
}

/// Build a `*APP#<name>#` control frame.
pub fn control_frame(name: &str) -> Vec<u8> {
    let mut frame = Vec::with_capacity(name.len() + 7);
    frame.extend_from_slice(b"*APP#");
    frame.extend_from_slice(name.as_bytes());
    frame.push(b'#');
    frame
}

/// Build a record control frame: `*APP#record#{status}#{mode}#{rate}#`.
/// status: 0 stop, 1 start, 2 pause, 3 resume.
pub fn record_frame(status: u8, mode: RecordMode, sample_rate_code: u8) -> Vec<u8> {
    control_frame(&format!("record#{status}#{}#{sample_rate_code}", mode.as_code()))
}

/// Build the authentication frame for the device's protocol generation.
///
/// * protocol < 21: ASCII manufacturer code inside an `*APP#sdkkey#` frame.
/// * protocol >= 21: a 16-byte application key after `*APP#appkey#`. The
///   encryption algorithm lives in the vendor SDK; until the vendor supplies
///   it, the code bytes are zero-padded/truncated to 16 bytes. This is the
///   single integration point to drop the real algorithm into.
pub fn auth_frame(protocol_version: u8, manufacturer_code: &str) -> Vec<u8> {
    let mut frame = Vec::new();
    if protocol_version >= 21 {
        frame.extend_from_slice(b"*APP#appkey#");
        let bytes = manufacturer_code.as_bytes();
        let mut key = [0u8; 16];
        let length = bytes.len().min(16);
        key[..length].copy_from_slice(&bytes[..length]);
        frame.extend_from_slice(&key);
    } else {
        frame.extend_from_slice(b"*APP#sdkkey#");
        frame.extend_from_slice(manufacturer_code.as_bytes());
        frame.push(b'#');
    }
    frame
}

/// True when the notification is an authentication response.
pub fn is_auth_response(data: &[u8]) -> bool {
    data.starts_with(SDKKEY_PREFIX) || data.starts_with(APPKEY_PREFIX)
}

/// A parsed `*DEV#` control response. Field 0 is the literal `*DEV`, field 1
/// the response name, and the remaining fields are `#`-separated values.
#[derive(Clone, Debug)]
pub struct ControlResponse {
    pub name: String,
    pub fields: Vec<String>,
}

impl ControlResponse {
    pub fn field(&self, index: usize) -> Option<&str> {
        self.fields.get(index).map(String::as_str)
    }

    pub fn number(&self, index: usize) -> Option<i64> {
        self.field(index)?.parse().ok()
    }
}

/// Split a notification into a control response (if it is one).
pub fn parse_control_response(data: &[u8]) -> Option<ControlResponse> {
    if !data.starts_with(RESPONSE_PREFIX) {
        return None;
    }
    let text = String::from_utf8_lossy(&data[..data.len().min(2048)]).into_owned();
    let fields: Vec<String> = text
        .split('#')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    if fields.len() < 2 {
        return None;
    }
    Some(ControlResponse {
        name: fields[1].clone(),
        fields,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordStatus {
    Idle,
    Recording,
    Paused,
}

#[derive(Clone, Debug)]
pub struct RecordStateUpdate {
    pub status: RecordStatus,
    pub mode: Option<RecordMode>,
    pub opus_format: Option<OpusFormat>,
    /// Duration in ms when the device reports it.
    pub duration_ms: Option<u64>,
    pub file_sn: Option<i64>,
    pub file_name: Option<String>,
}

/// Decode a `*DEV#record#...#` response covering all three protocol
/// generations documented in the protocol definition.
pub fn parse_record_response(response: &ControlResponse) -> Option<RecordStateUpdate> {
    let status_code = response.number(2)?;
    let status = match status_code {
        1 | 3 => RecordStatus::Recording,
        2 => RecordStatus::Paused,
        0 => RecordStatus::Idle,
        _ => return None,
    };
    let mode_code = response.number(3).unwrap_or(0);
    let mode = match mode_code {
        0 => Some(RecordMode::Meeting),
        1 => Some(RecordMode::Call),
        2 => Some(RecordMode::Media),
        _ => None,
    };
    // Wire layout (protocol definition):
    //   <21:  *DEV#record#{status}#{mode}#
    //  20-23: *DEV#record#{status}#{mode}#{rateCode}#{channelCode}#{ms}[#{sn}#{name}]#
    //   >=24: *DEV#record#{status}#{mode}#{packed}#{recordMode}#{ms}[#{sn}#{name}]#
    // Field 4 is a packed u32 for generation >= 24 but a 0..=2 sample-rate
    // code for 20..23 — small values are disambiguated as the legacy code.
    let field4 = response.field(4).and_then(|field| field.parse::<u32>().ok());
    let opus_format = match field4 {
        Some(code @ 0..=2) => Some(OpusFormat::from_sample_rate_code(
            code as i64,
            response.number(5).unwrap_or(1),
        )),
        Some(packed) => Some(OpusFormat::from_packed(packed)),
        None => None,
    };
    let duration_ms = response.number(6).filter(|value| *value >= 0).map(|value| value as u64);
    let file_sn = response.number(7);
    let file_name = response.field(8).map(str::to_owned);
    Some(RecordStateUpdate {
        status,
        mode,
        opus_format,
        duration_ms,
        file_sn,
        file_name,
    })
}

#[derive(Clone, Debug)]
pub struct ReassembledStream {
    pub payload: Vec<u8>,
    #[allow(dead_code)] // consumed by tests and future UI gap indicators
    pub discontinuity: bool,
}

/// Reassembles live-audio frames from BLE notifications. A frame starts with
/// the `*DEV#stream#{total}#{frameBytes}#` header; the remaining bytes arrive
/// in subsequent notifications without any header until `total` is reached.
#[derive(Default)]
pub struct StreamReassembler {
    buffer: Vec<u8>,
    expected: usize,
    frame_bytes: usize,
    discontinuous: bool,
}

impl StreamReassembler {
    #[allow(dead_code)] // used when re-entering record mode mid-session
    pub fn reset(&mut self) {
        *self = Self {
            discontinuous: self.discontinuous,
            ..Self::default()
        };
    }

    /// Feed one notification; returns a complete audio payload when the frame
    /// finished arriving.
    pub fn feed(&mut self, data: &[u8]) -> Option<ReassembledStream> {
        if data.starts_with(STREAM_PREFIX) {
            if let Some((total, frame_bytes, rest)) = parse_stream_header(data) {
                self.expected = total;
                self.frame_bytes = frame_bytes;
                self.buffer = rest.to_vec();
                return self.finish();
            }
            self.mark_discontinuous();
            return None;
        }
        if self.expected == 0 {
            // Stray binary chunk without a stream header — drop it.
            return None;
        }
        if self.buffer.len() + data.len() > self.expected {
            self.mark_discontinuous();
            return None;
        }
        self.buffer.extend_from_slice(data);
        self.finish()
    }

    fn mark_discontinuous(&mut self) {
        *self = Self::default();
        self.discontinuous = true;
    }

    fn finish(&mut self) -> Option<ReassembledStream> {
        if self.expected == 0 || self.buffer.len() < self.expected {
            return None;
        }
        if self.frame_bytes == 0 || self.expected % self.frame_bytes != 0 {
            self.mark_discontinuous();
            return None;
        }
        let payload = std::mem::take(&mut self.buffer);
        let discontinuity = std::mem::replace(&mut self.discontinuous, false);
        self.expected = 0;
        self.frame_bytes = 0;
        Some(ReassembledStream {
            payload,
            discontinuity,
        })
    }
}

fn parse_stream_header(data: &[u8]) -> Option<(usize, usize, &[u8])> {
    let mut separators = [0usize; 4];
    let mut count = 0usize;
    for (index, byte) in data.iter().enumerate().take(64) {
        if *byte == b'#' {
            separators[count] = index;
            count += 1;
            if count == 4 {
                break;
            }
        }
    }
    if count < 4 {
        return None;
    }
    let total = std::str::from_utf8(&data[separators[1] + 1..separators[2]]).ok()?.parse().ok()?;
    let frame = std::str::from_utf8(&data[separators[2] + 1..separators[3]]).ok()?.parse().ok()?;
    if total == 0 || frame == 0 || total > 8 * 1024 * 1024 || total % frame != 0 {
        return None;
    }
    Some((total, frame, &data[separators[3] + 1..]))
}

/// Battery percentages reported by `*DEV#battery#{left}#{right}#{main}#`.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Battery {
    pub left: i64,
    pub right: i64,
    pub main: i64,
}

impl Battery {
    #[allow(dead_code)] // kept for battery display refinements
    pub fn main_percent(&self) -> i64 {
        self.left.max(self.right).max(self.main)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_advertisement_fields() {
        let mut data = Vec::new();
        data.extend_from_slice(b"NV1"); // device code
        data.extend_from_slice(b"xxxx"); // vendor padding before marker
        let marker_start = data.len();
        data.extend_from_slice(b"NvEasy");
        data.push(0); // marker-relative filler up to offset 7
        data.extend_from_slice(&[0, 0, 0, 0]);
        data[marker_start + 7] = 1 << 5; // ability bit 29 (meeting recording)
        data.push(24); // protocol version at marker offset 11
        data.extend_from_slice(b"E1"); // sku
        data.extend_from_slice(b"NV"); // signature

        let facts = parse_advertisement(&data).expect("advertisement parses");
        assert_eq!(facts.device_code, "NV1");
        assert_eq!(facts.protocol_version, 24);
        assert_eq!(facts.sku.as_deref(), Some("E1"));
        assert!(facts.has_meeting_recording());
        assert!(!facts.has_recording_mark());
    }

    #[test]
    fn rejects_advertisement_without_marker() {
        assert!(parse_advertisement(b"12345678901234567890").is_none());
    }

    #[test]
    fn builds_control_and_record_frames() {
        assert_eq!(control_frame("battery"), b"*APP#battery#".to_vec());
        assert_eq!(
            record_frame(1, RecordMode::Meeting, 1),
            b"*APP#record#1#0#1#".to_vec()
        );
    }

    #[test]
    fn builds_auth_frames_per_generation() {
        assert_eq!(
            auth_frame(20, "abcd"),
            b"*APP#sdkkey#abcd#".to_vec()
        );
        let frame = auth_frame(24, "abcd");
        assert_eq!(&frame[..12], b"*APP#appkey#");
        assert_eq!(frame.len(), 12 + 16);
        assert_eq!(&frame[12..16], b"abcd");
        assert_eq!(&frame[16..], &[0u8; 12]);
    }

    #[test]
    fn parses_battery_response() {
        let response = parse_control_response(b"*DEV#battery#80#70#55#").expect("battery frame");
        assert_eq!(response.name, "battery");
        assert_eq!(response.number(2), Some(80));
    }

    #[test]
    fn parses_record_response_protocol24() {
        // status=1 (recording), mode=0 (meeting), packed opus format for
        // 16 kHz / 2ch / 20ms, dial mode, duration, file sn + name.
        let packed = (16u32 << 26) | (2u32 << 23) | (40u32 << 16);
        let text = format!("*DEV#record#1#0#{packed}#0#12345#7#1730000000#");
        let response = parse_control_response(text.as_bytes()).expect("record frame");
        let update = parse_record_response(&response).expect("record update");
        assert_eq!(update.status, RecordStatus::Recording);
        assert_eq!(update.mode, Some(RecordMode::Meeting));
        let format = update.opus_format.expect("opus format");
        assert_eq!(format.sample_rate_hz, 16_000);
        assert_eq!(format.channels, 2);
        assert_eq!(format.frame_bytes, 40);
        assert_eq!(update.duration_ms, Some(12345));
        assert_eq!(update.file_sn, Some(7));
        assert_eq!(update.file_name.as_deref(), Some("1730000000"));
    }

    #[test]
    fn parses_record_response_protocol20() {
        // rateCode=1 (16 kHz), channelCode=1 (stereo), no file info.
        let response = parse_control_response(b"*DEV#record#1#0#1#1#500#").expect("record frame");
        let update = parse_record_response(&response).expect("record update");
        assert_eq!(update.status, RecordStatus::Recording);
        let format = update.opus_format.expect("opus format");
        assert_eq!(format.sample_rate_hz, 16_000);
        assert_eq!(format.channels, 2);
        assert_eq!(update.duration_ms, Some(500));
        assert_eq!(update.file_sn, None);
    }

    #[test]
    fn reassembles_stream_frames_across_notifications() {
        let mut reassembler = StreamReassembler::default();
        // 160-byte frame announced; header packet carries the first 80 bytes.
        let header = b"*DEV#stream#160#80#";
        assert!(reassembler.feed(header).is_none());
        let chunk: Vec<u8> = (0..80u8).collect();
        assert!(reassembler.feed(&chunk).is_none());
        let done = reassembler.feed(&chunk).expect("completes after second chunk");
        assert_eq!(done.payload.len(), 160);
        assert!(!done.discontinuity);
        // After completion the reassembler is idle again.
        assert!(reassembler.feed(&chunk).is_none());
    }

    #[test]
    fn reassembler_marks_discontinuity_on_overflow() {
        let mut reassembler = StreamReassembler::default();
        assert!(reassembler.feed(b"*DEV#stream#160#80#ab").is_none());
        let oversized = vec![0u8; 200];
        let result = reassembler.feed(&oversized);
        assert!(result.is_none());
        // The buffer was reset; a fresh frame must start with a new header.
        assert!(reassembler.feed(b"*DEV#stream#160#80#").is_none());
        let chunk = vec![7u8; 160];
        let done = reassembler.feed(&chunk).expect("fresh frame completes");
        assert!(done.discontinuity);
    }
}
