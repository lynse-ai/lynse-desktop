//! Volcengine AST (real-time speech translation, `/api/v4/ast/v2/translate`)
//! wire codec.
//!
//! The service speaks **raw, unframed protobuf over WebSocket binary frames** —
//! there is no length prefix or custom header envelope around the message
//! (verified against ByteDance's official `ast_python_client` demo, which calls
//! `ws.send(request.SerializeToString())` and `response.ParseFromString(frame)`
//! directly).
//!
//! We only need a handful of fields out of the full schema, so instead of
//! pulling in `prost` + a `protoc` build-time dependency we encode/decode those
//! fields by hand. The relevant schema, transcribed from the vendor `.proto`
//! files:
//!
//! ```proto
//! // common/rpcmeta.proto
//! message RequestMeta  { string Endpoint=1; string AppKey=2; string AppID=3;
//!                        string ResourceID=4; string ConnectionID=5;
//!                        string SessionID=6; int32 Sequence=7; }
//! message ResponseMeta { string SessionID=1; int32 Sequence=2;
//!                        int32 StatusCode=3; string Message=4; }
//!
//! // products/understanding/base/au_base.proto
//! message User  { string uid=1; string did=2; string platform=3; ... }
//! message Audio { string data=1; string url=2; string url_type=3;
//!                 string format=4; string codec=5; string language=6;
//!                 int32 rate=7; int32 bits=8; int32 channel=9;
//!                 ...; bytes binary_data=14; }
//!
//! // products/understanding/ast/ast_service.proto
//! message ReqParams        { string mode=1; string source_language=2;
//!                            string target_language=3; string speaker_id=4;
//!                            int32 speech_rate=5;
//!                            optional bool enable_source_language_detect=6; ... }
//! message TranslateRequest { optional RequestMeta request_meta=1; Type event=2;
//!                            User user=3; Audio source_audio=4;
//!                            Audio target_audio=5; ReqParams request=6;
//!                            optional bool denoise=7; }
//! message TranslateResponse{ optional ResponseMeta response_meta=1; Type event=2;
//!                            bytes data=3; string text=4; int32 start_time=5;
//!                            int32 end_time=6; bool spk_chg=7;
//!                            int32 muted_duration_ms=8; }
//! ```

// ---------------------------------------------------------------------------
// Event ids (common/events.proto, enum `data.speech.event.Type`)
// ---------------------------------------------------------------------------

pub const EVENT_START_SESSION: i32 = 100;
pub const EVENT_FINISH_SESSION: i32 = 102;
pub const EVENT_SESSION_STARTED: i32 = 150;
pub const EVENT_SESSION_CANCELED: i32 = 151;
pub const EVENT_SESSION_FINISHED: i32 = 152;
pub const EVENT_SESSION_FAILED: i32 = 153;
pub const EVENT_USAGE_RESPONSE: i32 = 154;
pub const EVENT_TASK_REQUEST: i32 = 200;
pub const EVENT_SOURCE_SUBTITLE_START: i32 = 650;
pub const EVENT_SOURCE_SUBTITLE_RESPONSE: i32 = 651;
pub const EVENT_SOURCE_SUBTITLE_END: i32 = 652;
pub const EVENT_TRANSLATION_SUBTITLE_START: i32 = 653;
pub const EVENT_TRANSLATION_SUBTITLE_RESPONSE: i32 = 654;
pub const EVENT_TRANSLATION_SUBTITLE_END: i32 = 655;

/// Resource id for the AST simultaneous-translation service, sent as the
/// `X-Api-Resource-Id` upgrade header.
pub const RESOURCE_ID: &str = "volc.service_type.10053";

/// Default endpoint for the v4 AST websocket. The webview always supplies the
/// (user-editable) endpoint with the connection descriptor, so this is kept as
/// the documented reference value and used by tests.
#[allow(dead_code)]
pub const DEFAULT_ENDPOINT: &str = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";

/// Lynse streams headerless 16 kHz / mono / 16-bit PCM, so the source audio is
/// declared as raw `pcm` with explicit rate/bits/channel.
const SOURCE_FORMAT: &str = "pcm";
const SOURCE_RATE: i32 = 16_000;
const SOURCE_BITS: i32 = 16;
const SOURCE_CHANNEL: i32 = 1;
const CLIENT_ID: &str = "lynse-desktop";

/// Audio bytes per outbound `TaskRequest`. The vendor demo paces the stream at
/// 100 ms chunks (3200 bytes at 16 kHz/16-bit/mono); Lynse captures 20 ms
/// frames, so five frames are coalesced per request.
pub const CHUNK_BYTES: usize = 3_200;

