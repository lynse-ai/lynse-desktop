//! Feishu long-connection (WebSocket) event client.
//!
//! Ported from the official SDKs' protocol (`larksuite/node-sdk`
//! `ws-client/` and `larksuite/oapi-sdk-go` `ws/`):
//!
//! 1. `POST /callback/ws/endpoint` with `{AppID, AppSecret}` →
//!    `{code, data: {URL, ClientConfig}}`; the URL is a short-lived
//!    `wss://…` address embedding `device_id` / `service_id`.
//! 2. All WS traffic is `pbbp2.Frame` protobuf messages
//!    (`service`, `method`, repeated `{key,value}` headers, `payload`).
//!    - heartbeat: every `PingInterval` seconds send a `method=control`
//!      frame with header `type=ping`; the server answers with `type=pong`
//!      whose payload JSON re-announces the timing config.
//!    - events arrive as `method=data` frames with headers
//!      `type=event|card`, `message_id`, `sum` (fragment count), `seq`
//!      (fragment index) and `trace_id`. Large payloads are split; fragments
//!      are concatenated in `seq` order once all have arrived.
//!    - every data frame must be ACKed by echoing the frame back with an
//!      extra `biz_rt` header and payload `{"code":200}`.
//!    - auth/credential failures surface as `Handshake-Status` /
//!      `Handshake-Msg` headers — non-zero status is fatal (no retry).
//!
//! Complete `event` payloads are forwarded to the webview as
//! `feishu-event` Tauri events; connection-state changes go out as
//! `feishu-state`.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::connect_async;

use super::api::{FeishuApi, DEFAULT_DOMAIN};
use super::{FeishuHandle, FeishuStatusKind};

/// Reconnect backoff cap (the official SDKs ramp 5s steps to 32s; the floor
/// here is shorter so the first reconnect after a dropped socket is snappy).
const MIN_BACKOFF_SECS: u64 = 1;
const MAX_BACKOFF_SECS: u64 = 32;
/// Fragment assemblies older than this are dropped (never-completed events).
const FRAGMENT_TTL_SECS: u64 = 300;
/// Server watchdog: kill the session when nothing inbound for this long, so
/// the reconnect loop takes over (mirrors the node-sdk liveness option).
const INACTIVITY_TIMEOUT_SECS: u64 = 90;

const METHOD_CONTROL: i32 = 0;
const METHOD_DATA: i32 = 1;

// ── pbbp2 protobuf wire codec ───────────────────────────────────────────────
//
// Hand-rolled encoder/decoder for the two messages below (the generated code
// is mostly boilerplate; only what the protocol uses is implemented):
//
// ```proto
// message Header { required string key = 1; required string value = 2; }
// message Frame {
//   required uint64 SeqID = 1;  required uint64 LogID = 2;
//   required int32 service = 3; required int32 method = 4;
//   repeated Header headers = 5;
//   optional bytes payload = 8;
// }
// ```

#[derive(Debug, Clone, Default)]
struct PbbFrame {
    seq_id: u64,
    log_id: u64,
    service: i32,
    method: i32,
    headers: Vec<(String, String)>,
    payload: Vec<u8>,
}

fn write_varint(buffer: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            buffer.push(byte);
            return;
        }
        buffer.push(byte | 0x80);
    }
}

fn write_length_delimited(buffer: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    write_varint(buffer, ((field as u64) << 3) | 2);
    write_varint(buffer, bytes.len() as u64);
    buffer.extend_from_slice(bytes);
}

fn encode_header_bytes(key: &str, value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(key.len() + value.len() + 4);
    write_length_delimited(&mut out, 1, key.as_bytes());
    write_length_delimited(&mut out, 2, value.as_bytes());
    out
}

