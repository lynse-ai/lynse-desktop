//! Local STT engine abstraction (multi-engine: FunASR, Whisper, MOSS).
//!
//! Every engine implements [`BatchSttAdapter`] and returns a normalized
//! [`SttOutput`] (`{ text, segments }`) so the storage path never has to parse
//! engine-specific raw output. Routing is driven by a single
//! [`TranscribeConfig`] (default provider + per-language overrides), resolved
//! per transcription request.

use crate::{normalize_funasr_output, parse_funasr_json, run_funasr, script_path, CommandResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

/// Upper bound on a single MOSS transcription, in seconds (90 minutes).
pub const MOSS_MAX_DURATION_SECONDS: f64 = 90.0 * 60.0;

/// Returns `true` when an audio duration (seconds) exceeds MOSS's 90-minute
/// hard limit. Exactly 90 minutes is allowed.
pub(crate) fn moss_exceeds_max_duration(duration_seconds: f64) -> bool {
    duration_seconds > MOSS_MAX_DURATION_SECONDS
}

/// A single transcription request handed to a [`BatchSttAdapter`].
pub struct SttRequest {
    pub audio_path: String,
    /// Model directory for the resolved provider/model (already per-engine).
    pub model_directory: PathBuf,
    /// The resolved provider config — adapters read engine-specific knobs here.
    pub provider: ProviderConfig,
    pub expected_speakers: Option<u64>,
    pub hotword: String,
    /// Trailing prior context (previous transcript text) used as an
    /// `initial_prompt` to reduce hallucination and专有名词 drift.
    pub prior_context: Option<String>,
}

/// Normalized transcription result shared by every engine.
pub struct SttOutput {
    pub text: String,
    pub segments: Vec<Value>,
}

/// Provider-agnostic batch transcription adapter.
pub trait BatchSttAdapter: Send + Sync {
    #[allow(dead_code)]
    fn engine(&self) -> &'static str;
    fn transcribe(&self, app: &tauri::AppHandle, request: &SttRequest) -> CommandResult<SttOutput>;
}

// ── Per-engine configuration ─────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum WhisperModel {
    #[serde(rename = "small-q5_1")]
    SmallQ5_1,
    #[serde(rename = "medium-q5_0")]
    MediumQ5_0,
    #[serde(rename = "large-v3-turbo-q5_0")]
    LargeV3TurboQ5_0,
}

impl Default for WhisperModel {
    fn default() -> Self {
        WhisperModel::LargeV3TurboQ5_0
    }
}

impl WhisperModel {
    pub fn as_model_id(&self) -> &'static str {
        match self {
            WhisperModel::SmallQ5_1 => "small-q5_1",
            WhisperModel::MediumQ5_0 => "medium-q5_0",
            WhisperModel::LargeV3TurboQ5_0 => "large-v3-turbo-q5_0",
        }
    }

    pub fn file_name(&self) -> &'static str {
        match self {
            WhisperModel::SmallQ5_1 => "ggml-small-q5_1.bin",
            WhisperModel::MediumQ5_0 => "ggml-medium-q5_0.bin",
            WhisperModel::LargeV3TurboQ5_0 => "ggml-large-v3-turbo-q5_0.bin",
        }
    }

    pub fn from_model_id(id: &str) -> Option<WhisperModel> {
        match id {
            "small-q5_1" => Some(WhisperModel::SmallQ5_1),
            "medium-q5_0" => Some(WhisperModel::MediumQ5_0),
            "large-v3-turbo-q5_0" => Some(WhisperModel::LargeV3TurboQ5_0),
            _ => None,
        }
    }
}

