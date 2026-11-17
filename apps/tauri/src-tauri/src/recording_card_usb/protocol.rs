//! Command table and response parsing for the NvEasy recording-card protocol.
//!
//! Command names and their expected response-field counts were recovered
//! verbatim from the vendor SDK's `C` map (see webusb-protocol-notes.md).
//! Requests use `*APP#…#`; responses use `*DEV#…#`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::frames::{
    build_binary_frame, build_text_frame, decode_frame_text, split_frame,
    DEFAULT_REQUEST_FRAME_PREFIX, DEFAULT_RESPONSE_FRAME_PREFIX,
};

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

/// Map a request command to the response command the SDK waits for.
/// Most commands echo their name; `format` is the notable exception.
pub fn response_command(command: &str) -> &str {
    match command {
        "format" => "fmtret",
        _ => command,
    }
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

/// Two-channel microphone gain for one scene (0 = meeting, 1 = call).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MicGain {
    pub result: u64,
    pub mode: u64,
    pub mic1: u64,
    pub mic2: u64,
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

fn response_field(response: &DeviceResponse, index: usize, name: &str) -> Result<u64, String> {
    response
        .fields
        .get(index)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| format!("invalid {name} in {} response", response.command))
}

/// `cofftime` / `offtime` reply: [result, minutes].
pub fn parse_auto_off(response: &DeviceResponse) -> Result<u64, String> {
    let result = response_field(response, 0, "result")?;
    if result != 0 {
        return Err(format!("device rejected auto-off command: {result}"));
    }
    response_field(response, 1, "auto-off minutes")
}

/// `cmicgain` / `micgain` reply: [result, mode, mic1, mic2].
pub fn parse_mic_gain(response: &DeviceResponse) -> Result<MicGain, String> {
    Ok(MicGain {
        result: response_field(response, 0, "result")?,
        mode: response_field(response, 1, "mode")?,
        mic1: response_field(response, 2, "mic1")?,
        mic2: response_field(response, 3, "mic2")?,
    })
}

/// Generic `result == 0` action reply.
pub fn parse_action_result(response: &DeviceResponse) -> Result<(), String> {
    let result = response_field(response, 0, "result")?;
    if result == 0 {
        Ok(())
    } else {
        Err(format!("device rejected {}: {result}", response.command))
    }
}

/// Parse the JSON payload carried by the `listreq` file-list packets.
/// Mirrors the SDK's `P()`: top-level arrays only, numeric strings coerced,
/// missing numeric fields default to 0 and missing strings to "". Device JSON
/// uses snake_case time/frame fields; `P()` maps them to camelCase, so accept
/// both representations with camelCase taking precedence.
pub fn parse_file_list_json(payload: &[u8]) -> Result<Vec<CardFile>, String> {
    let mut end = payload.len();
    while end > 0 && (payload[end - 1] == 0 || payload[end - 1].is_ascii_whitespace()) {
        end -= 1;
    }
    let trimmed = &payload[..end];
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let value: Value = serde_json::from_slice(trimmed)
        .map_err(|e| format!("invalid file-list JSON: {e}"))?;
    let items = match value {
        Value::Array(items) => items,
        _ => return Ok(Vec::new()),
    };
    Ok(items.iter().map(card_file_from_value).collect())
}

fn card_file_from_value(value: &Value) -> CardFile {
    let get = |key: &str| value.get(key);
    let start_time = get("startTime").or_else(|| get("start_time"));
    let end_time = get("endTime").or_else(|| get("end_time"));
    let frame_size = get("frameSize").or_else(|| get("frame_size"));
    CardFile {
        sn: value_to_u64(get("sn")),
        name: value_to_string(get("name")),
        size: value_to_u64(get("size")),
        scene: value_to_u64(get("scene")),
        start_time: value_to_u64(start_time),
        end_time: value_to_u64(end_time),
        crc: value_to_string(get("crc")),
        frame_size: value_to_u64(frame_size),
    }
}

fn value_to_u64(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.parse().unwrap_or(0),
        _ => 0,
    }
}

fn value_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

// ── request builders ──────────────────────────────────────────────

pub fn get_file_list_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "getlist", &[])
}

/// Acknowledge the `flist` header so the device starts emitting `listreq`.
pub fn start_file_list_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "flist", &["0"])
}

/// Ask for one 1-based JSON payload packet.
pub fn file_list_packet_frame(prefix: &str, packet: u64) -> Vec<u8> {
    let packet = packet.to_string();
    build_text_frame(prefix, "listreq", &["0", &packet])
}

/// Close the file-list transfer.
pub fn end_file_list_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "listreq", &["0", "0"])
}

pub fn get_storage_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "mem", &[])
}

pub fn get_version_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "version", &[])
}

