//! DashScope realtime protocol (OpenAI-Realtime-style JSON events) — spoken
//! by Qwen Live Translate and any compatible service the user configures.
//!
//! Auth is a `Bearer` key on the upgrade request; a `session.update` configures
//! translation and/or source-language ASR right after the handshake; audio
//! streams as base64 `input_audio_buffer.append` text events; the session ends
//! with `session.finish` and waits for the server's `session.finished` ack.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::handshake::client::Request;

use super::super::ingest_provider_text;
use super::{
    InboundOutcome, LiveProtocol, Outbound, ProtocolCtx, SetupFrames, attach_header,
    value_string,
};
use super::super::{ProviderEmission, emit_error};

/// Default ASR model requested in `session.update`; a DashScope-compatible
/// service that names its recognition model differently overrides it via the
/// connection descriptor's `extra.asrModel` (the custom provider plugin).
const DEFAULT_ASR_MODEL: &str = "qwen3-asr-flash-realtime";

pub(crate) struct DashScopeProtocol {    api_key: String,
    extra: std::collections::HashMap<String, String>,
    /// Transcript-only mode (`target_language == "none"`): DashScope
    /// LiveTranslate models REJECT a session.update without a `translation`
    /// target (in-band `invalid_value`, close 1007) — a transcript-only
    /// session would otherwise reconnect forever without ever recognizing a
    /// word. We still ask for a target (the source language) and drop the
    /// translation events, exactly like the Volcengine path.
    transcript_only: bool,
}

impl DashScopeProtocol {
    pub(crate) fn new(
        api_key: String,
        extra: std::collections::HashMap<String, String>,
        transcript_only: bool,
    ) -> Self {
        Self {
            api_key,
            extra,
            transcript_only,
        }
    }

    /// ASR model for `input_audio_transcription`, from `extra.asrModel`.
    fn asr_model(&self) -> String {
        self.extra
            .get("asrModel")
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty())
            .unwrap_or_else(|| DEFAULT_ASR_MODEL.to_owned())
    }
}

impl LiveProtocol for DashScopeProtocol {
    fn prepare_request(&self, _url: &str, request: &mut Request) -> Result<(), String> {
        if !self.api_key.trim().is_empty() {
            attach_header(request, "authorization", format!("Bearer {}", self.api_key.trim()));
        }
        Ok(())
    }

    fn on_connected(&mut self, ctx: &ProtocolCtx) -> Result<SetupFrames, String> {
        let source_lang = ctx
            .session
            .source_language
            .read()
            .expect("live source language")
            .clone();
        let target_lang = ctx
            .session
            .target_language
            .read()
            .expect("live target language")
            .clone();
        let mut session_cfg = json!({
            "modalities": ["text"],
            "input_audio_format": "pcm",
            // The server defaults to the voice `Chelsie`, which
            // this model rejects the moment real audio flows
            // (`Voice 'Chelsie' is not supported`, stream dead).
            // Pin one that is accepted; its synthesized audio is
            // never consumed — we read the text events only.
            "voice": "Ethan",
        });
        // The `translation` block is NOT optional on the
        // LiveTranslate models: a session.update without it (or
        // with an unsupported target) answers `invalid_value` and
        // the server closes the socket before any audio counts.
        // Transcript-only mode fakes the target as the source
        // language (en when auto-detecting) — `apply_qwen_message`
        // drops the resulting translation events.
        let translation_target = if self.transcript_only {
            if source_lang == "auto" {
                "en".to_owned()
            } else {
                source_lang.clone()
            }
        } else {
            qwen_translation_target(&target_lang)
        };
        session_cfg["translation"] = json!({ "language": translation_target });
        if source_lang != "auto" || self.transcript_only {
            let mut transcription = json!({
                "model": self.asr_model(),
            });
            if source_lang != "auto" {
                transcription["language"] = json!(source_lang);
            }
            session_cfg["input_audio_transcription"] = transcription;
        }
        let update = json!({
            "type": "session.update",
            "event_id": format!("evt_{}", uuid::Uuid::new_v4()),
            "session": session_cfg,
        })
        .to_string();
        Ok(vec![(
            Outbound::Text(update),
            "发送 Qwen 会话配置失败",
        )])
    }

    fn encode_audio(&mut self, pcm: &[u8]) -> Vec<Outbound> {
        vec![Outbound::Text(
            json!({
                "type": "input_audio_buffer.append",
                "audio": BASE64.encode(pcm),
            })
            .to_string(),
        )]
    }

    fn finish(&mut self) -> (Vec<Outbound>, Duration) {
        (
            vec![Outbound::Text(
                r#"{"type":"session.finish","event_id":"evt_finish"}"#.to_owned(),
            )],
            // Wait for the server's `session.finished` ack (see
            // `is_finish_ack`), bounded by the same grace deadline.
            Duration::from_secs(5),
        )
    }

    fn is_finish_ack(&self, text: &str) -> bool {
        text.contains("\"session.finished\"")
    }

    fn validate(&self) -> Result<(), String> {
        if self.api_key.trim().is_empty() {
            return Err("实时翻译引擎需要填写 DashScope 兼容 API Key".to_owned());
        }
        Ok(())
    }

