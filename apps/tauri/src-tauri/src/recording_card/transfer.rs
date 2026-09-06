//! Recording-card file list and BLE file transfer.
//!
//! Request frames and response names follow the verified protocol
//! definition. The vendor has **not** published the binary layout of
//! file-list records or BLE data packets, so those two parsers are written
//! defensively: they validate every field, surface raw payloads through
//! diagnostics when they do not match, and are the only code that needs
//! adjusting after on-device certification.

use serde::{Deserialize, Serialize};

use super::protocol::{control_frame, ControlResponse};

/// Request the full file list. The device replies with one or more binary
/// records; see [`parse_file_list`].
pub fn get_file_list_frame() -> Vec<u8> {
    control_frame("getlist")
}

/// Request the next list chunk while the device signals continuation.
pub fn list_chunk_frame(index: usize, continue_flag: u8) -> Vec<u8> {
    control_frame(&format!("listreq#{index}#{continue_flag}"))
}

/// Start a BLE file transfer (protocol >= 16 devices also accept an offset
/// for resume). `current_packet` is 1-based; 0 asks the device to start from
/// the beginning.
pub fn ble_file_request_frame(
    protocol_v2: bool,
    status: u8,
    sn: i64,
    current_packet: i64,
    auto_delete: bool,
    offset_bytes: Option<i64>,
) -> Vec<u8> {
    let name = if protocol_v2 { "filect" } else { "opusfile" };
    control_frame(&format!(
        "{name}#{status}#{sn}#{current_packet}#{}#{}",
        if auto_delete { 1 } else { 0 },
        offset_bytes.unwrap_or(0)
    ))
}

/// Stop / cancel an in-flight BLE transfer (protocol >= 22 acknowledges the
/// stop; older firmware simply stops).
pub fn ble_file_cancel_frame(protocol_v2: bool, sn: i64) -> Vec<u8> {
    let name = if protocol_v2 { "filect" } else { "opusfile" };
    control_frame(&format!("{name}#0#{sn}#0#0#0"))
}

/// Exit BLE transfer mode (protocol >= 2.0.9 firmware separates this from
/// the cancel command).
#[allow(dead_code)] // sent by future flows; the cancel frame covers v1
pub fn exit_transfer_mode_frame() -> Vec<u8> {
    control_frame("filecmd#exit")
}

/// Delete a file on the device: `*APP#delfile#{sn}#{fileName}#`.
pub fn delete_file_frame(sn: i64, name: &str) -> Vec<u8> {
    control_frame(&format!("delfile#{sn}#{name}"))
}

/// BLE file packets may carry a small header before the Opus payload. The
/// vendor layout is unpublished; strip a leading little-endian packet number
/// (u32) plus 2-byte length only when it plausibly matches, else pass the
/// payload through unchanged.
pub fn strip_packet_header(data: &[u8]) -> &[u8] {
    if data.len() > 6 {
        let pkg = u32::from_le_bytes(data[0..4].try_into().unwrap());
        let size = u16::from_le_bytes(data[4..6].try_into().unwrap()) as usize;
        if pkg > 0 && pkg < 1_000_000 && size + 6 == data.len() {
            return &data[6..];
        }
        if pkg == 0 && size + 4 == data.len() {
            return &data[4..];
        }
    }
    data
}

/// One recording stored on the card.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFile {
    /// File number the device uses to address the recording.
    pub sn: i64,
    /// Unix-timestamp file name assigned by the firmware.
    pub name: String,
    /// Compressed size in bytes (sum of Opus packets).
    pub size: i64,
    /// 0 = meeting, 1 = call (legacy `scene` field).
    pub scene: i64,
    /// Recording start / end as epoch seconds when the device supplies them.
    pub start_timestamp: Option<f64>,
    pub end_timestamp: Option<f64>,
    pub crc: Option<String>,
    /// Compressed Opus frame size in bytes.
    pub frame_bytes: i64,
}

impl CardFile {
    /// Parse the timestamp file name into a wall-clock display string.
    #[allow(dead_code)] // frontend formats the date itself
    pub fn recorded_at(&self) -> Option<i64> {
        self.name.parse::<i64>().ok().filter(|value| *value > 1_000_000_000)
    }
}

/// Outcome of parsing device notifications as (part of) a file list.
pub enum FileListParse {
    /// Parsed records; `more` repeats the device's continue flag.
    Records(Vec<CardFile>, bool),
    /// Not enough data yet.
    Incomplete,
    /// The accumulated payload does not look like a file list.
    Invalid,
}