pub fn get_identity_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "authsn", &[])
}

/// Parse an `authsn` response: fields = [sn, bleMac, wifiMac, labelSn].
pub fn parse_identity(response: &DeviceResponse) -> Result<String, String> {
    if response.command != "authsn" {
        return Err("not an identity response".to_string());
    }
    response
        .fields
        .first()
        .filter(|sn| !sn.is_empty())
        .cloned()
        .ok_or_else(|| "identity carried no serial number".to_string())
}

pub fn set_time_frame(prefix: &str, unix_seconds: u64) -> Vec<u8> {
    build_text_frame(prefix, "rtc", &[&unix_seconds.to_string()])
}

pub fn get_auto_off_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "cofftime", &[])
}

pub fn set_auto_off_frame(prefix: &str, minutes: u64) -> Vec<u8> {
    build_text_frame(prefix, "offtime", &[&minutes.to_string()])
}

pub fn get_mic_gain_frame(prefix: &str, mode: u64) -> Vec<u8> {
    build_text_frame(prefix, "cmicgain", &[&mode.to_string()])
}

pub fn set_mic_gain_frame(prefix: &str, mode: u64, mic1: u64, mic2: u64) -> Vec<u8> {
    build_text_frame(
        prefix,
        "micgain",
        &[&mode.to_string(), &mic1.to_string(), &mic2.to_string()],
    )
}

pub fn set_bound_frame(prefix: &str, bound: bool) -> Vec<u8> {
    build_text_frame(prefix, "bound", &[if bound { "1" } else { "0" }])
}

/// `format=false` sends `unbound#1#0#`; `format=true` sends `unbound#2#1#`.
pub fn unbind_frame(prefix: &str, format: bool) -> Vec<u8> {
    if format {
        build_text_frame(prefix, "unbound", &["2", "1"])
    } else {
        build_text_frame(prefix, "unbound", &["1", "0"])
    }
}

pub fn factory_reset_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "default", &[])
}

pub fn format_storage_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "format", &[])
}

pub fn delete_file_frame(prefix: &str, name: &str) -> Vec<u8> {
    build_text_frame(prefix, "delfile", &["0", name])
}

/// Start a file download. Confirmed against the vendor SDK's `readFile()`:
/// `*APP#filect#0#<sn>#1#0#<offset>#`. The old BLE `filecmd` layout does not
/// apply to the USB firmware.
pub fn file_download_frame(prefix: &str, sn: u64, offset: u64) -> Vec<u8> {
    build_text_frame(
        prefix,
        "filect",
        &["0", &sn.to_string(), "1", "0", &offset.to_string()],
    )
}

/// Cancel an in-flight download. The SDK's `cancelTransfer()` sends exactly
/// `*APP#filecmd#0#` (no serial number).
pub fn file_cancel_frame(prefix: &str) -> Vec<u8> {
    build_text_frame(prefix, "filecmd", &["0"])
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
    DEFAULT_REQUEST_FRAME_PREFIX
}