    fn handle_text(
        &mut self,
        app: &AppHandle,
        ctx: &ProtocolCtx,
        text: &str,
    ) -> InboundOutcome {
        // DashScope reports bad keys, unknown models and invalid session
        // configs as an in-band `error` event and then drops the socket —
        // without surfacing it, the stream cycles connect→error→close every
        // second with no trace of why anywhere in the log.
        if let Some(reason) = qwen_error_reason(text) {
            emit_error(app, Some(ctx.source), format!("Qwen 实时引擎错误：{reason}"));
            return InboundOutcome::Ignored;
        }
        let emission = apply_qwen_message(ctx, text, self.transcript_only);
        let got_result = emission.is_some();
        super::super::emit_provider_emission(app, emission);
        if got_result {
            InboundOutcome::GotResult
        } else {
            InboundOutcome::Ignored
        }
    }
}

/// Apply the recognized/translated text from a Qwen realtime-translation event
/// to a segment. Qwen's protocol is event-driven (`session.update` + streaming
/// `input_audio_buffer.append` audio) rather than iLiveData's binary-PCM +
/// `method`-field shape, but the resulting (source-recognition, translation)
/// pair maps onto the same live-segment model, so we reuse the shared ingest.
pub(crate) fn apply_qwen_message(
    ctx: &ProtocolCtx,
    text: &str,
    transcript_only: bool,
) -> Option<ProviderEmission> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let event_type = value.get("type").and_then(Value::as_str)?;
    let (is_recognized, is_final, content) = classify_qwen_event(event_type, &value)?;
    // Transcript-only mode requested a fake translation target purely to keep
    // the session alive; the translated text must never surface (the model
    // echoes the source speech back, which would read as duplicated cards).
    if transcript_only && !is_recognized {
        return None;
    }
    if content.is_empty() {
        return None;
    }
    // Qwen auto-detects utterance boundaries, so we approximate the utterance
    // start with the latest captured audio time on this source.
    let start_ms = ctx
        .epoch_offset_ms
        .saturating_add(ctx.session.last_elapsed_ms.load(std::sync::atomic::Ordering::Relaxed));
    ingest_provider_text(
        ctx.session,
        ctx.source,
        ctx.epoch,
        None,
        start_ms,
        None,
        is_recognized,
        is_final,
        String::new(),
        None,
        &content,
    )
}

/// Target languages DashScope LiveTranslate accepts in
/// `session.translation.language` (probed against qwen3.8-livetranslate,
/// 2026-09). Anything else is rejected in-band — `Invalid translation target
/// language parameter` — which kills the stream, so unsupported Lynse codes
/// degrade to their closest supported language instead of dead-ending.
pub(crate) fn qwen_translation_target(code: &str) -> String {
    const SUPPORTED: [&str; 21] = [
        "zh", "en", "ja", "ko", "fr", "es", "de", "ru", "pt", "it", "ar", "hi", "vi", "th", "id",
        "ms", "tr", "el", "fa", "ur", "bn",
    ];
    if SUPPORTED.contains(&code) {
        return code.to_owned();
    }
    // Chinese variants (zh-TW, zh-yue) degrade to Mandarin; every other
    // unsupported code falls back to English.
    if code.starts_with("zh") {
        "zh".to_owned()
    } else {
        "en".to_owned()
    }
}

/// Map a Qwen realtime-translation event type to (is_recognized, is_final,
/// text). Source recognition arrives via `input_audio_transcription.*`; the
/// translated text arrives via `response.text.*` (text-only) or
/// `response.audio_transcript.*` (text+audio) — both carry the same translated
/// string, so either family is accepted.
fn classify_qwen_event(event_type: &str, value: &Value) -> Option<(bool, bool, String)> {
    if event_type.contains("input_audio_transcription") {
        let text = event_text(value);
        return if event_type.ends_with(".completed") {
            Some((true, true, text))
        } else if event_type.ends_with(".text") {
            Some((true, false, text))
        } else {
            None
        };
    }
    if event_type.contains("response.text") || event_type.contains("response.audio_transcript") {
        let text = event_text(value);
        return if event_type.ends_with(".done") {
            Some((false, true, text))
        } else if event_type.ends_with(".delta") {
            Some((false, false, text))
        } else {
            None
        };
    }
    None
}

/// Extract the streamed text from a Qwen event. The field name varies by event
/// family (`text` / `delta` / `transcript` / `content`), so try each in order.
fn event_text(value: &Value) -> String {
    for key in ["text", "delta", "transcript", "content"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            return text.to_owned();
        }
    }
    String::new()
}

/// Extract a human-readable reason from a Qwen realtime `error` event, or
/// None when the frame is anything else. The payload is either flat
/// (`{type, code, message}`) or nested (`{type, error: {code, message}}`)
/// depending on the endpoint.
fn qwen_error_reason(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let error = value.get("error").unwrap_or(&value);
    let code = value_string(error, "code").or_else(|| value_string(error, "type"));
    let message = value_string(error, "message")
        .or_else(|| value_string(&value, "message"))
        .unwrap_or_default();
    match (code, message.is_empty()) {
        (Some(code), false) => Some(format!("{code}：{message}")),
        (Some(code), true) => Some(code),
        (None, false) => Some(message),
        (None, true) => Some(text.chars().take(200).collect()),
    }
}