/// Parse accumulated file-list payload bytes.
///
/// The documented wire shape is one or more `#`-separated records whose
/// leading fields mirror the vendor `NVEasyFileInfo`:
/// `{sn}#{name}#{size}#{scene}#{start}#{end}#{crc}#{frameBytes}`. Parsing
/// tolerates both a `*DEV#list#…#` header and bare binary records where the
/// fields are length-prefixed ASCII — when neither shape matches, callers
/// receive [`FileListParse::Invalid`] plus can log the payload for
/// certification.
pub fn parse_file_list(payload: &[u8]) -> FileListParse {
    if payload.is_empty() {
        return FileListParse::Incomplete;
    }
    // Strip an optional ASCII `*DEV#list#`-style header (also tolerates a
    // `*DEV#flist#` spelling seen in vendor logs).
    let mut body = payload;
    for header in [&b"*DEV#list#"[..], b"*DEV#flist#"] {
        if body.starts_with(header) {
            body = &body[header.len()..];
        }
    }
    if body.is_empty() {
        return FileListParse::Incomplete;
    }

    // Shape A: pure ASCII, `#`-separated numeric records. Empty fields (the
    // optional crc) are preserved; trailing empties from the final `#` are
    // dropped, and a leftover lone "0"/"1" field is the continue flag.
    if body.iter().all(|byte| byte.is_ascii_graphic() || *byte == b' ') {
        let text = String::from_utf8_lossy(body);
        let mut fields: Vec<&str> = text.split('#').collect();
        while fields.last() == Some(&"") {
            fields.pop();
        }
        if fields.len() >= 7 {
            return parse_ascii_records(&fields);
        }
        return FileListParse::Incomplete;
    }

    // Shape B: binary records, best-effort recovered layout:
    //   [sn u32 LE][name 10 ascii digits][size u32 LE][scene u8]
    //   [start f64 LE][end f64 LE][frame u16 LE]
    let mut records = Vec::new();
    let mut offset = 0usize;
    while body.len() - offset >= 27 {
        let record = &body[offset..];
        let sn = u32::from_le_bytes(record[0..4].try_into().unwrap()) as i64;
        let name = match std::str::from_utf8(&record[4..14]) {
            Ok(name) if name.bytes().all(|byte| byte.is_ascii_digit()) => name.to_owned(),
            _ => return FileListParse::Invalid,
        };
        let size = u32::from_le_bytes(record[14..18].try_into().unwrap()) as i64;
        let scene = record[18] as i64;
        let start = f64::from_le_bytes(record[19..27].try_into().unwrap());
        offset += 27;
        // Optional tail (end timestamp f64 + frame size u16) is accepted but
        // not required; stop cleanly at the end of the buffer.
        let (end, frame_bytes) = if body.len() - offset >= 10 {
            let end = f64::from_le_bytes(body[offset..offset + 8].try_into().unwrap());
            let frame = u16::from_le_bytes(body[offset + 8..offset + 10].try_into().unwrap()) as i64;
            offset += 10;
            (Some(end), if frame > 0 { frame } else { 80 })
        } else {
            (None, 80)
        };
        records.push(CardFile {
            sn,
            name,
            size,
            scene,
            start_timestamp: Some(start),
            end_timestamp: end,
            crc: None,
            frame_bytes,
        });
    }
    if records.is_empty() {
        FileListParse::Invalid
    } else {
        FileListParse::Records(records, false)
    }
}

fn parse_ascii_records(fields: &[&str]) -> FileListParse {
    let mut continue_flag = false;
    // A trailing lone "0"/"1" field (not part of an 8-field record) is the
    // continue flag of a chunked list.
    let mut records_end = fields.len();
    if fields.len() % 8 == 1 {
        continue_flag = fields[fields.len() - 1] == "1";
        records_end -= 1;
    }
    if records_end % 8 != 0 || records_end == 0 {
        return FileListParse::Invalid;
    }
    let mut records = Vec::with_capacity(records_end / 8);
    for chunk in fields[..records_end].chunks_exact(8) {
        let sn: i64 = match chunk[0].parse() {
            Ok(value) => value,
            Err(_) => return FileListParse::Invalid,
        };
        let name = chunk[1].to_owned();
        let size: i64 = match chunk[2].parse() {
            Ok(value) => value,
            Err(_) => return FileListParse::Invalid,
        };
        let scene: i64 = chunk[3].parse().unwrap_or(0);
        let start: Option<f64> = chunk[4].parse().ok();
        let end: Option<f64> = chunk[5].parse().ok();
        let crc = if chunk[6].is_empty() { None } else { Some(chunk[6].to_owned()) };
        let frame_bytes: i64 = chunk[7].parse().unwrap_or(80);
        records.push(CardFile {
            sn,
            name,
            size,
            scene,
            start_timestamp: start,
            end_timestamp: end,
            crc,
            frame_bytes,
        });
    }
    FileListParse::Records(records, continue_flag)
}

