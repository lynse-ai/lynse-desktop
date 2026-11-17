//! Command table and response parsing for the NvEasy recording-card protocol.
//!
//! Command names and their expected response-field counts were recovered
//! verbatim from the vendor SDK's `C` map (see webusb-protocol-notes.md).

use serde::{Deserialize, Serialize};

use super::frames::{build_binary_frame, build_text_frame, decode_frame_text, split_frame, DEFAULT_FRAME_PREFIX};

/// Commands and the number of payload fields their reply carries (excluding
/// prefix and command name). Recovered from the SDK `C` map.
pub const COMMANDS: &[(&str, usize)] = &[
    ("version", 2),
    ("battery", 3),
    ("mem", 2),
    ("getlist", 1),
    ("flist", 2),
    ("authsn", 4),
    ("rtc", 2),
    ("cmicgain", 4),
    ("micgain", 4),
    ("filecmd", 1),
    ("default", 1),
    ("format", 1),
    ("fmtret", 3),
    ("bound", 2),
    ("unbound", 2),
    ("delfile", 3),
    ("offtime", 2),
    ("cofftime", 2),
    ("upgrade", 1),
    ("otareq", 2),
];

pub fn expected_fields(cmd: &str) -> Option<usize> {
    COMMANDS
        .iter()
        .find(|(name, _)| *name == cmd)
        .map(|(_, count)| *count)
}

/// One recording on the card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardFile {
    pub sn: u64,
    pub name: String,
    pub size: u64,
    pub scene: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub crc: String,
    pub frame_size: u64,
}

/// Device storage report, in kilobytes as the device reports it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub free_space: u64,
    pub total_space: u64,
}

/// Parsed text response: prefix, command name and payload fields.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceResponse {
    pub prefix: String,
    pub command: String,
    pub fields: Vec<String>,
}

/// Parse a raw bulk frame into a DeviceResponse. Returns None for frames that
/// carry no usable command (e.g. startup noise the SDK drains at connect).
pub fn parse_response(raw: &[u8], prefix: &str) -> Option<DeviceResponse> {
    let text = decode_frame_text(raw);
    if text.is_empty() {
        return None;
    }
    let parts = split_frame(&text);
    if parts.len() < 2 || parts[0] != prefix {
        return None;
    }
    Some(DeviceResponse {
        prefix: parts[0].to_string(),
        command: parts[1].to_string(),
        fields: parts[2..]
            .iter()
            .filter(|field| !field.is_empty())
            .map(|field| field.to_string())
            .collect(),
    })
}

/// Validate that a response carries the field count its command expects.
/// `getStorage` is special: the device first reports (0,0) as a placeholder,
/// then the real capacity — callers retry on placeholder via
/// `is_storage_placeholder`.
pub fn validate_response(response: &DeviceResponse) -> Result<(), String> {
    if let Some(expected) = expected_fields(&response.command) {
        if response.fields.len() < expected {
            return Err(format!(
                "command {} expected {expected} fields, got {}",
                response.command,
                response.fields.len()
            ));
        }
    }
    Ok(())
}

pub fn is_storage_placeholder(response: &DeviceResponse) -> bool {
    response.command == "mem"
        && response.fields.len() >= 2
        && response.fields[0] == "0"
        && response.fields[1] == "0"
}

pub fn parse_storage(response: &DeviceResponse) -> Result<StorageInfo, String> {
    if response.command != "mem" || response.fields.len() < 2 {
        return Err("not a storage response".to_string());
    }
    Ok(StorageInfo {
        free_space: response.fields[0]
            .parse()
            .map_err(|_| "invalid free space".to_string())?,
        total_space: response.fields[1]
            .parse()
            .map_err(|_| "invalid total space".to_string())?,
    })
}

/// Parse a `flist` response. A list reply can carry one or more 8-field
/// records; each record is `sn#name#size#scene#start#end#crc#frameSize`.
pub fn parse_file_list(response: &DeviceResponse) -> Result<Vec<CardFile>, String> {
    if response.command != "flist" {
        return Err("not a file-list response".to_string());
    }
    let mut files = Vec::new();
    let fields = &response.fields;
    let mut i = 0;
    while i + 8 <= fields.len() {
        let sn = fields[i].parse().map_err(|_| "invalid file sn".to_string())?;
        let name = fields[i + 1].clone();
        let size = fields[i + 2].parse().map_err(|_| "invalid file size".to_string())?;
        let scene = fields[i + 3].parse().unwrap_or(0);
        let start_time = fields[i + 4].parse().unwrap_or(0);
        let end_time = fields[i + 5].parse().unwrap_or(0);
        let crc = fields[i + 6].clone();
        let frame_size = fields[i + 7].parse().unwrap_or(0);
        if !name.is_empty() {
            files.push(CardFile {
                sn,
                name,
                size,
                scene,
                start_time,
                end_time,
                crc,
                frame_size,
            });
        }
        i += 8;
    }
    Ok(files)
}