/// Encode a frame exactly like the SDKs do: scalar fields are always written
/// (proto2 `required`), headers as length-delimited submessages.
fn encode_frame(frame: &PbbFrame) -> Vec<u8> {
    let mut out = Vec::new();
    write_varint(&mut out, 1 << 3);
    write_varint(&mut out, frame.seq_id);
    write_varint(&mut out, 2 << 3);
    write_varint(&mut out, frame.log_id);
    write_varint(&mut out, 3 << 3);
    write_varint(&mut out, frame.service as u64);
    write_varint(&mut out, 4 << 3);
    write_varint(&mut out, frame.method as u64);
    for (key, value) in &frame.headers {
        write_length_delimited(&mut out, 5, &encode_header_bytes(key, value));
    }
    if !frame.payload.is_empty() {
        write_length_delimited(&mut out, 8, &frame.payload);
    }
    out
}

struct ProtobufReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> ProtobufReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn read_varint(&mut self) -> Result<u64, String> {
        let mut result: u64 = 0;
        let mut shift = 0;
        loop {
            let byte = *self
                .bytes
                .get(self.position)
                .ok_or("truncated protobuf varint")?;
            self.position += 1;
            result |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift >= 64 {
                return Err("protobuf varint too long".to_owned());
            }
        }
    }

    fn read_bytes(&mut self) -> Result<&'a [u8], String> {
        let length = self.read_varint()? as usize;
        let end = self
            .position
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or("truncated protobuf field")?;
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn skip(&mut self, count: usize) -> Result<(), String> {
        let end = self
            .position
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or("truncated protobuf field")?;
        self.position = end;
        Ok(())
    }

    fn at_end(&self) -> bool {
        self.position >= self.bytes.len()
    }
}

fn decode_frame(bytes: &[u8]) -> Result<PbbFrame, String> {
    let mut reader = ProtobufReader::new(bytes);
    let mut frame = PbbFrame::default();
    while !reader.at_end() {
        let tag = reader.read_varint()?;
        match (tag >> 3) as u32 {
            1 => frame.seq_id = reader.read_varint()?,
            2 => frame.log_id = reader.read_varint()?,
            3 => frame.service = reader.read_varint()? as u32 as i32,
            4 => frame.method = reader.read_varint()? as u32 as i32,
            5 => {
                let header_reader = ProtobufReader::new(reader.read_bytes()?);
                frame.headers.push(decode_header(header_reader)?);
            }
            8 => frame.payload = reader.read_bytes()?.to_vec(),
            // payloadEncoding / payloadType / LogIDNew are unused here; skip
            // anything unknown by wire type.
            _ => skip_field(&mut reader, tag)?,
        }
    }
    Ok(frame)
}

fn decode_header(mut reader: ProtobufReader<'_>) -> Result<(String, String), String> {
    let mut key = String::new();
    let mut value = String::new();
    while !reader.at_end() {
        let tag = reader.read_varint()?;
        match (tag >> 3) as u32 {
            1 => key = String::from_utf8_lossy(reader.read_bytes()?).into_owned(),
            2 => value = String::from_utf8_lossy(reader.read_bytes()?).into_owned(),
            _ => skip_field(&mut reader, tag)?,
        }
    }
    Ok((key, value))
}

/// Skip a field of any wire type so unknown/unused fields never abort a parse.
fn skip_field(reader: &mut ProtobufReader<'_>, tag: u64) -> Result<(), String> {
    match tag & 0x7 {
        0 => {
            reader.read_varint()?;
        }
        1 => reader.skip(8)?, // fixed64
        2 => {
            reader.read_bytes()?;
        }
        5 => reader.skip(4)?, // fixed32
        wire => return Err(format!("unsupported protobuf wire type {wire}")),
    }
    Ok(())
}

// ── Fragment reassembly ─────────────────────────────────────────────────────

struct FragmentAssembly {
    parts: Vec<Option<Vec<u8>>>,
    touched_at: std::time::Instant,
}

#[derive(Default)]
struct FragmentCache {
    entries: HashMap<String, FragmentAssembly>,
}