pub fn response_prefix() -> &'static str {
    DEFAULT_RESPONSE_FRAME_PREFIX
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_table_matches_sdk() {
        assert_eq!(expected_fields("version"), Some(2));
        assert_eq!(expected_fields("battery"), Some(3));
        assert_eq!(expected_fields("getlist"), Some(1));
        assert_eq!(expected_fields("flist"), Some(2));
        assert_eq!(expected_fields("authsn"), Some(4));
        assert_eq!(expected_fields("delfile"), Some(3));
        assert_eq!(expected_fields("nonexistent"), None);
    }

    #[test]
    fn prefixes_match_sdk() {
        assert_eq!(frame_prefix(), "*APP");
        assert_eq!(response_prefix(), "*DEV");
        assert_eq!(response_command("format"), "fmtret");
        assert_eq!(response_command("getlist"), "getlist");
    }

    #[test]
    fn parses_nul_padded_dev_response() {
        let mut raw = b"*DEV#version#1.2.3#hw4#".to_vec();
        raw.resize(64, 0);
        let resp = parse_response(&raw, response_prefix()).unwrap();
        assert_eq!(resp.command, "version");
        assert_eq!(resp.fields, vec!["1.2.3", "hw4"]);
        assert!(validate_response(&resp).is_ok());
    }

    #[test]
    fn rejects_wrong_prefix() {
        let raw = b"*DEV#getlist#x#";
        assert!(parse_response(raw, frame_prefix()).is_none());
    }

    #[test]
    fn detects_storage_placeholder() {
        let resp = parse_response(b"*DEV#mem#0#0#", response_prefix()).unwrap();
        assert!(is_storage_placeholder(&resp));
        let real = parse_response(b"*DEV#mem#51200#102400#", response_prefix()).unwrap();
        assert!(!is_storage_placeholder(&real));
        assert_eq!(
            parse_storage(&real).unwrap(),
            StorageInfo {
                free_space: 51200,
                total_space: 102400
            }
        );
    }

    #[test]
    fn parses_management_responses() {
        let auto_off = parse_response(b"*DEV#cofftime#0#10#", response_prefix()).unwrap();
        assert_eq!(parse_auto_off(&auto_off).unwrap(), 10);

        let gain = parse_response(b"*DEV#cmicgain#0#0#5#6#", response_prefix()).unwrap();
        assert_eq!(
            parse_mic_gain(&gain).unwrap(),
            MicGain {
                result: 0,
                mode: 0,
                mic1: 5,
                mic2: 6
            }
        );

        let rejected = parse_response(b"*DEV#default#3#", response_prefix()).unwrap();
        assert!(parse_action_result(&rejected).is_err());
        let accepted = parse_response(b"*DEV#default#0#", response_prefix()).unwrap();
        assert!(parse_action_result(&accepted).is_ok());
    }

    #[test]
    fn parses_file_list_json_payload() {
        let payload = br#"[{"sn":"1","name":"a.wav","size":"123","scene":"0","startTime":"1","endTime":"2","crc":"x","frameSize":"1024"},{"sn":2,"name":"b.wav","size":99}]"#;
        let files = parse_file_list_json(payload).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].sn, 1);
        assert_eq!(files[0].name, "a.wav");
        assert_eq!(files[0].size, 123);
        assert_eq!(files[0].frame_size, 1024);
        assert_eq!(files[1].sn, 2);
        assert_eq!(files[1].scene, 0);
        assert_eq!(files[1].start_time, 0);
        assert_eq!(files[1].crc, "");
    }

    #[test]
    fn parses_snake_case_file_list_json_payload() {
        let payload = br#"[{"sn":1,"name":"a.raw","size":123,"scene":0,"start_time":111,"end_time":222,"crc":"0","frame_size":80,"opus":0,"marks":[1,2]}]"#;
        let files = parse_file_list_json(payload).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].sn, 1);
        assert_eq!(files[0].name, "a.raw");
        assert_eq!(files[0].size, 123);
        assert_eq!(files[0].start_time, 111);
        assert_eq!(files[0].end_time, 222);
        assert_eq!(files[0].frame_size, 80);
    }

    #[test]
    fn file_list_json_ignores_object_root() {
        assert!(parse_file_list_json(br#"{"files":[]}"#)
            .unwrap()
            .is_empty());
        assert!(parse_file_list_json(b"  \0\0").unwrap().is_empty());
    }

    #[test]
    fn request_builders_match_frame_format() {
        assert_eq!(get_file_list_frame("*APP"), b"*APP#getlist#");
        assert_eq!(start_file_list_frame("*APP"), b"*APP#flist#0#");
        assert_eq!(file_list_packet_frame("*APP", 1), b"*APP#listreq#0#1#");
        assert_eq!(end_file_list_frame("*APP"), b"*APP#listreq#0#0#");
        assert_eq!(set_time_frame("*APP", 1763300000), b"*APP#rtc#1763300000#");
        assert_eq!(get_auto_off_frame("*APP"), b"*APP#cofftime#");
        assert_eq!(set_auto_off_frame("*APP", 10), b"*APP#offtime#10#");
        assert_eq!(get_mic_gain_frame("*APP", 1), b"*APP#cmicgain#1#");
        assert_eq!(
            set_mic_gain_frame("*APP", 0, 5, 6),
            b"*APP#micgain#0#5#6#"
        );
        assert_eq!(set_bound_frame("*APP", true), b"*APP#bound#1#");
        assert_eq!(set_bound_frame("*APP", false), b"*APP#bound#0#");
        assert_eq!(unbind_frame("*APP", false), b"*APP#unbound#1#0#");
        assert_eq!(unbind_frame("*APP", true), b"*APP#unbound#2#1#");
        assert_eq!(factory_reset_frame("*APP"), b"*APP#default#");
        assert_eq!(format_storage_frame("*APP"), b"*APP#format#");
        assert_eq!(
            file_download_frame("*APP", 162, 4096),
            b"*APP#filect#0#162#1#0#4096#"
        );
        assert_eq!(file_cancel_frame("*APP"), b"*APP#filecmd#0#");
    }

    #[test]
    fn delete_response_parsing() {
        let ok = parse_response(b"*DEV#delfile#0#rec01.wav#", response_prefix()).unwrap();
        assert!(is_delete_accepted(&ok));
        let fail = parse_response(b"*DEV#delfile#3#rec01.wav#", response_prefix()).unwrap();
        assert!(!is_delete_accepted(&fail));
    }
}
