//! Tencent Cloud real-time ASR: raw PCM frames over a URL-signed websocket,
//! JSON result frames back. Recognition only — the service has no
//! translation leg, so a translation target is ignored.
//!
//! Authentication happens through the URL itself (the query string is
//! HMAC-signed) and binds the signature to a one-shot voice_id, so every
//! websocket (re)connect signs a fresh URL; reusing one would make every
//! reconnect after the first a hard failure.

use std::time::Duration;

use tauri::AppHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;

use super::super::ingest_provider_text;
use crate::tencent_asr::{self, TencentCredentials};
use super::{InboundOutcome, LiveProtocol, Outbound, ProtocolCtx, SetupFrames};
use super::super::{ProviderEmission, emit_provider_emission};

/// Milliseconds of trailing audio to accept after the close before giving up.
const FINISH_GRACE: Duration = Duration::from_secs(3);

/// Paced in 40 ms chunks (the vendor-recommended frame size).
const CHUNK_BYTES: usize = tencent_asr::CHUNK_BYTES;

pub(super) struct TencentProtocol {
    /// Raw descriptor extras; re-parsed on each (re)connect attempt via
    /// [`Self::credentials`] so a parse problem surfaces the same way the
    /// pre-refactor loop surfaced it.
    extra: std::collections::HashMap<String, String>,
    credentials: Option<TencentCredentials>,
    pending: Vec<u8>,
}

impl TencentProtocol {
    pub(super) fn new(extra: std::collections::HashMap<String, String>) -> Result<Self, String> {
        let credentials = Some(TencentCredentials::from_extra(&extra)?);
        Ok(Self {
            extra,
            credentials,
            pending: Vec::new(),
        })
    }

    fn credentials(&self) -> &TencentCredentials {
        self.credentials
            .as_ref()
            .expect("tencent provider without parsed credentials")
    }
}

impl LiveProtocol for TencentProtocol {
    fn prepare_request(&self, url: &str, request: &mut Request) -> Result<(), String> {
        let signed = tencent_asr::build_signed_url(url, self.credentials())?;
        *request = signed
            .as_str()
            .into_client_request()
            .map_err(|error| format!("实时翻译连接地址无效：{error}"))?;
        Ok(())
    }

    /// No session-setup frame: the signed URL's query parameters carry the
    /// whole configuration.
    fn on_connected(&mut self, _ctx: &ProtocolCtx) -> Result<SetupFrames, String> {
        self.pending = Vec::with_capacity(CHUNK_BYTES);
        Ok(Vec::new())
    }

    fn encode_audio(&mut self, pcm: &[u8]) -> Vec<Outbound> {
        self.pending.extend_from_slice(pcm);
        let mut frames = Vec::new();
        while self.pending.len() >= CHUNK_BYTES {
            let rest = self.pending.split_off(CHUNK_BYTES);
            let chunk = std::mem::replace(&mut self.pending, rest);
            frames.push(Outbound::Binary(chunk));
        }
        frames
    }

    /// No end-of-audio frame: flush the tail and close; the server answers
    /// with its final results before dropping the connection.
    fn finish(&mut self) -> (Vec<Outbound>, Duration) {
        let mut frames = Vec::new();
        if !self.pending.is_empty() {
            let chunk = std::mem::take(&mut self.pending);
            frames.push(Outbound::Binary(chunk));
        }
        (frames, FINISH_GRACE)
    }

    fn validate(&self) -> Result<(), String> {
        // Fail fast on credential shape before any audio flows; the same
        // parse happens again on every (re)connect via prepare_request.
        if let Some((name, _)) = self
            .extra
            .iter()
            .find(|(_, value)| super::super::credential_has_invisible_chars(value.trim()))
        {
            return Err(format!(
                "腾讯引擎凭证 {name} 包含不可见字符（复制时可能带入了隐藏字符），请删除后重新输入。"
            ));
        }
        TencentCredentials::from_extra(&self.extra)?;
        Ok(())
    }

    fn handle_text(
        &mut self,
        app: &AppHandle,
        ctx: &ProtocolCtx,
        text: &str,
    ) -> InboundOutcome {
        let response = match serde_json::from_str::<tencent_asr::AsrResponse>(text) {
            Ok(response) => response,
            Err(error) => {
                log::warn!("tencent-asr: 无法解析响应：{error}");
                return InboundOutcome::Ignored;
            }
        };
        if response.code != 0 {
            let detail = if response.message.is_empty() {
                format!("状态码 {}", response.code)
            } else {
                response.message.clone()
            };
            return InboundOutcome::Redial(format!(
                "腾讯实时识别错误（{}）：{detail}",
                response.code
            ));
        }
        if response.is_final == 1 {
            // The server considers the speech over and is about to close; the
            // reconnect loop keeps the stream alive for the next utterance. A
            // final result proves the pipeline works — clear the streak so the
            // next utterance redials promptly.
            return InboundOutcome::GotResultAndRedial;
        }
        let Some(result) = &response.result else {
            return InboundOutcome::Ignored;
        };
        let emission = handle_tencent_result(ctx, result, &response.message_id);
        let got_result = emission.is_some();
        emit_provider_emission(app, emission);
        if got_result {
            InboundOutcome::GotResult
        } else {
            InboundOutcome::Ignored
        }
    }
}

/// Route one Tencent ASR result frame onto the shared live-segment model.
///
/// The service recognises only — there is no translation leg — so every frame
/// updates the recognized track. `slice_type` 2 closes the sentence; start and
/// interim frames carry the rolling text for the open utterance. Timestamps
/// are milliseconds relative to this connection's audio, the same shape the
/// Volcengine path rebases via `stream_offset_ms`.
fn handle_tencent_result(
    ctx: &ProtocolCtx,
    result: &tencent_asr::AsrResult,
    message_id: &str,
) -> Option<ProviderEmission> {
    let text = result.voice_text.clone();
    if text.trim().is_empty() {
        return None;
    }
    let is_final = result.slice_type == 2;
    // Before the first timestamped frame we fall back to the capture clock,
    // the same approximation the Volcengine and Qwen paths use.
    let start_ms = if result.start_time > 0 {
        ctx.epoch_offset_ms.saturating_add(result.start_time as u64)
    } else {
        ctx.epoch_offset_ms
            .saturating_add(ctx.session.last_elapsed_ms.load(std::sync::atomic::Ordering::Relaxed))
    };
    let end_ms = (result.end_time > 0)
        .then(|| ctx.epoch_offset_ms.saturating_add(result.end_time as u64));
    ingest_provider_text(
        ctx.session,
        ctx.source,
        ctx.epoch,
        None,
        start_ms,
        end_ms,
        true,
        is_final,
        message_id.to_owned(),
        None,
        &text,
    )
}
