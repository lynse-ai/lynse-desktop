//! Plain JSON `method`-frame protocol: the Lynse backend relay and the
//! iLiveData RTVT direct client. Raw PCM goes up as binary frames; results
//! come back as JSON objects discriminated by a `method` field
//! (`recognizedResult` / `…TempResult` / `translatedResult` / `…TempResult`).

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::handshake::client::Request;

use super::super::ingest_provider_text;
use super::{
    InboundOutcome, LiveProtocol, Outbound, ProtocolCtx, SetupFrames, value_string, value_u64,
};
use super::super::ProviderEmission;

/// Timestamps at or above this bound cannot be session-relative offsets — as
/// elapsed ms it would mean a recording over 11 days long — so they must be
/// absolute Unix epoch ms (the 2001 era onward). iLiveData reports utterance
/// `startTs`/`endTs` this way; other providers report ms since stream open.
const ABSOLUTE_TIMESTAMP_MS: u64 = 1_000_000_000_000;

/// Map a provider timestamp onto the recording-relative timeline. Absolute
/// epoch ms are rebased against the session's wall-clock start; relative
/// offsets keep the stream-attach anchor (`epoch_offset_ms`).
fn rebase_provider_timestamp(raw: u64, wall_start_ms: u64, epoch_offset_ms: u64) -> u64 {
    if raw >= ABSOLUTE_TIMESTAMP_MS {
        raw.saturating_sub(wall_start_ms)
    } else {
        epoch_offset_ms.saturating_add(raw)
    }
}

pub(super) struct DirectProtocol;

impl LiveProtocol for DirectProtocol {
    /// No handshake auth: the backend relay's URLs are signed server-side and
    /// iLiveData carries its HMAC token in the query string.
    fn prepare_request(&self, _url: &str, _request: &mut Request) -> Result<(), String> {
        Ok(())
    }

    fn on_connected(&mut self, _ctx: &ProtocolCtx) -> Result<SetupFrames, String> {
        Ok(Vec::new())
    }

    /// Raw 20 ms PCM frames, exactly as captured.
    fn encode_audio(&mut self, pcm: &[u8]) -> Vec<Outbound> {
        vec![Outbound::Binary(pcm.to_vec())]
    }

    fn finish(&mut self) -> (Vec<Outbound>, Duration) {
        (
            vec![Outbound::Text(r#"{"method":"voiceEnd"}"#.to_owned())],
            Duration::from_secs(3),
        )
    }

    fn handle_text(
        &mut self,
        app: &AppHandle,
        ctx: &ProtocolCtx,
        text: &str,
    ) -> InboundOutcome {
        let emission = apply_provider_message(ctx, text);
        let got_result = emission.is_some();
        super::super::emit_provider_emission(app, emission);
        if got_result {
            InboundOutcome::GotResult
        } else {
            InboundOutcome::Ignored
        }
    }
}

/// Apply one relay/iLiveData message: parse the `method` frame, rebase its
/// timestamps onto the recording timeline and ingest the text. `pub(super)`
/// so the parent module's unit tests can pin the final-wins/interim
/// semantics through this protocol.
pub(crate) fn apply_provider_message(ctx: &ProtocolCtx, text: &str) -> Option<ProviderEmission> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let method = value.get("method").and_then(Value::as_str)?;
    if !matches!(
        method,
        "recognizedResult" | "recognizedTempResult" | "translatedResult" | "translatedTempResult"
    ) {
        return None;
    }
    let is_recognized = matches!(method, "recognizedResult" | "recognizedTempResult");
    let is_final_method = matches!(method, "recognizedResult" | "translatedResult");
    let stream_id = value_string(&value, "streamId");
    let wall_start_ms = ctx
        .session
        .wall_start_ms
        .load(std::sync::atomic::Ordering::Relaxed);
    let start_ms = rebase_provider_timestamp(
        value_u64(&value, "startTs"),
        wall_start_ms,
        ctx.epoch_offset_ms,
    );
    let raw_end = value_u64(&value, "endTs");
    let end_ms =
        (raw_end > 0).then(|| rebase_provider_timestamp(raw_end, wall_start_ms, ctx.epoch_offset_ms));
    let incoming = value_string(&value, if is_recognized { "asr" } else { "trans" })
        .unwrap_or_default();
    if incoming.is_empty() {
        return None;
    }
    // Utterance key: prefer the provider task id, fall back to the start
    // timestamp (stable per utterance for most providers).
    let task_id = value_string(&value, "taskId")
        .unwrap_or_else(|| value_u64(&value, "startTs").to_string());
    // iLiveData diarization: every result carries `SpeakerId` as a JSON number,
    // with -1 meaning "not recognised" (diarization disabled, or the engine has
    // not settled on a speaker yet). Normalise the provider's 0-based id onto
    // the same 1-based speaker index the Volcengine path uses.
    let speaker = value
        .get("SpeakerId")
        .and_then(Value::as_i64)
        .filter(|id| *id >= 0)
        .map(|id| (id as u32).saturating_add(1));
    ingest_provider_text(
        ctx.session,
        ctx.source,
        ctx.epoch,
        stream_id,
        start_ms,
        end_ms,
        is_recognized,
        is_final_method,
        task_id,
        speaker,
        &incoming,
    )
}