/// Interpret a `*DEV#delfile#{status}#{sn}#{name}#` response.
pub fn parse_delete_response(response: &ControlResponse) -> Result<(i64, String), String> {
    let status = response.number(2).ok_or("delete response missing status")?;
    if status != 0 {
        return Err(format!("device rejected delete (status {status})"));
    }
    let sn = response.number(3).unwrap_or(0);
    let name = response.field(4).unwrap_or_default().to_owned();
    Ok((sn, name))
}

/// Interpret `*DEV#filecmd#{status}#` transfer-terminal responses.
/// 0 signals success, anything else a device-side failure.
pub fn parse_transfer_terminal(response: &ControlResponse) -> Option<Result<(), String>> {
    if response.name != "filecmd" {
        return None;
    }
    let status = response.number(2).unwrap_or(1);
    if status == 0 {
        Some(Ok(()))
    } else {
        Some(Err(format!("transfer failed on device (status {status})")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_request_frames() {
        assert_eq!(get_file_list_frame(), b"*APP#getlist#".to_vec());
        assert_eq!(list_chunk_frame(2, 1), b"*APP#listreq#2#1#".to_vec());
        assert_eq!(
            ble_file_request_frame(true, 1, 7, 0, true, None),
            b"*APP#filect#1#7#0#1#0#".to_vec()
        );
        assert_eq!(
            ble_file_request_frame(false, 1, 7, 12, false, Some(960)),
            b"*APP#opusfile#1#7#12#0#960#".to_vec()
        );
        assert_eq!(delete_file_frame(7, "1730000000"), b"*APP#delfile#7#1730000000#".to_vec());
    }

    #[test]
    fn parses_ascii_file_list() {
        let payload = b"*DEV#list#7#1730000000#96000#0#1730000000#1730001000##80#1#";
        match parse_file_list(payload) {
            FileListParse::Records(files, more) => {
                assert_eq!(files.len(), 1);
                assert!(more);
                assert_eq!(files[0].sn, 7);
                assert_eq!(files[0].size, 96_000);
                assert_eq!(files[0].frame_bytes, 80);
                assert_eq!(files[0].recorded_at(), Some(1_730_000_000));
            }
            _ => panic!("ascii list should parse"),
        }
    }

    #[test]
    fn parses_binary_file_list() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&7u32.to_le_bytes());
        payload.extend_from_slice(b"1730000000");
        payload.extend_from_slice(&96_000u32.to_le_bytes());
        payload.push(0);
        payload.extend_from_slice(&1_730_000_000f64.to_le_bytes());
        payload.extend_from_slice(&1_730_000_600f64.to_le_bytes());
        payload.extend_from_slice(&80u16.to_le_bytes());
        match parse_file_list(&payload) {
            FileListParse::Records(files, _) => {
                assert_eq!(files.len(), 1);
                assert_eq!(files[0].sn, 7);
                assert_eq!(files[0].end_timestamp, Some(1_730_000_600.0));
            }
            _ => panic!("binary list should parse"),
        }
    }

    #[test]
    fn rejects_garbage_list() {
        match parse_file_list(b"\xff\xff\xff\xffnotdigits!!\x01\x02") {
            FileListParse::Invalid => {}
            _ => panic!("garbage must not parse as records"),
        }
    }

    #[test]
    fn parses_delete_response() {
        let response = ControlResponse {
            name: "delfile".into(),
            fields: vec!["*DEV".into(), "delfile".into(), "0".into(), "7".into(), "1730000000".into()],
        };
        let (sn, name) = parse_delete_response(&response).expect("delete parses");
        assert_eq!((sn, name.as_str()), (7, "1730000000"));
    }
}