impl FragmentCache {
    /// Feed one fragment in; when this completes a message, returns the
    /// concatenated payload in `seq` order.
    fn push(&mut self, message_id: &str, total: usize, seq: usize, payload: &[u8]) -> Option<Vec<u8>> {
        let total = total.max(1);
        let entry = self
            .entries
            .entry(message_id.to_owned())
            .or_insert_with(|| FragmentAssembly {
                parts: vec![None; total],
                touched_at: std::time::Instant::now(),
            });
        entry.touched_at = std::time::Instant::now();
        if seq < entry.parts.len() {
            entry.parts[seq] = Some(payload.to_vec());
        }
        if !entry.parts.iter().all(Option::is_some) {
            return None;
        }
        let mut merged = Vec::new();
        for part in entry.parts.drain(..) {
            merged.extend_from_slice(&part.unwrap_or_default());
        }
        self.entries.remove(message_id);
        Some(merged)
    }

    fn sweep(&mut self) {
        let ttl = Duration::from_secs(FRAGMENT_TTL_SECS);
        self.entries
            .retain(|_, entry| entry.touched_at.elapsed() < ttl);
    }
}

// ── Session lifecycle ───────────────────────────────────────────────────────

/// Why one `connect_and_serve` call returned.
enum SessionOutcome {
    /// User stopped the bot (or disabled it) — do not reconnect.
    Stopped,
    /// Non-recoverable failure (bad credentials, handshake rejected).
    Fatal(String),
    /// Connection dropped — retry with backoff.
    Retry,
}

/// Top-level connection loop: runs until the generation counter is bumped
/// (bot stopped / config saved) or a fatal error occurs. Spawned through
/// [`super::start_bot`] on the Tauri async runtime.
pub(crate) async fn run_session(app: AppHandle, generation: u64) {
    let handle = app.state::<FeishuHandle>();
    let mut backoff_secs = MIN_BACKOFF_SECS;
    let mut attempted = false;
    loop {
        if handle.generation.load(Ordering::SeqCst) != generation {
            break;
        }
        let config = super::load_config(&app).unwrap_or_default();
        if !config.enabled || config.app_id.trim().is_empty() {
            handle.set_status(&app, FeishuStatusKind::Disabled, None);
            break;
        }
        handle.set_status(
            &app,
            if attempted {
                FeishuStatusKind::Reconnecting
            } else {
                FeishuStatusKind::Connecting
            },
            None,
        );
        attempted = true;

        let secret = match super::secret(&app) {
            Ok(secret) => secret,
            Err(error) => {
                handle.set_status(&app, FeishuStatusKind::Error, Some(error));
                break;
            }
        };
        let api = match FeishuApi::new(DEFAULT_DOMAIN, &config.app_id, &secret) {
            Ok(api) => api,
            Err(error) => {
                handle.set_status(&app, FeishuStatusKind::Error, Some(error));
                break;
            }
        };
        // The bot's own open_id powers "@bot" detection in groups. Fetched
        // once per session; an empty value falls back to any-mention.
        let bot_open_id = match super::tenant_token(&app, &api).await {
            Ok(token) => api.bot_open_id(&token).await.unwrap_or_default(),
            Err(_) => String::new(),
        };

        match connect_and_serve(&app, &api, generation, &bot_open_id).await {
            SessionOutcome::Stopped => break,
            SessionOutcome::Fatal(error) => {
                handle.set_status(&app, FeishuStatusKind::Error, Some(error));
                break;
            }
            SessionOutcome::Retry => {
                handle.set_status(&app, FeishuStatusKind::Reconnecting, None);
                // Full jitter so several desktop clients never sync up.
                let jitter = rand_jitter(backoff_secs);
                tokio::time::sleep(Duration::from_secs(jitter.max(1))).await;
                backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
            }
        }
    }
}

/// Deterministic jitter in `1..=secs` without pulling in `rand`.
fn rand_jitter(secs: u64) -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos() as u64)
        .unwrap_or(0);
    1 + nanos % secs.max(1)
}

