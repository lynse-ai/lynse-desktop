//! Text and binary frame codec for the NvEasy WebUSB recording-card protocol.
//!
//! Wire format (recovered from the vendor SDK, see
//! specs/recorder-usb-access/webusb-protocol-notes.md):
//!   request text frame:  `*APP#<cmd>#<p1>#...#<pn>#` (UTF-8, NUL padded)
//!   response text frame: `*DEV#<cmd>#<p1>#...#<pn>#` (UTF-8, NUL padded)
//!   binary frame:        `<PREFIX>#<cmd>#<len>#<crc32>#` + raw payload bytes
//! Frames are parsed by stripping NUL bytes, trimming, and splitting on '#'.

use crc32fast::Hasher;

/// Request frame prefix. Decoded from the vendor SDK's obfuscated string
/// table and confirmed by running `getFileList()` against a mock device.
pub const DEFAULT_REQUEST_FRAME_PREFIX: &str = "*APP";

/// Response frame prefix. `readTextFrame()` in the SDK only accepts `*DEV#`.
pub const DEFAULT_RESPONSE_FRAME_PREFIX: &str = "*DEV";

/// Build a UTF-8 text command frame: `PREFIX#cmd#parts...#`.
pub fn build_text_frame(prefix: &str, cmd: &str, parts: &[&str]) -> Vec<u8> {
    let mut fields = Vec::with_capacity(parts.len() + 2);
    fields.push(prefix);
    fields.push(cmd);
    fields.extend_from_slice(parts);
    fields.push(""); // trailing '#' separator
    let text = fields.join("#");
    text.into_bytes()
}

/// Build a binary frame: text header + raw payload.
/// Header = `PREFIX#cmd#<len>#<crc32>#`; CRC is over the payload bytes.
pub fn build_binary_frame(prefix: &str, cmd: &str, payload: &[u8]) -> Vec<u8> {
    let mut hasher = Hasher::new();
    hasher.update(payload);
    let crc = hasher.finalize();
    let header = format!("{prefix}#{cmd}#{}#{crc:08x}#", payload.len());
    let mut frame = header.into_bytes();
    frame.extend_from_slice(payload);
    frame
}

/// Strip the framing noise the SDK's parser removes before splitting:
/// all NUL bytes, then surrounding whitespace.
pub fn decode_frame_text(raw: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(raw).into_owned();
    text = text.replace('\0', "");
    text.trim().to_string()
}

/// Split a decoded frame into fields. The trailing separator yields a final
/// empty field, which callers can ignore.
pub fn split_frame(text: &str) -> Vec<&str> {
    text.split('#').collect()
}

/// Parse a binary frame, returning (cmd, payload) after validating the
/// declared length and CRC32 header.
pub fn parse_binary_frame(raw: &[u8], prefix: &str) -> Result<(String, Vec<u8>), String> {
    let header_end = raw
        .iter()
        .position(|&b| b == b'#')
        .and_then(|first| {
            raw[first + 1..]
                .iter()
                .position(|&b| b == b'#')
                .map(|second| first + 1 + second)
        })
        .and_then(|second| {
            raw[second + 1..]
                .iter()
                .position(|&b| b == b'#')
                .map(|third| second + 1 + third)
        })
        .and_then(|third| {
            raw[third + 1..]
                .iter()
                .position(|&b| b == b'#')
                .map(|fourth| third + 1 + fourth)
        })
        .ok_or_else(|| "binary frame header incomplete".to_string())?;
    let header = decode_frame_text(&raw[..=header_end]);
    let parts: Vec<&str> = header.split('#').collect();
    // parts = [prefix, cmd, len, crc, ""]
    if parts.len() < 4 || parts[0] != prefix {
        return Err("binary frame prefix mismatch".to_string());
    }
    let cmd = parts[1].to_string();
    let len: usize = parts[2]
        .parse()
        .map_err(|_| "binary frame length not numeric".to_string())?;
    let expected_crc = u32::from_str_radix(parts[3], 16)
        .map_err(|_| "binary frame crc not hex".to_string())?;
    let payload = &raw[header_end + 1..];
    if payload.len() < len {
        return Err(format!(
            "binary frame short: got {} bytes, expected {len}",
            payload.len()
        ));
    }
    let payload = &payload[..len];
    let mut hasher = Hasher::new();
    hasher.update(payload);
    let actual = hasher.finalize();
    if actual != expected_crc {
        return Err(format!(
            "binary frame crc mismatch: expected {expected_crc:08x}, got {actual:08x}"
        ));
    }
    Ok((cmd, payload.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_frame_layout() {
        let frame = build_text_frame(DEFAULT_REQUEST_FRAME_PREFIX, "getlist", &[]);
        assert_eq!(frame, b"*APP#getlist#");
    }

    #[test]
    fn text_frame_with_parts() {
        let frame = build_text_frame(DEFAULT_REQUEST_FRAME_PREFIX, "filect", &["0", "1", "2"]);
        assert_eq!(frame, b"*APP#filect#0#1#2#");
    }

    #[test]
    fn response_prefix_is_dev() {
        assert_eq!(DEFAULT_REQUEST_FRAME_PREFIX, "*APP");
        assert_eq!(DEFAULT_RESPONSE_FRAME_PREFIX, "*DEV");
    }

    #[test]
    fn nul_padding_is_stripped_on_parse() {
        let mut raw = b"*DEV#version#1.0#2.0#".to_vec();
        raw.resize(64, 0);
        let text = decode_frame_text(&raw);
        assert_eq!(text, "*DEV#version#1.0#2.0#");
        let parts = split_frame(&text);
        assert_eq!(parts, vec!["*DEV", "version", "1.0", "2.0", ""]);
    }

    #[test]
    fn binary_frame_roundtrip() {
        let payload = b"hello recording card";
        let frame = build_binary_frame(DEFAULT_RESPONSE_FRAME_PREFIX, "filedata", payload);
        let (cmd, decoded) = parse_binary_frame(&frame, DEFAULT_RESPONSE_FRAME_PREFIX).unwrap();
        assert_eq!(cmd, "filedata");
        assert_eq!(decoded, payload);
    }

    #[test]
    fn binary_frame_rejects_bad_crc() {
        let mut frame = build_binary_frame(DEFAULT_REQUEST_FRAME_PREFIX, "filedata", b"payload");
        let last = frame.len() - 1;
        frame[last] ^= 0xff;
        assert!(parse_binary_frame(&frame, DEFAULT_REQUEST_FRAME_PREFIX).is_err());
    }

    #[test]
    fn crc32_matches_known_vector() {
        let mut hasher = Hasher::new();
        hasher.update(b"123456789");
        assert_eq!(hasher.finalize(), 0xCBF43926);
    }
}