/// Filename of the on-disk model artifact for a (provider, model_id) pair.
/// Returns `None` for engines whose download is handled specially (FunASR).
pub fn model_file_name(provider: &str, model_id: &str) -> Option<String> {
    match provider {
        "whisper" => WhisperModel::from_model_id(model_id).map(|model| model.file_name().to_owned()),
        "moss_transcribe_diarize" => Some("model.gguf".to_owned()),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FunasrProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_speakers: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotword_package_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WhisperProviderConfig {
    #[serde(default)]
    pub model: WhisperModel,
    /// Optional CAM++ speaker separation (reuses FunASR's CAM++ model).
    #[serde(default)]
    pub campp_diarization: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_speakers: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotword_package_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MossProviderConfig {
    /// MOSS uses a fixed 0.9B Q5 model with built-in speaker separation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotword_package_id: Option<String>,
}

/// Single source of truth for provider config. Serialized as a tagged enum so
/// future engines can be added without breaking stored configs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum ProviderConfig {
    Funasr(FunasrProviderConfig),
    Whisper(WhisperProviderConfig),
    MossTranscribeDiarize(MossProviderConfig),
}

impl Default for ProviderConfig {
    fn default() -> Self {
        ProviderConfig::Funasr(FunasrProviderConfig::default())
    }
}

impl ProviderConfig {
    pub fn engine(&self) -> &'static str {
        match self {
            ProviderConfig::Funasr(_) => "funasr",
            ProviderConfig::Whisper(_) => "whisper",
            ProviderConfig::MossTranscribeDiarize(_) => "moss_transcribe_diarize",
        }
    }

    pub fn hotword_package_id(&self) -> Option<&str> {
        match self {
            ProviderConfig::Funasr(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::Whisper(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::MossTranscribeDiarize(config) => config.hotword_package_id.as_deref(),
        }
    }

    pub fn expected_speakers(&self) -> Option<u64> {
        match self {
            ProviderConfig::Funasr(config) => config.expected_speakers,
            ProviderConfig::Whisper(config) => config.expected_speakers,
            ProviderConfig::MossTranscribeDiarize(_) => None,
        }
    }

    pub fn adapter(&self) -> &'static dyn BatchSttAdapter {
        match self {
            ProviderConfig::Funasr(_) => &FunasrAdapter,
            ProviderConfig::Whisper(_) => &WhisperAdapter,
            ProviderConfig::MossTranscribeDiarize(_) => &MossAdapter,
        }
    }
}

/// Single source of truth for STT routing. Resolution order:
/// `per_note` → `per_language[lang]` → `default` → Funasr.
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
            .unwrap_or_else(ProviderConfig::default)
    }
}

// ── Sidecar / media helpers ──────────────────────────────

fn sidecar_binary_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_owned()
    }
}

/// Locate a bundled sidecar (whisper, moss, ffmpeg, ffprobe) in dev resources
/// or the packaged resource directory.
pub(crate) fn sidecar_path(app: &tauri::AppHandle, base: &str) -> CommandResult<PathBuf> {
    let name = sidecar_binary_name(base);
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/sidecars").join(&name);
    if development.exists() {
        return Ok(development);
    }
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    Ok(resources.join(&name))
}

/// Convert any audio/video to 16 kHz mono 16-bit PCM WAV via the bundled
/// LGPL FFmpeg build.
pub(crate) fn convert_to_wav(app: &tauri::AppHandle, input: &str, output: &Path) -> CommandResult<()> {
    let ffmpeg = sidecar_path(app, "ffmpeg")?;
    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            input,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            output.to_string_lossy().as_ref(),
        ])
        .status()
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?;
    if !status.success() {
        return Err("FFmpeg 转换音频失败".to_owned());
    }
    Ok(())
}

/// Probe media duration in seconds via the bundled ffprobe. Returns `None`
/// when the duration cannot be determined.
pub(crate) fn media_duration_seconds(app: &tauri::AppHandle, input: &str) -> CommandResult<Option<f64>> {
    let ffprobe = sidecar_path(app, "ffprobe")?;
    let output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            input,
        ])
        .output()
        .map_err(|error| format!("无法启动 ffprobe：{error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let parsed = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok(parsed.parse::<f64>().ok())
}

fn normalize_moss_output(parsed: &Value) -> Vec<Value> {
    let items = parsed
        .get("segments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let text = item.get("text").and_then(Value::as_str)?.trim().to_owned();
            if text.is_empty() {
                return None;
            }
            let start_ms = item.get("start").and_then(Value::as_f64).unwrap_or(0.0) as i64;
            let end_ms = item.get("end").and_then(Value::as_f64).unwrap_or(0.0) as i64;
            let raw_speaker = item
                .get("speaker")
                .and_then(Value::as_str)
                .or_else(|| item.get("speaker_id").and_then(Value::as_str))
                .map(str::to_owned);
            let speaker_index = raw_speaker
                .as_deref()
                .and_then(|speaker| speaker.trim_start_matches('S').trim_start_matches('0').parse::<usize>().ok())
                .unwrap_or(index + 1);
            Some(json!({
                "id": format!("seg-{}", index + 1),
                "text": text,
                "startMs": start_ms,
                "endMs": end_ms,
                "speakerId": format!("spk-{}", speaker_index),
                "speakerName": format!("发言人{}", speaker_index),
                "rawSpeaker": raw_speaker,
            }))
        })
        .collect()
}