/// Dial the gateway and pump frames until the socket drops or the bot is
/// stopped. Outbound frames (pings, ACKs) funnel through one channel so only
/// the writer task ever touches the sink.
async fn connect_and_serve(
    app: &AppHandle,
    api: &FeishuApi,
    generation: u64,
    bot_open_id: &str,
) -> SessionOutcome {
    let handle = app.state::<FeishuHandle>();
    let connect = match api.pull_connect_config().await {
        Ok(connect) => connect,
        Err(error) => return classify_connect_error(&error),
    };
    let (ws, _response) = match connect_async(connect.url.as_str()).await {
        Ok(pair) => pair,
        Err(error) => {
            log::info!("[feishu-ws] dial failed: {error}");
            return SessionOutcome::Retry;
        }
    };
    let (mut writer, mut reader) = ws.split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(64);
    let writer_task = tokio::spawn(async move {
        while let Some(bytes) = outbound_rx.recv().await {
            if writer.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
        let _ = writer.close().await;
    });

    handle.set_status(app, FeishuStatusKind::Online, None);

    let mut fragments = FragmentCache::default();
    let mut ping_interval = tokio::time::interval(Duration::from_secs(
        connect.ping_interval_secs.clamp(5, 300),
    ));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick of a fresh interval fires immediately; the connection is
    // brand new, so push it one full period out.
    ping_interval.reset();
    // Liveness deadline — `Sleep` is !Unpin, so instead of storing a future we
    // store a deadline and create a fresh `sleep_until` per select iteration.
    let mut activity_deadline =
        tokio::time::Instant::now() + Duration::from_secs(INACTIVITY_TIMEOUT_SECS);

    let outcome = loop {
        if handle.generation.load(Ordering::SeqCst) != generation {
            break SessionOutcome::Stopped;
        }
        tokio::select! {
            _ = ping_interval.tick() => {
                let ping = PbbFrame {
                    service: connect.service_id,
                    method: METHOD_CONTROL,
                    headers: vec![("type".to_owned(), "ping".to_owned())],
                    ..PbbFrame::default()
                };
                if outbound_tx.try_send(encode_frame(&ping)).is_err() {
                    break SessionOutcome::Retry;
                }
            }
            _ = tokio::time::sleep_until(activity_deadline) => {
                log::warn!("[feishu-ws] no inbound frame for {INACTIVITY_TIMEOUT_SECS}s; reconnecting");
                break SessionOutcome::Retry;
            }
            inbound = reader.next() => {
                let Some(message) = inbound else {
                    break SessionOutcome::Retry;
                };
                let message = match message {
                    Ok(message) => message,
                    Err(error) => {
                        log::info!("[feishu-ws] socket closed: {error}");
                        break SessionOutcome::Retry;
                    }
                };
                let Message::Binary(bytes) = message else {
                    continue;
                };
                activity_deadline =
                    tokio::time::Instant::now() + Duration::from_secs(INACTIVITY_TIMEOUT_SECS);
                match handle_frame(app, &outbound_tx, &mut fragments, bytes.as_ref(), bot_open_id) {
                    FrameResult::Continue => {}
                    FrameResult::Fatal(error) => break SessionOutcome::Fatal(error),
                }
            }
        }
    };

    // Close the socket cleanly so the writer task ends, then wait for it.
    drop(outbound_tx);
    let _ = writer_task.await;
    outcome
}

/// `AppSecret` mistakes and revoked subscriptions are permanent; everything
/// else is worth a retry.
fn classify_connect_error(error: &str) -> SessionOutcome {
    if error.contains("code=514") || error.contains("code=403") {
        SessionOutcome::Fatal(error.to_owned())
    } else {
        SessionOutcome::Retry
    }
}

enum FrameResult {
    Continue,
    Fatal(String),
}

/// Process one inbound binary frame. Data frames are ACKed first (echo the
/// frame + `biz_rt`, payload `{"code":200}`), then merged; completed events
/// are forwarded to the webview.
fn handle_frame(
    app: &AppHandle,
    outbound: &mpsc::Sender<Vec<u8>>,
    fragments: &mut FragmentCache,
    bytes: &[u8],
    bot_open_id: &str,
) -> FrameResult {
    let frame = match decode_frame(bytes) {
        Ok(frame) => frame,
        Err(error) => {
            log::warn!("[feishu-ws] undecodable frame dropped: {error}");
            return FrameResult::Continue;
        }
    };

    let header = |name: &str| -> Option<&str> {
        frame
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    };    // Credential / subscription rejections ride in as handshake headers.
    if let Some(status) = header("Handshake-Status") {
        if status != "0" {
            let message = header("Handshake-Msg").unwrap_or("handshake rejected");
            return FrameResult::Fatal(format!(
                "Feishu handshake failed: {message} (status {status})"
            ));
        }
    }

    if frame.method != METHOD_DATA {
        // Control frames: the pong payload re-announces timing; this port
        // re-reads the interval on every (re)connect, so nothing to do here.
        return FrameResult::Continue;
    }

    // ACK first — even fragments — exactly like the official SDKs.
    let mut ack = frame.clone();
    ack.headers.push(("biz_rt".to_owned(), "0".to_owned()));
    ack.payload = br#"{"code":200}"#.to_vec();
    if outbound.try_send(encode_frame(&ack)).is_err() {
        return FrameResult::Continue;
    }

    let kind = header("type").unwrap_or_default();
    if kind != "event" {
        return FrameResult::Continue;
    }
    let message_id = header("message_id").unwrap_or_default();
    let total = header("sum")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1);
    let seq = header("seq")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if let Some(payload) = fragments.push(message_id, total, seq, &frame.payload) {
        fragments.sweep();
        emit_event(app, payload.as_slice(), bot_open_id);
    }
    FrameResult::Continue
}