// ── request builders ──────────────────────────────────────────────

pub fn get_file_list_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "getlist", &[])
}

pub fn get_storage_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "mem", &[])
}

pub fn get_version_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "version", &[])
}

pub fn set_time_frame(prefix: &str, unix_seconds: u64) -> Vec<u8> {
    build_text_frame(prefix, "rtc", &[&unix_seconds.to_string()])
}

pub fn delete_file_frame(prefix: &str, name: &str) -> Vec<u8> {
    build_text_frame(prefix, "delfile", &["0", name])
}

/// File-transfer request with offset resume. `status=1` starts, `status=0`
/// cancels; `current_packet` is 1-based (0 = from beginning).
pub fn file_request_frame(
    prefix: &str,
    status: u8,
    sn: u64,
    current_packet: u64,
    auto_delete: bool,
    offset: u64,
) -> Vec<u8> {
    build_text_frame(
        prefix,
        "filecmd",
        &[
            &status.to_string(),
            &sn.to_string(),
            &current_packet.to_string(),
            if auto_delete { "1" } else { "0" },
            &offset.to_string(),
        ],
    )
}

pub fn binary_payload_frame(prefix: &str, cmd: &str, payload: &[u8]) -> Vec<u8> {
    build_binary_frame(prefix, cmd, payload)
}

/// Parse a `delfile` response: `result==0` means accepted.
pub fn is_delete_accepted(response: &DeviceResponse) -> bool {
    response.command == "delfile"
        && response
            .fields
            .first()
            .map(|value| value == "0")
            .unwrap_or(false)
}

pub fn frame_prefix() -> &'static str {
    DEFAULT_FRAME_PREFIX
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_table_matches_sdk() {
        assert_eq!(expected_fields("version"), Some(2));
        assert_eq!(expected_fields("battery"), Some(3));
        assert_eq!(expected_fields("authsn"), Some(4));
        assert_eq!(expected_fields("delfile"), Some(3));
        assert_eq!(expected_fields("nonexistent"), None);
    }

    #[test]
    fn parses_nul_padded_text_response() {
        let mut raw = b"*DEV#version#1.2.3#hw4#".to_vec();
        raw.resize(64, 0);
        let resp = parse_response(&raw, "*DEV").unwrap();
        assert_eq!(resp.command, "version");
        assert_eq!(resp.fields, vec!["1.2.3", "hw4"]);
        assert!(validate_response(&resp).is_ok());
    }

    #[test]
    fn rejects_wrong_prefix() {
        let raw = b"*DEV#getlist#x#";
        assert!(parse_response(raw, "*APP").is_none());
    }

    #[test]
    fn detects_storage_placeholder() {
        let resp = parse_response(b"*DEV#mem#0#0#", "*DEV").unwrap();
        assert!(is_storage_placeholder(&resp));
        let real = parse_response(b"*DEV#mem#51200#102400#", "*DEV").unwrap();
        assert!(!is_storage_placeholder(&real));
        assert_eq!(
            parse_storage(&real).unwrap(),
            StorageInfo { free_space: 51200, total_space: 102400 }
        );
    }

    #[test]
    fn parses_file_list_records() {
        let raw = b"*DEV#flist#1#rec01.wav#123456#0#1763300000#1763300060#abc#1024#2#rec02.wav#99#1#0#0#def#512#";
        let resp = parse_response(raw, "*DEV").unwrap();
        let files = parse_file_list(&resp).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "rec01.wav");
        assert_eq!(files[0].size, 123456);
        assert_eq!(files[0].frame_size, 1024);
        assert_eq!(files[1].sn, 2);
    }

    #[test]
    fn request_builders_match_frame_format() {
        assert_eq!(get_file_list_frame("*APP"), b"*APP#getlist#");
        assert_eq!(set_time_frame("*APP", 1763300000), b"*APP#rtc#1763300000#");
        assert_eq!(file_request_frame("*APP", 1, 3, 0, false, 4096), b"*APP#filecmd#1#3#0#0#4096#");
    }

    #[test]
    fn delete_response_parsing() {
        let ok = parse_response(b"*DEV#delfile#0#rec01.wav#", "*DEV").unwrap();
        assert!(is_delete_accepted(&ok));
        let fail = parse_response(b"*DEV#delfile#3#rec01.wav#", "*DEV").unwrap();
        assert!(!is_delete_accepted(&fail));
    }
}
