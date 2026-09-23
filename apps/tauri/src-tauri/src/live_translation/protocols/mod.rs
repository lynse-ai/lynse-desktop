//! Wire-protocol adapters for the live-translation websocket loop.
//!
//! Every provider plugin on the frontend speaks one of the protocols
//! implemented here; the connection descriptor's `provider` tag selects the
//! adapter (`protocol_for`). Adding a provider that reuses an existing wire
//! protocol needs no Rust change — a genuinely new protocol adds one file
//! implementing [`LiveProtocol`] plus an arm in `protocol_for`.
//!
//! The adapters own everything protocol-specific: handshake auth, session
//! setup, audio framing, end-of-stream signalling and inbound decoding
//! (converging on the shared [`super::ingest_provider_text`] core). The
//! connection loop keeps the provider-agnostic plumbing: reconnect backoff,
//! ping liveness probes, stale-audio draining and stream-state events.

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::HeaderName;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use super::{AudioSource, ConnectionDescriptor, LiveSession};

pub(super) mod dashscope;
pub(super) mod direct;
pub(super) mod tencent;
pub(super) mod volc;

/// One frame an adapter wants on the wire.
#[derive(Debug)]
pub(crate) enum Outbound {
    Text(String),
    Binary(Vec<u8>),
}

/// Per-call context for inbound handling; the session's language fields are
/// read live so a mid-session `set_mode` applies on the next reconnect.
pub(crate) struct ProtocolCtx<'a> {
    pub session: &'a LiveSession,
    pub source: AudioSource,
    pub epoch: u32,
    pub epoch_offset_ms: u64,
}

/// What the connection loop should do after one inbound frame.
#[derive(Debug)]
pub(super) enum InboundOutcome {
    /// Bookkeeping only — keep the stream as is. The adapter may already
    /// have emitted a diagnostic.
    Ignored,
    /// A real recognition/translation result was ingested: proof the provider
    /// pipeline works, clearing the reconnect failure streak unconditionally
    /// (even inside the connection grace window).
    GotResult,
    /// A result was ingested and the stream should redial — Tencent closes
    /// the connection after every final result by design.
    GotResultAndRedial,
    /// Emit this message and redial (provider session-level failure).
    Redial(String),
    /// The provider finished the session cleanly — close and stop the loop.
    StreamFinished,
}

/// Frames to send right after the handshake, each carrying the label for its
/// send-failure error (they differ per provider in the diagnostics).
pub(crate) type SetupFrames = Vec<(Outbound, &'static str)>;

/// The provider-facing half of a translation stream. All methods are sync —
/// adapters only PRODUCE frames; the loop performs the actual socket writes.
pub(crate) trait LiveProtocol: Send {
    /// Mutate the websocket upgrade request for one connect attempt: attach
    /// auth headers or re-sign the URL. An error stops the stream for good
    /// (a config problem reconnecting would only spin).
    fn prepare_request(&self, url: &str, request: &mut Request) -> Result<(), String>;

    /// Frames sent right after the handshake (session setup). Send failures
    /// are reported with the per-frame label and redial the stream.
    fn on_connected(&mut self, ctx: &ProtocolCtx) -> Result<SetupFrames, String>;

    /// Encode one 20 ms PCM capture frame into provider wire frames. Send
    /// failures redial the stream.
    fn encode_audio(&mut self, pcm: &[u8]) -> Vec<Outbound>;

    /// End-of-stream frames plus how long to wait for trailing results
    /// before giving up on the socket.
    fn finish(&mut self) -> (Vec<Outbound>, Duration);

    /// True when a text frame acknowledges the finished stream (DashScope's
    /// `session.finished`); only consulted after `finish` was sent.
    fn is_finish_ack(&self, text: &str) -> bool {
        let _ = text;
        false
    }

    /// Decode and ingest one text frame.
    fn handle_text(&mut self, app: &AppHandle, ctx: &ProtocolCtx, text: &str)
        -> InboundOutcome;

    /// Decode and ingest one binary frame. Only the Volcengine protocol is
    /// binary — the default ignores binary frames entirely.
    fn handle_binary(&mut self, _app: &AppHandle, _ctx: &ProtocolCtx, _frame: &[u8]) -> InboundOutcome {
        InboundOutcome::Ignored
    }

    /// Fail fast on credential-shape problems before any audio flows.
    fn validate(&self) -> Result<(), String> {
        Ok(())
    }
}

/// Build the adapter for one connection descriptor. An unknown provider tag
/// is a hard error — silently falling back to another protocol would dial a
/// gate that cannot understand the audio we send.
pub(super) fn protocol_for(
    connection: &ConnectionDescriptor,
    transcript_only: bool,
) -> Result<Box<dyn LiveProtocol + Send>, String> {
    match connection.provider.as_deref() {
        // Untagged connections are the backend-relay minted URLs and the
        // iLiveData direct client — both speak the plain JSON protocol.
        None | Some("") | Some("backend") | Some("lynse_backend") | Some("direct")
        | Some("ilivedata_direct") => Ok(Box::new(direct::DirectProtocol)),
        // "qwen" is the legacy tag the built-in Qwen plugin still stamps;
        // "dashscope" is the generic protocol name (the custom provider).
        Some("qwen") | Some("dashscope") => Ok(Box::new(dashscope::DashScopeProtocol::new(
            connection.api_key.clone().unwrap_or_default(),
            connection.extra.clone().unwrap_or_default(),
            transcript_only,
        ))),
        Some("volc") => Ok(Box::new(volc::VolcProtocol::new(
            connection.api_key.clone().unwrap_or_default(),
            transcript_only,
        ))),
        Some("tencent") => Ok(Box::new(tencent::TencentProtocol::new(
            connection.extra.clone().unwrap_or_default(),
        )?)),
        Some(other) => Err(format!("未知的实时翻译引擎协议：{other}")),
    }
}

/// Attach a header, ignoring the (impossible for visible ASCII) build error
/// the same way the pre-refactor code did.
pub(super) fn attach_header(request: &mut Request, name: &str, value: String) {
    if let Ok(value) = HeaderValue::from_str(&value) {
        if let Ok(name) = name.parse::<HeaderName>() {
            request.headers_mut().insert(name, value);
        }
    }
}

// ── small JSON helpers shared by the text-frame protocols ──────────────────

pub(super) fn value_string(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

pub(super) fn value_u64(value: &Value, key: &str) -> u64 {
    value_string(value, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or_default()
}
