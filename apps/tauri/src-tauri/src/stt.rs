//! Local STT engine abstraction (mirrors Humla's `BatchSttAdapter`).
//!
//! The desktop app currently ships a single local engine (FunASR via a Python
//! subprocess). To stay provider-agnostic — and to make it trivial to plug in
//! local Whisper, Ollama, or cloud STT later — every engine implements
//! [`BatchSttAdapter`]. Routing is driven by a single [`TranscribeConfig`]
//! (default provider + per-language overrides), resolved per transcription
//! request.

use crate::{parse_funasr_json, run_funasr, script_path, CommandResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// A single transcription request handed to a [`BatchSttAdapter`].
pub struct SttRequest {
    pub audio_path: String,
    pub model_directory: PathBuf,
    pub expected_speakers: Option<u64>,
    pub hotword: String,
    /// Trailing prior context (previous transcript text) used as an
    /// `initial_prompt` to reduce hallucination and专有名词 drift.
    pub prior_context: Option<String>,
}

/// Normalized transcription result. `raw` is the engine-specific JSON and is
/// normalized into segments by the caller (`normalize_funasr_output`).
pub struct SttOutput {
    pub raw: serde_json::Value,
}

/// Provider-agnostic batch transcription adapter.
pub trait BatchSttAdapter: Send + Sync {
    #[allow(dead_code)]
    fn name(&self) -> &'static str;
    fn transcribe(&self, app: &tauri::AppHandle, request: SttRequest) -> CommandResult<SttOutput>;
}

/// Per-engine configuration. Serialized as a tagged enum so future engines can
/// be added without breaking existing stored configs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum ProviderConfig {
    Funasr(FunasrProviderConfig),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FunasrProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_speakers: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotword_package_id: Option<String>,
}

/// Single source of truth for STT routing, mirroring Humla's `transcribe_config`.
/// Resolution order: `per_note` → `per_language[lang]` → `default` → Funasr.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TranscribeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<ProviderConfig>,
    #[serde(default)]
    pub per_language: BTreeMap<String, ProviderConfig>,
}

impl TranscribeConfig {
    pub fn resolve(&self, language: Option<&str>, per_note: Option<&ProviderConfig>) -> ProviderConfig {
        per_note
            .cloned()
            .or_else(|| language.and_then(|lang| self.per_language.get(lang).cloned()))
            .or_else(|| self.default.clone())
            .unwrap_or_else(|| ProviderConfig::Funasr(FunasrProviderConfig::default()))
    }
}

/// FunASR local adapter — today's only local engine. Whisper / Ollama can
/// implement [`BatchSttAdapter`] later without touching any caller.
pub struct FunasrAdapter;

impl BatchSttAdapter for FunasrAdapter {
    fn name(&self) -> &'static str {
        "funasr"
    }

    fn transcribe(&self, app: &tauri::AppHandle, request: SttRequest) -> CommandResult<SttOutput> {
        let mut args = vec![
            script_path(app)?.to_string_lossy().into_owned(),
            request.audio_path.clone(),
            "--model-dir".to_owned(),
            request.model_directory.to_string_lossy().into_owned(),
        ];
        if let Some(expected) = request.expected_speakers.filter(|value| *value > 0) {
            args.extend(["--expected-speakers".to_owned(), expected.to_string()]);
        }
        if !request.hotword.is_empty() {
            args.extend(["--hotword".to_owned(), request.hotword]);
        }
        if let Some(prior) = request.prior_context.filter(|value| !value.trim().is_empty()) {
            args.extend(["--prompt".to_owned(), prior.trim().to_owned()]);
        }
        let stdout = run_funasr(app, &args, &request.model_directory)?;
        Ok(SttOutput { raw: parse_funasr_json(&stdout)? })
    }
}

/// Resolve the adapter for a given provider config. Only FunASR exists today;
/// the match arms make future engines a one-line addition.
impl ProviderConfig {
    pub fn adapter(&self) -> &'static FunasrAdapter {
        match self {
            ProviderConfig::Funasr(_) => &FunasrAdapter,
        }
    }
}