// ---------------------------------------------------------------------------
// protobuf primitives
// ---------------------------------------------------------------------------

const WIRE_VARINT: u8 = 0;
const WIRE_FIXED64: u8 = 1;
const WIRE_LEN: u8 = 2;
const WIRE_FIXED32: u8 = 5;

fn put_varint(buf: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            buf.push(byte);
            return;
        }
        buf.push(byte | 0x80);
    }
}

fn put_tag(buf: &mut Vec<u8>, field: u32, wire: u8) {
    put_varint(buf, (u64::from(field) << 3) | u64::from(wire));
}

fn put_bytes(buf: &mut Vec<u8>, field: u32, value: &[u8]) {
    if value.is_empty() {
        return;
    }
    put_tag(buf, field, WIRE_LEN);
    put_varint(buf, value.len() as u64);
    buf.extend_from_slice(value);
}

fn put_string(buf: &mut Vec<u8>, field: u32, value: &str) {
    put_bytes(buf, field, value.as_bytes());
}

/// proto3 `int32`: negative values are sign-extended to 64 bits (no zigzag).
/// Implicit-presence fields at their default are omitted from the wire.
fn put_int32(buf: &mut Vec<u8>, field: u32, value: i32) {
    if value == 0 {
        return;
    }
    put_tag(buf, field, WIRE_VARINT);
    put_varint(buf, i64::from(value) as u64);
}

fn put_bool(buf: &mut Vec<u8>, field: u32, value: bool) {
    if !value {
        return;
    }
    put_tag(buf, field, WIRE_VARINT);
    put_varint(buf, 1);
}

fn put_message(buf: &mut Vec<u8>, field: u32, body: &[u8]) {
    if body.is_empty() {
        return;
    }
    put_tag(buf, field, WIRE_LEN);
    put_varint(buf, body.len() as u64);
    buf.extend_from_slice(body);
}