pub struct FunasrAdapter;

impl BatchSttAdapter for FunasrAdapter {
    fn engine(&self) -> &'static str {
        "funasr"
    }

    fn transcribe(&self, app: &tauri::AppHandle, request: &SttRequest) -> CommandResult<SttOutput> {
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
            args.extend(["--hotword".to_owned(), request.hotword.clone()]);
        }
        if let Some(prior) = request.prior_context.as_deref().filter(|value| !value.trim().is_empty()) {
            args.extend(["--prompt".to_owned(), prior.trim().to_owned()]);
        }
        let stdout = run_funasr(app, &args, &request.model_directory)?;
        let raw = parse_funasr_json(&stdout)?;
        let normalized = normalize_funasr_output(raw);
        let text = normalized
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let segments = normalized
            .get("segments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(SttOutput { text, segments })
    }
}

pub struct WhisperAdapter;

impl BatchSttAdapter for WhisperAdapter {
    fn engine(&self) -> &'static str {
        "whisper"
    }

    fn transcribe(&self, app: &tauri::AppHandle, request: &SttRequest) -> CommandResult<SttOutput> {
        let ProviderConfig::Whisper(config) = &request.provider else {
            return Err("Whisper 适配器收到非 Whisper 配置".to_owned());
        };
        let model_path = request.model_directory.join(config.model.file_name());
        if !model_path.exists() {
            return Err(format!("Whisper 模型缺失：{}", model_path.display()));
        }

        let wav = request.model_directory.join("input.wav");
        convert_to_wav(app, &request.audio_path, &wav)?;

        let sidecar = sidecar_path(app, "whisper")?;
        let output_json = request.model_directory.join("whisper-output.json");
        let mut args = vec![
            sidecar.to_string_lossy().into_owned(),
            "-m".to_owned(),
            model_path.to_string_lossy().into_owned(),
            "-f".to_owned(),
            wav.to_string_lossy().into_owned(),
            "-oj".to_owned(),
            "-of".to_owned(),
            output_json.to_string_lossy().into_owned(),
            "--output-format".to_owned(),
            "json".to_owned(),
        ];
        if let Some(prior) = request.prior_context.as_deref().filter(|value| !value.trim().is_empty()) {
            args.extend(["-p".to_owned(), prior.trim().to_owned()]);
        }
        if !request.hotword.is_empty() {
            args.extend(["-p".to_owned(), request.hotword.clone()]);
        }
        let status = Command::new(&sidecar)
            .args(&args)
            .status()
            .map_err(|error| format!("无法启动 Whisper：{error}"))?;
        if !status.success() {
            return Err("Whisper 转写失败".to_owned());
        }

        let parsed: Value = {
            let content = std::fs::read_to_string(&output_json).map_err(|error| error.to_string())?;
            serde_json::from_str(&content).map_err(|error| error.to_string())?
        };
        let mut segments = normalize_whisper_output(&parsed);

        if config.campp_diarization {
            let funasr_dir = crate::model_dir(app)?;
            crate::assign_campp_speakers(app, &request.audio_path, &mut segments, &funasr_dir, request.expected_speakers)?;
        } else {
            // Single speaker when diarization is off — never fabricate multiple.
            for segment in &mut segments {
                if let Some(object) = segment.as_object_mut() {
                    object.insert("speakerId".to_owned(), json!("spk-1"));
                    object.insert("speakerName".to_owned(), json!("发言人1"));
                    object.insert("rawSpeaker".to_owned(), json!("0"));
                }
            }
        }

        let text = segments
            .iter()
            .filter_map(|segment| segment.get("text").and_then(Value::as_str))
            .collect::<String>();
        Ok(SttOutput { text, segments })
    }
}