/// Parse a complete event envelope and forward chat messages to the webview.
fn emit_event(app: &AppHandle, payload: &[u8], bot_open_id: &str) {
    let envelope: Value = match serde_json::from_slice(payload) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("[feishu-ws] event payload is not JSON: {error}");
            return;
        }
    };
    let event_type = envelope
        .pointer("/header/event_type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // v1 scope: only chat messages are handled client-side today.
    if event_type != "im.message.receive_v1" {
        log::debug!("[feishu-ws] ignoring event type {event_type}");
        return;
    }

    let message = envelope.pointer("/event/message").cloned().unwrap_or_default();
    let sender = envelope.pointer("/event/sender").cloned().unwrap_or_default();

    // message.content is a JSON string like {"text":"@_user_1 hi"}.
    let text = message
        .get("content")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|content| {
            content
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default();

    let mentions = message
        .get("mentions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // When the bot's open_id is known, only a mention of the bot counts;
    // otherwise fall back to "any mention in a group targets the bot".
    let mentioned_bot = if bot_open_id.is_empty() {
        !mentions.is_empty()
    } else {
        mentions
            .iter()
            .any(|mention| mention.get("id").and_then(Value::as_str) == Some(bot_open_id))
    };

    let app = app.clone();
    if let Err(error) = app.emit(
        // Unified bot-channel event: the payload carries `channel` so the
        // frontend agent can route it without a per-channel listener.
        crate::bots::BOT_EVENT,
        serde_json::json!({
            "channel": crate::bots::CHANNEL_FEISHU,
            "eventId": envelope.pointer("/header/event_id").and_then(Value::as_str).unwrap_or_default(),
            "eventType": event_type,
            "messageId": message.get("message_id").and_then(Value::as_str).unwrap_or_default(),
            "chatId": message.get("chat_id").and_then(Value::as_str).unwrap_or_default(),
            "chatType": message.get("chat_type").and_then(Value::as_str).unwrap_or_default(),
            "messageType": message.get("message_type").and_then(Value::as_str).unwrap_or_default(),
            "senderId": sender.pointer("/sender_id/open_id").and_then(Value::as_str).unwrap_or_default(),
            "senderType": sender.get("sender_type").and_then(Value::as_str).unwrap_or_default(),
            "text": text,
            "mentions": mentions,
            "mentionedBot": mentioned_bot,
        }),
    ) {
        log::error!("[feishu-ws] failed to emit event: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-computed wire bytes for the exact ping frame the official SDKs
    /// send: `Frame{SeqID:0, LogID:0, service:1, method:0,
    /// headers:[{key:"type", value:"ping"}]}`. Pins the hand-rolled codec to
    /// the protobufjs encoding.
    #[test]
    fn ping_frame_matches_reference_encoding() {
        let frame = PbbFrame {
            service: 1,
            method: METHOD_CONTROL,
            headers: vec![("type".to_owned(), "ping".to_owned())],
            ..PbbFrame::default()
        };
        let bytes = encode_frame(&frame);
        let expected: Vec<u8> = vec![
            0x08, 0x00, // SeqID = 0
            0x10, 0x00, // LogID = 0
            0x18, 0x01, // service = 1
            0x20, 0x00, // method = 0 (control)
            0x2A, 0x0C, // headers, 12-byte submessage
            0x0A, 0x04, b't', b'y', b'p', b'e', // key = "type"
            0x12, 0x04, b'p', b'i', b'n', b'g', // value = "ping"
        ];
        assert_eq!(bytes, expected);
        // Decoding round-trips to the same frame.
        let decoded = decode_frame(&bytes).unwrap();
        assert_eq!(decoded.seq_id, 0);
        assert_eq!(decoded.service, 1);
        assert_eq!(decoded.method, METHOD_CONTROL);
        assert_eq!(decoded.headers, frame.headers);
    }

    #[test]
    fn frame_with_payload_round_trips() {
        let frame = PbbFrame {
            seq_id: 7,
            log_id: 9,
            service: 2,
            method: METHOD_DATA,
            headers: vec![
                ("message_id".to_owned(), "msg_1".to_owned()),
                ("sum".to_owned(), "1".to_owned()),
                ("seq".to_owned(), "0".to_owned()),
                ("type".to_owned(), "event".to_owned()),
            ],
            payload: br#"{"code":200}"#.to_vec(),
        };
        let decoded = decode_frame(&encode_frame(&frame)).unwrap();
        assert_eq!(decoded.seq_id, 7);
        assert_eq!(decoded.log_id, 9);
        assert_eq!(decoded.service, 2);
        assert_eq!(decoded.method, METHOD_DATA);
        assert_eq!(decoded.headers, frame.headers);
        assert_eq!(decoded.payload, frame.payload);
    }

    /// Unknown trailing fields (e.g. `payloadEncoding` from newer servers)
    /// must not break the parser.
    #[test]
    fn decode_skips_unknown_fields() {
        // Ping frame bytes + field 6 (payloadEncoding) = "raw" (LEN wire type).
        let mut bytes = encode_frame(&PbbFrame {
            service: 1,
            method: METHOD_CONTROL,
            headers: vec![("type".to_owned(), "ping".to_owned())],
            ..PbbFrame::default()
        });
        bytes.extend_from_slice(&[0x32, 0x03, b'r', b'a', b'w']);
        let decoded = decode_frame(&bytes).unwrap();
        assert_eq!(decoded.headers[0].1, "ping");
    }

    #[test]
    fn fragments_merge_only_when_complete() {
        let mut cache = FragmentCache::default();
        let full = b"hello-feishu-event";
        let (a, b) = full.split_at(7);
        assert!(cache.push("m1", 2, 0, a).is_none(), "incomplete merge must wait");
        // Out-of-order delivery: the last fragment completes the message and
        // returns the concatenation in seq order.
        let merged = cache.push("m1", 2, 1, b).expect("complete merge");
        assert_eq!(merged, full.to_vec());
        // Repeated/late frames for a finished message start a new assembly.
        assert!(cache.push("m1", 1, 0, b"ping").is_some());
    }

    #[test]
    fn ack_frame_carries_code_200_and_echoes_identity() {
        let inbound = PbbFrame {
            seq_id: 3,
            log_id: 4,
            service: 5,
            method: METHOD_DATA,
            headers: vec![
                ("message_id".to_owned(), "m".to_owned()),
                ("type".to_owned(), "event".to_owned()),
            ],
            payload: b"{}".to_vec(),
        };
        let mut ack = inbound.clone();
        ack.headers.push(("biz_rt".to_owned(), "0".to_owned()));
        ack.payload = br#"{"code":200}"#.to_vec();
        let decoded = decode_frame(&encode_frame(&ack)).unwrap();
        assert_eq!(decoded.seq_id, inbound.seq_id);
        assert_eq!(decoded.service, inbound.service);
        assert_eq!(decoded.method, METHOD_DATA);
        assert_eq!(
            decoded.headers.iter().find(|(key, _)| key == "biz_rt").map(|(_, value)| value.as_str()),
            Some("0")
        );
    }
}