// The AST schema only uses varint and length-delimited fields today, but the
// reader still has to understand the fixed-width wire types so that unknown
// fields from a newer server can be skipped instead of aborting the parse.
#[allow(dead_code)]
enum FieldValue<'a> {
    Varint(u64),
    Fixed64(u64),
    Bytes(&'a [u8]),
    Fixed32(u32),
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn varint(&mut self) -> Result<u64, String> {
        let mut result = 0u64;
        let mut shift = 0u32;
        loop {
            let byte = *self
                .data
                .get(self.pos)
                .ok_or_else(|| "truncated varint".to_owned())?;
            self.pos += 1;
            result |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift >= 64 {
                return Err("varint overflow".to_owned());
            }
        }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or_else(|| "field length overflow".to_owned())?;
        if end > self.data.len() {
            return Err("truncated field".to_owned());
        }
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn next_field(&mut self) -> Result<Option<(u32, FieldValue<'a>)>, String> {
        if self.pos >= self.data.len() {
            return Ok(None);
        }
        let tag = self.varint()?;
        let field = (tag >> 3) as u32;
        if field == 0 {
            return Err("invalid protobuf field number 0".to_owned());
        }
        let value = match (tag & 0x7) as u8 {
            WIRE_VARINT => FieldValue::Varint(self.varint()?),
            WIRE_FIXED64 => {
                let raw = self.take(8)?;
                FieldValue::Fixed64(u64::from_le_bytes(raw.try_into().expect("8 bytes")))
            }
            WIRE_LEN => {
                let len = self.varint()? as usize;
                FieldValue::Bytes(self.take(len)?)
            }
            WIRE_FIXED32 => {
                let raw = self.take(4)?;
                FieldValue::Fixed32(u32::from_le_bytes(raw.try_into().expect("4 bytes")))
            }
            other => return Err(format!("unsupported protobuf wire type {other}")),
        };
        Ok(Some((field, value)))
    }
}

fn as_i32(value: u64) -> i32 {
    value as i64 as i32
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// Per-session parameters echoed on every outbound frame, mirroring the vendor
/// demo (which re-sends the full config with each `TaskRequest`).
#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub session_id: String,
    /// `"s2t"` (subtitles only) or `"s2s"` (subtitles + synthesized speech).
    pub mode: String,
    /// Empty when the source language should be auto-detected.
    pub source_language: String,
    pub target_language: String,
    pub detect_source_language: bool,
}

impl SessionConfig {
    fn encode_request_meta(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        put_string(&mut buf, 6, &self.session_id); // SessionID
        buf
    }

    fn encode_user(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        put_string(&mut buf, 1, CLIENT_ID); // uid
        put_string(&mut buf, 2, CLIENT_ID); // did
        buf
    }

    fn encode_source_audio(&self, audio: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        put_string(&mut buf, 4, SOURCE_FORMAT); // format
        put_int32(&mut buf, 7, SOURCE_RATE); // rate
        put_int32(&mut buf, 8, SOURCE_BITS); // bits
        put_int32(&mut buf, 9, SOURCE_CHANNEL); // channel
        put_bytes(&mut buf, 14, audio); // binary_data
        buf
    }

    fn encode_req_params(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        put_string(&mut buf, 1, &self.mode); // mode
        put_string(&mut buf, 2, &self.source_language); // source_language
        put_string(&mut buf, 3, &self.target_language); // target_language
        put_bool(&mut buf, 6, self.detect_source_language); // enable_source_language_detect
        buf
    }
}

/// Serialize one `TranslateRequest`. `audio` carries the raw PCM payload for
/// `EVENT_TASK_REQUEST` frames and is empty for session control frames.
pub fn encode_request(event: i32, config: &SessionConfig, audio: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    put_message(&mut buf, 1, &config.encode_request_meta()); // request_meta
    put_int32(&mut buf, 2, event); // event
    put_message(&mut buf, 3, &config.encode_user()); // user
    put_message(&mut buf, 4, &config.encode_source_audio(audio)); // source_audio
    put_message(&mut buf, 6, &config.encode_req_params()); // request
    buf
}

pub fn encode_start_session(config: &SessionConfig) -> Vec<u8> {
    encode_request(EVENT_START_SESSION, config, &[])
}

pub fn encode_task_request(config: &SessionConfig, audio: &[u8]) -> Vec<u8> {
    encode_request(EVENT_TASK_REQUEST, config, audio)
}

pub fn encode_finish_session(config: &SessionConfig) -> Vec<u8> {
    encode_request(EVENT_FINISH_SESSION, config, &[])
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Response {
    pub event: i32,
    /// Source text for `SourceSubtitle*` events, translated text for
    /// `TranslationSubtitle*` events.
    pub text: String,
    /// Utterance bounds in milliseconds, relative to the start of the session.
    pub start_time: i32,
    pub end_time: i32,
    pub spk_chg: bool,
    /// Synthesized speech payload (`s2s` mode only).
    pub audio: Vec<u8>,
    pub session_id: String,
    pub status_code: i32,
    pub message: String,
}

pub fn decode_response(frame: &[u8]) -> Result<Response, String> {
    let mut response = Response::default();
    let mut reader = Reader::new(frame);
    while let Some((field, value)) = reader.next_field()? {
        match (field, value) {
            (1, FieldValue::Bytes(raw)) => decode_response_meta(raw, &mut response)?,
            (2, FieldValue::Varint(raw)) => response.event = as_i32(raw),
            (3, FieldValue::Bytes(raw)) => response.audio = raw.to_vec(),
            (4, FieldValue::Bytes(raw)) => {
                response.text = String::from_utf8_lossy(raw).into_owned();
            }
            (5, FieldValue::Varint(raw)) => response.start_time = as_i32(raw),
            (6, FieldValue::Varint(raw)) => response.end_time = as_i32(raw),
            (7, FieldValue::Varint(raw)) => response.spk_chg = raw != 0,
            _ => {}
        }
    }
    Ok(response)
}

fn decode_response_meta(raw: &[u8], response: &mut Response) -> Result<(), String> {
    let mut reader = Reader::new(raw);
    while let Some((field, value)) = reader.next_field()? {
        match (field, value) {
            (1, FieldValue::Bytes(raw)) => {
                response.session_id = String::from_utf8_lossy(raw).into_owned();
            }
            (3, FieldValue::Varint(raw)) => response.status_code = as_i32(raw),
            (4, FieldValue::Bytes(raw)) => {
                response.message = String::from_utf8_lossy(raw).into_owned();
            }
            _ => {}
        }
    }
    Ok(())
}

/// How a response event maps onto Lynse's live-segment model.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Subtitle {
    /// (`is_recognized`, `is_final`): source recognition vs. translation, and
    /// whether this closes the utterance.
    Source { is_final: bool },
    Translation { is_final: bool },
}

pub fn classify_subtitle(event: i32) -> Option<Subtitle> {
    match event {
        EVENT_SOURCE_SUBTITLE_START | EVENT_SOURCE_SUBTITLE_RESPONSE => {
            Some(Subtitle::Source { is_final: false })
        }
        EVENT_SOURCE_SUBTITLE_END => Some(Subtitle::Source { is_final: true }),
        EVENT_TRANSLATION_SUBTITLE_START | EVENT_TRANSLATION_SUBTITLE_RESPONSE => {
            Some(Subtitle::Translation { is_final: false })
        }
        EVENT_TRANSLATION_SUBTITLE_END => Some(Subtitle::Translation { is_final: true }),
        _ => None,
    }
}

pub fn describe_event(event: i32) -> &'static str {
    match event {
        EVENT_START_SESSION => "StartSession",
        EVENT_FINISH_SESSION => "FinishSession",
        EVENT_SESSION_STARTED => "SessionStarted",
        EVENT_SESSION_CANCELED => "SessionCanceled",
        EVENT_SESSION_FINISHED => "SessionFinished",
        EVENT_SESSION_FAILED => "SessionFailed",
        EVENT_USAGE_RESPONSE => "UsageResponse",
        EVENT_TASK_REQUEST => "TaskRequest",
        EVENT_SOURCE_SUBTITLE_START => "SourceSubtitleStart",
        EVENT_SOURCE_SUBTITLE_RESPONSE => "SourceSubtitleResponse",
        EVENT_SOURCE_SUBTITLE_END => "SourceSubtitleEnd",
        EVENT_TRANSLATION_SUBTITLE_START => "TranslationSubtitleStart",
        EVENT_TRANSLATION_SUBTITLE_RESPONSE => "TranslationSubtitleResponse",
        EVENT_TRANSLATION_SUBTITLE_END => "TranslationSubtitleEnd",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SessionConfig {
        SessionConfig {
            session_id: "11111111-2222-3333-4444-555555555555".to_owned(),
            mode: "s2t".to_owned(),
            source_language: "zh".to_owned(),
            target_language: "en".to_owned(),
            detect_source_language: false,
        }
    }

    fn auto_config() -> SessionConfig {
        SessionConfig {
            session_id: "session-auto".to_owned(),
            mode: "s2t".to_owned(),
            source_language: String::new(),
            target_language: "zh".to_owned(),
            detect_source_language: true,
        }
    }

    // Golden vectors produced by ByteDance's own generated Python bindings
    // (`ast_service_pb2.TranslateRequest(...).SerializeToString()`), so the
    // hand-rolled encoder is byte-checked against the reference implementation
    // rather than against itself.

    #[test]
    fn start_session_matches_reference_bytes() {
        let expected: &[u8] = &[
            10, 38, 50, 36, 49, 49, 49, 49, 49, 49, 49, 49, 45, 50, 50, 50, 50, 45, 51, 51, 51, 51,
            45, 52, 52, 52, 52, 45, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 16, 100, 26,
            30, 10, 13, 108, 121, 110, 115, 101, 45, 100, 101, 115, 107, 116, 111, 112, 18, 13,
            108, 121, 110, 115, 101, 45, 100, 101, 115, 107, 116, 111, 112, 34, 12, 34, 3, 112, 99,
            109, 56, 128, 125, 64, 16, 72, 1, 50, 13, 10, 3, 115, 50, 116, 18, 2, 122, 104, 26, 2,
            101, 110,
        ];
        assert_eq!(encode_start_session(&config()), expected);
    }

    #[test]
    fn task_request_matches_reference_bytes() {
        let expected: &[u8] = &[
            10, 38, 50, 36, 49, 49, 49, 49, 49, 49, 49, 49, 45, 50, 50, 50, 50, 45, 51, 51, 51, 51,
            45, 52, 52, 52, 52, 45, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 16, 200, 1, 26,
            30, 10, 13, 108, 121, 110, 115, 101, 45, 100, 101, 115, 107, 116, 111, 112, 18, 13,
            108, 121, 110, 115, 101, 45, 100, 101, 115, 107, 116, 111, 112, 34, 21, 34, 3, 112, 99,
            109, 56, 128, 125, 64, 16, 72, 1, 114, 7, 0, 1, 127, 128, 255, 254, 2, 50, 13, 10, 3,
            115, 50, 116, 18, 2, 122, 104, 26, 2, 101, 110,
        ];
        let audio = [0u8, 1, 127, 128, 255, 254, 2];
        assert_eq!(encode_task_request(&config(), &audio), expected);
    }

    #[test]
    fn finish_session_matches_reference_bytes() {
        let expected: &[u8] = &[
            10, 38, 50, 36, 49, 49, 49, 49, 49, 49, 49, 49, 45, 50, 50, 50, 50, 45, 51, 51, 51, 51,
            45, 52, 52, 52, 52, 45, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 16, 102, 26,
            30, 10, 13, 108, 121, 110, 115, 101, 45, 100, 101, 115, 107, 116, 111, 112, 18, 13,
            108, 121, 110, 115, 101, 45, 100, 101, 115, 107, 116, 111, 112, 34, 12, 34, 3, 112, 99,
            109, 56, 128, 125, 64, 16, 72, 1, 50, 13, 10, 3, 115, 50, 116, 18, 2, 122, 104, 26, 2,
            101, 110,
        ];
        assert_eq!(encode_finish_session(&config()), expected);
    }

    #[test]
    fn auto_detect_start_session_matches_reference_bytes() {
        let expected: &[u8] = &[
            10, 14, 50, 12, 115, 101, 115, 115, 105, 111, 110, 45, 97, 117, 116, 111, 16, 100, 26,
            30, 10, 13, 108, 121, 110, 115, 101, 45, 100, 101, 115, 107, 116, 111, 112, 18, 13,
            108, 121, 110, 115, 101, 45, 100, 101, 115, 107, 116, 111, 112, 34, 12, 34, 3, 112, 99,
            109, 56, 128, 125, 64, 16, 72, 1, 50, 11, 10, 3, 115, 50, 116, 26, 2, 122, 104, 48, 1,
        ];
        assert_eq!(encode_start_session(&auto_config()), expected);
    }

    #[test]
    fn decodes_reference_subtitle_response() {
        // TranslateResponse(response_meta{SessionID:"sess-1", StatusCode:20000000},
        //   event=651, text="你好世界", start_time=1200, end_time=2400)
        let frame: &[u8] = &[
            10, 13, 10, 6, 115, 101, 115, 115, 45, 49, 24, 128, 218, 196, 9, 16, 139, 5, 34, 12,
            228, 189, 160, 229, 165, 189, 228, 184, 150, 231, 149, 140, 40, 176, 9, 48, 224, 18,
        ];
        let response = decode_response(frame).expect("decode");
        assert_eq!(response.event, EVENT_SOURCE_SUBTITLE_RESPONSE);
        assert_eq!(response.text, "你好世界");
        assert_eq!(response.start_time, 1_200);
        assert_eq!(response.end_time, 2_400);
        assert_eq!(response.session_id, "sess-1");
        assert_eq!(response.status_code, 20_000_000);
        assert!(!response.spk_chg);
        assert!(response.audio.is_empty());
    }

    #[test]
    fn decodes_reference_session_failed() {
        // TranslateResponse(response_meta{SessionID:"sess-2", StatusCode:45000001,
        //   Message:"invalid token"}, event=153)
        let frame: &[u8] = &[
            10, 28, 10, 6, 115, 101, 115, 115, 45, 50, 24, 193, 202, 186, 21, 34, 13, 105, 110,
            118, 97, 108, 105, 100, 32, 116, 111, 107, 101, 110, 16, 153, 1,
        ];
        let response = decode_response(frame).expect("decode");
        assert_eq!(response.event, EVENT_SESSION_FAILED);
        assert_eq!(response.status_code, 45_000_001);
        assert_eq!(response.message, "invalid token");
    }

    #[test]
    fn decodes_reference_audio_payload() {
        // TranslateResponse(event=352, data=b"\x00\xff\x10", spk_chg=True)
        let frame: &[u8] = &[16, 224, 2, 26, 3, 0, 255, 16, 56, 1];
        let response = decode_response(frame).expect("decode");
        assert_eq!(response.event, 352);
        assert_eq!(response.audio, vec![0u8, 255, 16]);
        assert!(response.spk_chg);
        assert!(response.text.is_empty());
    }

    #[test]
    fn rejects_malformed_frames() {
        assert!(decode_response(&[0x08]).is_err()); // truncated varint
        assert!(decode_response(&[0x22, 0x05, 0x61]).is_err()); // truncated length-delimited
        assert!(decode_response(&[0x0b]).is_err()); // group wire type
    }

    #[test]
    fn tolerates_unknown_fields() {
        // Field 9 (unknown to us) followed by the event field must still parse.
        let frame: &[u8] = &[72, 42, 16, 152, 1];
        let response = decode_response(frame).expect("decode");
        assert_eq!(response.event, EVENT_SESSION_FINISHED);
    }

    #[test]
    fn classifies_subtitle_events() {
        assert_eq!(
            classify_subtitle(EVENT_SOURCE_SUBTITLE_RESPONSE),
            Some(Subtitle::Source { is_final: false })
        );
        assert_eq!(
            classify_subtitle(EVENT_SOURCE_SUBTITLE_END),
            Some(Subtitle::Source { is_final: true })
        );
        assert_eq!(
            classify_subtitle(EVENT_TRANSLATION_SUBTITLE_END),
            Some(Subtitle::Translation { is_final: true })
        );
        assert_eq!(classify_subtitle(EVENT_USAGE_RESPONSE), None);
    }
}
