//! Volcengine AST v4: protobuf over binary websocket frames.
//!
//! Auth rides on the upgrade headers (`X-Api-Key` + resource/connect ids);
//! a session opens with an explicit `StartSession` frame; 20 ms capture
//! frames are coalesced into the vendor's 100 ms (3,200 byte) task requests.
//! AST publishes two parallel tracks per utterance — source recognition
//! (`SourceSubtitle*`) and translation (`TranslationSubtitle*`) — which map
//! onto Lynse's (recognized, translated) segment pair. The `*End` events
//! close an utterance but do not always repeat its text, so the last
//! streamed value for each track is carried forward.

use std::time::Duration;

use tauri::AppHandle;
use tokio_tungstenite::tungstenite::handshake::client::Request;

use crate::volc_ast;
use super::super::ingest_provider_text;
use super::{
    InboundOutcome, LiveProtocol, Outbound, ProtocolCtx, SetupFrames, attach_header,
};
use super::super::{ProviderEmission, emit_provider_emission};

/// Milliseconds of trailing audio to accept after `FinishSession` before
/// giving up on the socket.
const FINISH_GRACE: Duration = Duration::from_secs(5);

pub(super) struct VolcProtocol {
    api_key: String,
    /// Transcript-only mode (`target_language == "none"`): AST bills
    /// translation per session and always emits a translation track, so we
    /// still ask for one and simply drop the translation subtitles.
    transcript_only: bool,
    /// Per-connection session config; rebuilt on every (re)connect with the
    /// current session languages so a mid-session `set_mode` applies.
    config: Option<volc_ast::SessionConfig>,
    pending: Vec<u8>,
    last_source: String,
    last_translation: String,
    /// 1-based speaker index for diarization, derived from the `spk_chg`
    /// marker on source subtitle Start events.
    speaker_index: u32,
}

impl VolcProtocol {
    pub(super) fn new(api_key: String, transcript_only: bool) -> Self {
        Self {
            api_key,
            transcript_only,
            config: None,
            pending: Vec::new(),
            last_source: String::new(),
            last_translation: String::new(),
            speaker_index: 1,
        }
    }
}

impl LiveProtocol for VolcProtocol {
    fn prepare_request(&self, _url: &str, request: &mut Request) -> Result<(), String> {
        if !self.api_key.trim().is_empty() {
            attach_header(request, "x-api-key", self.api_key.trim().to_owned());
        }
        attach_header(request, "x-api-resource-id", volc_ast::RESOURCE_ID.to_owned());
        attach_header(request, "x-api-connect-id", uuid::Uuid::new_v4().to_string());
        Ok(())
    }

    fn validate(&self) -> Result<(), String> {
        if self.api_key.trim().is_empty() {
            return Err("火山同声传译需要填写 Access Key".to_owned());
        }
        Ok(())
    }

    /// AST opens a session with an explicit StartSession frame. Websocket
    /// ordering guarantees the server processes it before any audio, so we
    /// can stream straight away instead of blocking on the SessionStarted
    /// acknowledgement.
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
        let (source_language, target_language, detect) =
            volc_languages(&source_lang, &target_lang);
        let config = volc_ast::SessionConfig {
            session_id: uuid::Uuid::new_v4().to_string(),
            mode: "s2t".to_owned(),
            source_language,
            target_language,
            detect_source_language: detect,
        };
        let frame = volc_ast::encode_start_session(&config);
        self.config = Some(config);
        self.pending = Vec::with_capacity(volc_ast::CHUNK_BYTES);
        Ok(vec![(
            Outbound::Binary(frame),
            "开启火山翻译会话失败",
        )])
    }

    /// Paced in 100 ms chunks (matching the vendor reference client), so
    /// 20 ms capture frames are coalesced here.
    fn encode_audio(&mut self, pcm: &[u8]) -> Vec<Outbound> {
        let Some(config) = &self.config else {
            return Vec::new();
        };
        self.pending.extend_from_slice(pcm);
        let mut frames = Vec::new();
        while self.pending.len() >= volc_ast::CHUNK_BYTES {
            let rest = self.pending.split_off(volc_ast::CHUNK_BYTES);
            let chunk = std::mem::replace(&mut self.pending, rest);
            frames.push(Outbound::Binary(volc_ast::encode_task_request(
                config, &chunk,
            )));
        }
        frames
    }

    /// Flush the tail of the capture buffer, then let the server drain and
    /// close the session.
    fn finish(&mut self) -> (Vec<Outbound>, Duration) {
        let mut frames = Vec::new();
        if let Some(config) = &self.config {
            if !self.pending.is_empty() {
                let chunk = std::mem::take(&mut self.pending);
                frames.push(Outbound::Binary(volc_ast::encode_task_request(
                    config, &chunk,
                )));
            }
            frames.push(Outbound::Binary(volc_ast::encode_finish_session(config)));
        }
        (frames, FINISH_GRACE)
    }

    /// The AST gate is binary-only; text frames carry no results.
    fn handle_text(
        &mut self,
        _app: &AppHandle,
        _ctx: &ProtocolCtx,
        _text: &str,
    ) -> InboundOutcome {
        InboundOutcome::Ignored
    }

    fn handle_binary(
        &mut self,
        app: &AppHandle,
        ctx: &ProtocolCtx,
        frame: &[u8],
    ) -> InboundOutcome {
        match volc_ast::decode_response(frame) {
            Ok(response) => match response.event {
                volc_ast::EVENT_SESSION_FINISHED => InboundOutcome::StreamFinished,
                volc_ast::EVENT_SESSION_FAILED | volc_ast::EVENT_SESSION_CANCELED => {
                    let detail = if response.message.is_empty() {
                        format!("状态码 {}", response.status_code)
                    } else {
                        response.message.clone()
                    };
                    InboundOutcome::Redial(format!(
                        "火山翻译会话失败（{}）：{detail}",
                        volc_ast::describe_event(response.event)
                    ))
                }
                _ => {
                    let emission = handle_volc_response(ctx, &response, self);
                    let got_result = emission.is_some();
                    emit_provider_emission(app, emission);
                    if got_result {
                        InboundOutcome::GotResult
                    } else {
                        InboundOutcome::Ignored
                    }
                }
            },
            Err(error) => {
                log::warn!("volc-ast: 无法解析响应帧：{error}");
                InboundOutcome::Ignored
            }
        }
    }
}