pub struct MossAdapter;

impl BatchSttAdapter for MossAdapter {
    fn engine(&self) -> &'static str {
        "moss_transcribe_diarize"
    }

    fn transcribe(&self, app: &tauri::AppHandle, request: &SttRequest) -> CommandResult<SttOutput> {
        if let Some(duration) = media_duration_seconds(app, &request.audio_path)? {
            if moss_exceeds_max_duration(duration) {
                return Err(format!(
                    "MOSS 暂不支持超过 90 分钟的音频（当前约 {:.0} 分钟），请改用 Whisper 或 FunASR。",
                    duration / 60.0
                ));
            }
        }

        let model_path = request.model_directory.join("model.gguf");
        if !model_path.exists() {
            return Err(format!("MOSS 模型缺失：{}", model_path.display()));
        }

        let wav = request.model_directory.join("input.wav");
        convert_to_wav(app, &request.audio_path, &wav)?;

        let sidecar = sidecar_path(app, "moss-transcribe")?;
        let output_json = request.model_directory.join("moss-output.json");
        let args = vec![
            sidecar.to_string_lossy().into_owned(),
            "--model".to_owned(),
            model_path.to_string_lossy().into_owned(),
            "--input".to_owned(),
            wav.to_string_lossy().into_owned(),
            "--output".to_owned(),
            output_json.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ];
        let status = Command::new(&sidecar)
            .args(&args)
            .status()
            .map_err(|error| format!("无法启动 MOSS：{error}"))?;
        if !status.success() {
            return Err("MOSS 转写失败".to_owned());
        }

        let parsed: Value = {
            let content = std::fs::read_to_string(&output_json).map_err(|error| error.to_string())?;
            serde_json::from_str(&content).map_err(|error| error.to_string())?
        };
        let segments = normalize_moss_output(&parsed);

        // MOSS provides built-in speaker labels; map [S01] → 发言人1.
        let text = segments
            .iter()
            .filter_map(|segment| segment.get("text").and_then(Value::as_str))
            .collect::<String>();
        Ok(SttOutput { text, segments })
    }
}

