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
    InboundOutcome, LiveProtocol, Outbound, ProtocolCtx, SetupFrames, append_streaming_delta,
    attach_header, merge_streaming_chunk, value_string,
};
use super::super::{ProviderEmission, emit_error};

/// Default ASR model requested in `session.update`; a DashScope-compatible
/// service that names its recognition model differently overrides it via the
/// connection descriptor's `extra.asrModel` (the custom provider plugin).
const DEFAULT_ASR_MODEL: &str = "qwen3-asr-flash-realtime";

pub(crate) struct DashScopeProtocol {
    api_key: String,
    extra: std::collections::HashMap<String, String>,
    /// Transcript-only mode (`target_language == "none"`): DashScope
    /// LiveTranslate models REJECT a session.update without a `translation`
    /// target (in-band `invalid_value`, close 1007) — a transcript-only
    /// session would otherwise reconnect forever without ever recognizing a
    /// word. We still ask for a target (the source language) and drop the
    /// translation events, exactly like the Volcengine path.
    transcript_only: bool,
    source_accumulated: String,
    translation_accumulated: String,
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
            source_accumulated: String::new(),
            translation_accumulated: String::new(),
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
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 800,
            },
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

        // Always configure input_audio_transcription so source recognition streams
        // in real-time while the user is speaking.
        let mut transcription = json!({
            "model": self.asr_model(),
        });
        if source_lang != "auto" && !source_lang.trim().is_empty() {
            transcription["language"] = json!(source_lang);
        }
        session_cfg["input_audio_transcription"] = transcription;

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
        let emission = self.apply_message(ctx, text);
        let got_result = emission.is_some();
        super::super::emit_provider_emission(app, emission);
        if got_result {
            InboundOutcome::GotResult
        } else {
            InboundOutcome::Ignored
        }
    }
}

impl DashScopeProtocol {
    /// Apply the recognized/translated text from a Qwen realtime-translation event
    /// to a segment, accumulating streaming deltas into a coherent rolling utterance.
    pub(crate) fn apply_message(
        &mut self,
        ctx: &ProtocolCtx,
        text: &str,
    ) -> Option<ProviderEmission> {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return None;
        };
        let event_type = value.get("type").and_then(Value::as_str)?;

        // Reset buffer boundaries on speech / response start
        if event_type == "input_audio_buffer.speech_started" {
            self.source_accumulated.clear();
            return None;
        }
        if event_type == "response.created" {
            self.translation_accumulated.clear();
            return None;
        }

        let (is_recognized, is_final, is_delta, content) = classify_qwen_event(event_type, &value)?;
        if self.transcript_only && !is_recognized {
            return None;
        }
        if content.is_empty() && !is_final {
            return None;
        }

        let text_to_emit = if is_recognized {
            if is_final {
                if !content.trim().is_empty() {
                    self.source_accumulated = content.trim().to_owned();
                }
                let full = std::mem::take(&mut self.source_accumulated);
                if full.trim().is_empty() {
                    return None;
                }
                full
            } else {
                if is_delta {
                    append_streaming_delta(&mut self.source_accumulated, &content);
                } else {
                    merge_streaming_chunk(&mut self.source_accumulated, &content);
                }
                if self.source_accumulated.trim().is_empty() {
                    return None;
                }
                self.source_accumulated.clone()
            }
        } else {
            // Translation track
            if is_final {
                if !content.trim().is_empty() {
                    self.translation_accumulated = content.trim().to_owned();
                }
                let full = std::mem::take(&mut self.translation_accumulated);
                if full.trim().is_empty() {
                    return None;
                }
                full
            } else {
                if is_delta {
                    append_streaming_delta(&mut self.translation_accumulated, &content);
                } else {
                    merge_streaming_chunk(&mut self.translation_accumulated, &content);
                }
                if self.translation_accumulated.trim().is_empty() {
                    return None;
                }
                self.translation_accumulated.clone()
            }
        };

        let start_ms = ctx.session.last_elapsed_ms.load(std::sync::atomic::Ordering::Relaxed);
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
            &text_to_emit,
        )
    }
}

/// Apply the recognized/translated text from a Qwen realtime-translation event
/// to a segment. Free function wrapper for backwards compatibility with tests.
pub(crate) fn apply_qwen_message(
    ctx: &ProtocolCtx,
    text: &str,
    transcript_only: bool,
) -> Option<ProviderEmission> {
    let mut protocol = DashScopeProtocol::new(String::new(), Default::default(), transcript_only);
    protocol.apply_message(ctx, text)
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
/// is_delta, text). Source recognition arrives via `input_audio_transcription.*`; the
/// translated text arrives via `response.text.*` (text-only) or
/// `response.audio_transcript.*` (text+audio) — both carry the same translated
/// string, so either family is accepted.
fn classify_qwen_event(event_type: &str, value: &Value) -> Option<(bool, bool, bool, String)> {
    if event_type.contains("input_audio_transcription") {
        let text = event_text(value);
        return if event_type.ends_with(".completed") {
            Some((true, true, false, text))
        } else if event_type.ends_with(".delta") {
            Some((true, false, true, text))
        } else if event_type.ends_with(".text") {
            Some((true, false, false, text))
        } else {
            None
        };
    }
    if event_type.contains("response.text") || event_type.contains("response.audio_transcript") {
        let text = event_text(value);
        return if event_type.ends_with(".done") {
            Some((false, true, false, text))
        } else if event_type.ends_with(".delta") {
            Some((false, false, true, text))
        } else if event_type.ends_with(".text") {
            Some((false, false, false, text))
        } else {
            None
        };
    }
    None
}

/// Extract the streamed text from a Qwen event. The field name varies by event
/// family (`text` / `delta` / `transcript` / `content`), so try each in order.
/// The qwen3.5-style `…​.text` partials keep the confirmed prefix in `text`
/// (often empty) and the in-flight tail in `stash` — concatenate both so the
/// rolling partial shows the utterance instead of an empty string.
fn event_text(value: &Value) -> String {
    for key in ["text", "delta", "transcript", "content"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            let mut full = text.to_owned();
            if let Some(stash) = value.get("stash").and_then(Value::as_str) {
                full.push_str(stash);
            }
            return full;
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