/// Route one Volcengine AST subtitle event onto the shared live-segment model.
fn handle_volc_response(
    ctx: &ProtocolCtx,
    response: &volc_ast::Response,
    state: &mut VolcProtocol,
) -> Option<ProviderEmission> {
    // Volcengine AST flags a speaker change on the *source* subtitle Start
    // event. Only the source track carries it (the translation Start repeats
    // the same flag for the same utterance), so we count on the source track
    // only to avoid double-incrementing the speaker index.
    if response.event == volc_ast::EVENT_SOURCE_SUBTITLE_START && response.spk_chg {
        state.speaker_index += 1;
    }
    let subtitle = volc_ast::classify_subtitle(response.event)?;
    let (is_recognized, is_final) = match subtitle {
        volc_ast::Subtitle::Source { is_final } => (true, is_final),
        volc_ast::Subtitle::Translation { is_final } => {
            if state.transcript_only {
                return None;
            }
            (false, is_final)
        }
    };
    let carry = if is_recognized {
        &mut state.last_source
    } else {
        &mut state.last_translation
    };
    let text = if response.text.is_empty() {
        carry.clone()
    } else {
        response.text.clone()
    };
    if text.trim().is_empty() {
        return None;
    }
    if is_final {
        carry.clear();
    } else {
        *carry = text.clone();
    }

    // AST reports utterance bounds in milliseconds from the start of the
    // session; before the first timestamped event we fall back to the capture
    // clock, the same approximation the Qwen provider uses.
    let start_ms = if response.start_time > 0 {
        ctx.epoch_offset_ms.saturating_add(response.start_time as u64)
    } else {
        ctx.epoch_offset_ms
            .saturating_add(ctx.session.last_elapsed_ms.load(std::sync::atomic::Ordering::Relaxed))
    };
    let end_ms = (response.end_time > 0)
        .then(|| ctx.epoch_offset_ms.saturating_add(response.end_time as u64));

    ingest_provider_text(
        ctx.session,
        ctx.source,
        ctx.epoch,
        None,
        start_ms,
        end_ms,
        is_recognized,
        is_final,
        String::new(),
        Some(state.speaker_index),
        &text,
    )
}

/// Resolve the language pair sent to Volcengine AST.
///
/// AST always translates, so Lynse's two special values need mapping:
/// `auto` source switches on server-side language detection, and the
/// transcript-only target (`none`) is satisfied by requesting *some* valid
/// target and dropping the translation subtitles on arrival.
pub(crate) fn volc_languages(source: &str, target: &str) -> (String, String, bool) {
    let detect = source.is_empty() || source == "auto";
    let source_language = if detect { String::new() } else { source.to_owned() };
    let target_language = if target.is_empty() || target == "none" {
        if source_language == "zh" { "en" } else { "zh" }.to_owned()
    } else {
        target.to_owned()
    };
    (source_language, target_language, detect)
}