/// Parse whisper.cpp JSON into normalized segments. whisper.cpp emits either a
/// `segments` array (with `start`/`end`/`text`) or a `result` array.
fn normalize_whisper_output(parsed: &Value) -> Vec<Value> {
    let items = parsed
        .get("segments")
        .and_then(Value::as_array)
        .or_else(|| parsed.get("result").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let text = item.get("text").and_then(Value::as_str)?.trim().to_owned();
            if text.is_empty() {
                return None;
            }
            let start_ms = (item.get("start").and_then(Value::as_f64).unwrap_or(0.0) * 1000.0) as i64;
            let end_ms = (item.get("end").and_then(Value::as_f64).unwrap_or(0.0) * 1000.0) as i64;
            let raw_speaker = item.get("speaker").and_then(Value::as_str).map(str::to_owned);
            Some(json!({
                "id": format!("seg-{}", index + 1),
                "text": text,
                "startMs": start_ms,
                "endMs": end_ms,
                "speakerId": raw_speaker.as_ref().map(|speaker| format!("spk-{}", speaker)),
                "speakerName": raw_speaker,
                "rawSpeaker": raw_speaker,
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whisper_model_round_trips() {
        for id in ["small-q5_1", "medium-q5_0", "large-v3-turbo-q5_0"] {
            let model = WhisperModel::from_model_id(id).expect("known id resolves");
            assert_eq!(model.as_model_id(), id);
        }
        assert_eq!(WhisperModel::from_model_id("nope"), None);
    }

    #[test]
    fn whisper_model_file_names() {
        assert_eq!(WhisperModel::SmallQ5_1.file_name(), "ggml-small-q5_1.bin");
        assert_eq!(WhisperModel::MediumQ5_0.file_name(), "ggml-medium-q5_0.bin");
        assert_eq!(WhisperModel::LargeV3TurboQ5_0.file_name(), "ggml-large-v3-turbo-q5_0.bin");
    }

    #[test]
    fn model_file_name_per_provider() {
        assert_eq!(
            model_file_name("whisper", "large-v3-turbo-q5_0"),
            Some("ggml-large-v3-turbo-q5_0.bin".to_owned())
        );
        assert_eq!(
            model_file_name("moss_transcribe_diarize", "moss-0.9b-q5"),
            Some("model.gguf".to_owned())
        );
        assert_eq!(model_file_name("funasr", "funasr-paraformer"), None);
    }

    #[test]
    fn provider_config_deserialize_and_accessors() {
        let whisper: ProviderConfig = serde_json::from_value(json!({
            "provider": "whisper",
            "model": "large-v3-turbo-q5_0",
            "campp_diarization": true,
            "expected_speakers": 2,
            "hotword_package_id": "h1"
        }))
        .unwrap();
        assert_eq!(whisper.engine(), "whisper");
        assert_eq!(whisper.expected_speakers(), Some(2));
        assert_eq!(whisper.hotword_package_id(), Some("h1"));

        let funasr: ProviderConfig = serde_json::from_value(json!({
            "provider": "funasr",
            "hotword_package_id": "h2"
        }))
        .unwrap();
        assert_eq!(funasr.engine(), "funasr");

        let moss: ProviderConfig = serde_json::from_value(json!({
            "provider": "moss_transcribe_diarize",
            "hotword_package_id": "h3"
        }))
        .unwrap();
        assert_eq!(moss.engine(), "moss_transcribe_diarize");
        assert_eq!(moss.expected_speakers(), None);
    }

    #[test]
    fn transcribe_config_resolves_priority() {
        let whisper: ProviderConfig =
            serde_json::from_value(json!({"provider": "whisper", "model": "small-q5_1"})).unwrap();
        let funasr: ProviderConfig = serde_json::from_value(json!({"provider": "funasr"})).unwrap();
        let mut per_language = BTreeMap::new();
        per_language.insert("zh".to_owned(), whisper.clone());
        let config = TranscribeConfig {
            default: Some(funasr.clone()),
            per_language,
        };
        // per-note wins over everything
        assert_eq!(config.resolve(Some("zh"), Some(&funasr)).engine(), "funasr");
        // per-language beats default
        assert_eq!(config.resolve(Some("zh"), None).engine(), "whisper");
        // default when nothing else matches
        assert_eq!(config.resolve(Some("en"), None).engine(), "funasr");
        // fall back to Funasr when config empty
        assert_eq!(TranscribeConfig::default().resolve(None, None).engine(), "funasr");
    }

    #[test]
    fn normalize_whisper_output_maps_segments_and_units() {
        let parsed = json!({
            "segments": [
                {"start": 0.5, "end": 1.2, "text": " hello "},
                {"start": 1.2, "end": 1.5, "text": ""},
                {"start": 2.0, "end": 3.0, "text": "world", "speaker": "0"}
            ]
        });
        let segments = normalize_whisper_output(&parsed);
        assert_eq!(segments.len(), 2, "empty text segment dropped");
        assert_eq!(segments[0]["text"], "hello");
        assert_eq!(segments[0]["startMs"], 500);
        assert_eq!(segments[0]["endMs"], 1200);
        assert_eq!(segments[1]["text"], "world");
        assert_eq!(segments[1]["speakerId"], "spk-0");
    }

    #[test]
    fn normalize_moss_output_maps_speaker_labels() {
        let parsed = json!({
            "segments": [
                {"start": 0.0, "end": 1.0, "text": "first", "speaker": "S01"},
                {"start": 1.0, "end": 2.0, "text": "second"}
            ]
        });
        let segments = normalize_moss_output(&parsed);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0]["speakerId"], "spk-1");
        assert_eq!(segments[0]["speakerName"], "发言人1");
        assert_eq!(segments[0]["rawSpeaker"], "S01");
    }

    #[test]
    fn moss_duration_guard() {
        assert!(!moss_exceeds_max_duration(0.0));
        assert!(
            !moss_exceeds_max_duration(MOSS_MAX_DURATION_SECONDS),
            "exactly 90 minutes is allowed"
        );
        assert!(!moss_exceeds_max_duration(MOSS_MAX_DURATION_SECONDS - 1.0));
        assert!(
            moss_exceeds_max_duration(MOSS_MAX_DURATION_SECONDS + 1.0),
            "over 90 minutes is blocked"
        );
    }
}
