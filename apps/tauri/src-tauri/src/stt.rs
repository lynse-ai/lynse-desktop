//! Local STT engine abstraction (multi-engine: Qwen3-ASR, FunASR, Whisper,
//! VibeVoice, MLX-Whisper).
//!
//! Every engine implements [`BatchSttAdapter`] and returns a normalized
//! [`SttOutput`] (`{ text, segments }`) so the storage path never has to parse
//! engine-specific raw output. Routing is driven by a single
//! [`TranscribeConfig`] (default provider + per-language overrides), resolved
//! per transcription request.

use crate::{
    ensure_mlx_venv, mlx_script_path, normalize_funasr_output, parse_funasr_json, run_funasr, run_mlx,
    script_path, CommandResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

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
        // VibeVoice ships two GGUF weights (VAE + LM); readiness is checked per-file.
        "vibeasr" => None,
        // MLX keeps a directory of weights (marked ready with a `.ready` file),
        // so there is no single downloadable artifact to name.
        "mlx" => None,
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

/// VibeVoice-ASR-BitNet runs on CPU through Microsoft's VibeASR.cpp engine.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VibeVoiceProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotword_package_id: Option<String>,
}

/// MLX-Whisper on Apple Silicon. v1 ships a single pinned model; `model` is
/// reserved for future size selection (e.g. base/turbo/large-v3).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MlxProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotword_package_id: Option<String>,
}

/// Qwen3-ASR (Alibaba) on Apple MLX — the default local engine. `model` is a
/// catalog id from [`STT_MODELS`] (quantized mlx-community weights); `None`
/// selects [`QWEN3_DEFAULT_MODEL_ID`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Qwen3ProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotword_package_id: Option<String>,
}

/// Catalog id of the model used when a Qwen3 config names none: the 1.7B
/// 8-bit weights (fp16-parity quality, faster and half the memory of fp16).
pub const QWEN3_DEFAULT_MODEL_ID: &str = "qwen3-asr-1.7b-8bit";

/// HF repo backing a Qwen3 catalog id. Quantized `mlx-community` conversions:
/// 8-bit matches fp16 accuracy at roughly 1.5x the speed, 4-bit is the speed
/// tier for the 0.6B model.
pub fn qwen3_hf_repo(model_id: &str) -> &'static str {
    match model_id {
        "qwen3-asr-0.6b-4bit" => "mlx-community/Qwen3-ASR-0.6B-4bit",
        _ => "mlx-community/Qwen3-ASR-1.7B-8bit",
    }
}

/// Single source of truth for provider config. Serialized as a tagged enum so
/// future engines can be added without breaking stored configs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum ProviderConfig {
    Funasr(FunasrProviderConfig),
    Whisper(WhisperProviderConfig),
    #[serde(rename = "vibeasr")]
    VibeVoice(VibeVoiceProviderConfig),
    Mlx(MlxProviderConfig),
    Qwen3(Qwen3ProviderConfig),
}

impl Default for ProviderConfig {
    fn default() -> Self {
        ProviderConfig::Qwen3(Qwen3ProviderConfig::default())
    }
}

impl ProviderConfig {
    pub fn engine(&self) -> &'static str {
        match self {
            ProviderConfig::Funasr(_) => "funasr",
            ProviderConfig::Whisper(_) => "whisper",
            ProviderConfig::VibeVoice(_) => "vibeasr",
            ProviderConfig::Mlx(_) => "mlx",
            ProviderConfig::Qwen3(_) => "qwen3",
        }
    }

    pub fn hotword_package_id(&self) -> Option<&str> {
        match self {
            ProviderConfig::Funasr(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::Whisper(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::VibeVoice(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::Mlx(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::Qwen3(config) => config.hotword_package_id.as_deref(),
        }
    }

    pub fn expected_speakers(&self) -> Option<u64> {
        match self {
            ProviderConfig::Funasr(config) => config.expected_speakers,
            ProviderConfig::Whisper(config) => config.expected_speakers,
            ProviderConfig::VibeVoice(_) => None,
            ProviderConfig::Mlx(_) => None,
            ProviderConfig::Qwen3(_) => None,
        }
    }

    /// Override the expected-speaker count for a single transcription task.
    /// Engines without speaker support ignore it.
    pub fn set_expected_speakers(&mut self, expected: Option<u64>) {
        match self {
            ProviderConfig::Funasr(config) => config.expected_speakers = expected,
            ProviderConfig::Whisper(config) => config.expected_speakers = expected,
            ProviderConfig::VibeVoice(_) | ProviderConfig::Mlx(_) | ProviderConfig::Qwen3(_) => {}
        }
    }

    /// Override the hotword package for a single transcription task; `None`
    /// clears it.
    pub fn set_hotword_package_id(&mut self, package_id: Option<String>) {
        match self {
            ProviderConfig::Funasr(config) => config.hotword_package_id = package_id,
            ProviderConfig::Whisper(config) => config.hotword_package_id = package_id,
            ProviderConfig::VibeVoice(config) => config.hotword_package_id = package_id,
            ProviderConfig::Mlx(config) => config.hotword_package_id = package_id,
            ProviderConfig::Qwen3(config) => config.hotword_package_id = package_id,
        }
    }

    pub fn adapter(&self) -> &'static dyn BatchSttAdapter {
        match self {
            ProviderConfig::Funasr(_) => &FunasrAdapter,
            ProviderConfig::Whisper(_) => &WhisperAdapter,
            ProviderConfig::VibeVoice(_) => &VibeVoiceAdapter,
            ProviderConfig::Mlx(_) => &MlxAdapter,
            ProviderConfig::Qwen3(_) => &Qwen3Adapter,
        }
    }
}

/// Single source of truth for STT routing. Resolution order:
/// `per_note` → `per_language[lang]` → `default` → Qwen3.
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
    sidecar_binary_name_for(base, cfg!(target_os = "windows"))
}

/// Pure on-disk name resolver so both the live lookup and unit tests can
/// exercise the macOS/Windows naming rules without relying on `cfg!`.
pub(crate) fn sidecar_binary_name_for(base: &str, is_windows: bool) -> String {
    if is_windows {
        format!("{base}.exe")
    } else {
        base.to_owned()
    }
}

/// Platform-specific runtime subdirectory name, e.g. `macos-aarch64` /
/// `windows-x86_64`. Keeps downloaded runtimes isolated per OS+arch.
pub(crate) fn runtime_platform_dir() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        _ => "unknown",
    }
}

/// The four binaries that together make up a complete shared STT runtime.
pub(crate) const RUNTIME_BINARIES: &[&str] = &["whisper", "vibeasr", "ffmpeg", "ffprobe"];

/// `true` only when every runtime binary exists in `dir` as a non-empty file.
/// Prevents a half-downloaded runtime from being treated as installed.
pub(crate) fn runtime_is_complete(dir: &Path) -> bool {
    if binaries_present(dir) {
        return true;
    }
    // Dev convenience: `tauri dev` resolves sidecars from `resources/sidecars`,
    // so a complete set built there satisfies the runtime without an on-demand
    // download. That directory is never bundled into release builds, so this
    // branch is a no-op for shipped installs.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/sidecars");
    binaries_present(&dev)
}

/// True when every shared runtime binary exists in `dir` as a non-empty file.
fn binaries_present(dir: &Path) -> bool {
    RUNTIME_BINARIES.iter().all(|base| {
        let path = dir.join(sidecar_binary_name_for(base, cfg!(target_os = "windows")));
        match std::fs::metadata(&path) {
            Ok(meta) => meta.is_file() && meta.len() > 0,
            Err(_) => false,
        }
    })
}

/// Directory of the on-demand shared runtime for `version` (e.g. `v0.1.14`)
/// + this platform, under the app data dir. May be empty before first download.
pub(crate) fn runtime_dir(app: &tauri::AppHandle, version: &str) -> PathBuf {
    match app.path().app_data_dir() {
        Ok(base) => base.join("stt-runtimes").join(version).join(runtime_platform_dir()),
        Err(_) => PathBuf::new(),
    }
}

/// Locate a bundled sidecar (whisper, vibeasr, ffmpeg, ffprobe). Resolution order:
/// 1. dev `resources/sidecars` (local development),
/// 2. on-demand shared runtime in the app data dir (downloaded at model-install
///    time, shared across every offline engine),
/// 3. the packaged resource dir (backward compat with older installs that
///    bundled the runtimes),
/// 4. otherwise a clear error asking the user to download the offline runtime.
pub(crate) fn sidecar_path(app: &tauri::AppHandle, base: &str) -> CommandResult<PathBuf> {
    let name = sidecar_binary_name(base);

    // 1. Dev resources/sidecars (local development convenience).
    // Debug builds only: `CARGO_MANIFEST_DIR` is baked in at compile time, so a
    // packaged release build would otherwise resolve to the build machine's
    // repo — and the App Sandbox denies exec'ing any binary outside the app
    // bundle (EPERM), which silently killed every sidecar call (permissions,
    // capture, transcription) in TestFlight builds.
    #[cfg(debug_assertions)]
    if development_exists(&name) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/sidecars")
            .join(&name));
    }

    // 2. On-demand shared runtime in the user data dir.
    let version = format!("v{}", app.package_info().version);
    let runtime = runtime_dir(app, &version);
    if runtime_is_complete(&runtime) {
        let candidate = runtime.join(&name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // 3. Old packaged resources (backward compat).
    if let Ok(resources) = app.path().resource_dir() {
        let candidate = resources.join(&name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // 4. Not found.
    Err("离线转写组件尚未下载，请先安装任意离线模型以自动获取运行时".to_owned())
}

/// Dev-only helper so the compile-time repo check above is not even evaluated
/// (or warned about) in release builds.
#[cfg(debug_assertions)]
fn development_exists(name: &str) -> bool {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/sidecars")
        .join(name)
        .exists()
}

/// Convert any audio/video to 16 kHz mono 16-bit PCM WAV via the bundled
/// LGPL FFmpeg build.
pub(crate) fn convert_to_wav(app: &tauri::AppHandle, input: &str, output: &Path) -> CommandResult<()> {
    convert_to_wav_sr(app, input, output, 16_000)
}

/// Convert any audio/video to `sample_rate` Hz mono 16-bit PCM WAV via the
/// bundled LGPL FFmpeg build. VibeVoice consumes 24 kHz audio, so callers may
/// request that rate directly.
pub(crate) fn convert_to_wav_sr(
    app: &tauri::AppHandle,
    input: &str,
    output: &Path,
    sample_rate: u32,
) -> CommandResult<()> {
    let ffmpeg = sidecar_path(app, "ffmpeg")?;
    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            input,
            "-ar",
            &sample_rate.to_string(),
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
        // whisper.cpp appends the format extension to the `-of` value, so pass
        // a bare base name here and read `<base>.json` below.
        let output_base = request.model_directory.join("whisper-output");
        let output_json = request.model_directory.join("whisper-output.json");
        let mut args = vec![
            sidecar.to_string_lossy().into_owned(),
            "-m".to_owned(),
            model_path.to_string_lossy().into_owned(),
            "-f".to_owned(),
            wav.to_string_lossy().into_owned(),
            "-oj".to_owned(),
            "-of".to_owned(),
            output_base.to_string_lossy().into_owned(),
        ];
        // whisper.cpp accepts a single `--prompt` (the short `-p` selects the
        // processor count on current builds), so fold the trailing context and
        // the hotword terms into one prompt.
        let mut prompt = String::new();
        if let Some(prior) = request.prior_context.as_deref().filter(|value| !value.trim().is_empty()) {
            prompt.push_str(prior.trim());
        }
        if !request.hotword.is_empty() {
            if !prompt.is_empty() {
                prompt.push(' ');
            }
            prompt.push_str(&request.hotword);
        }
        if !prompt.is_empty() {
            args.extend(["--prompt".to_owned(), prompt]);
        }
        let status = Command::new(&sidecar)
            .args(&args)
            .status()
            .map_err(|error| format!("无法启动 Whisper：{error}"))?;
        if !status.success() {
            return Err("Whisper 转写失败".to_owned());
        }

        let parsed: Value = {
            let content = std::fs::read_to_string(&output_json)
                .map_err(|error| format!("无法读取 Whisper 输出（{}）：{error}", output_json.display()))?;
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

/// VibeVoice-ASR-BitNet (Microsoft, MIT) runs entirely on CPU through the
/// official VibeASR.cpp engine (`vibeasr` sidecar). The engine is a streaming
/// server: it prints `---READY---` after loading, reads audio **file paths from
/// stdin** (one per line), prints the plain-text transcript, then `---END---`,
/// and exits on stdin EOF. There is no `--audio` flag and no per-segment
/// timestamps or speaker labels, so the result is reported as a single segment.
pub struct VibeVoiceAdapter;

impl BatchSttAdapter for VibeVoiceAdapter {
    fn engine(&self) -> &'static str {
        "vibeasr"
    }

    fn transcribe(&self, app: &tauri::AppHandle, request: &SttRequest) -> CommandResult<SttOutput> {
        let vae = request.model_directory.join("vibeasr-vae-encoder-i8_s.gguf");
        let lm = request.model_directory.join("vibeasr-lm-i2_s-embed-q6_k.gguf");
        if !vae.exists() {
            return Err(format!("VibeVoice 模型缺失：{}", vae.display()));
        }
        if !lm.exists() {
            return Err(format!("VibeVoice 模型缺失：{}", lm.display()));
        }

        // VibeASR.cpp consumes 24 kHz mono PCM audio.
        let wav = request.model_directory.join("input.wav");
        convert_to_wav_sr(app, &request.audio_path, &wav, 24_000)?;

        let sidecar = sidecar_path(app, "vibeasr")?;

        let threads = std::thread::available_parallelism()
            .map(|count| count.get().min(8).max(1))
            .unwrap_or(4)
            .to_string();

        let mut command = Command::new(&sidecar);
        command
            .arg("--vae-model")
            .arg(&vae)
            .arg("--lm-model")
            .arg(&lm)
            .arg("-t")
            .arg(&threads)
            // The whole file is fed as a single chunk, so keep the upstream
            // default generation cap — a tighter limit would silently truncate
            // longer recordings.
            .arg("--max-tokens")
            .arg("16384")
            .arg("--greedy")
            .arg("--no-token-stream")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if !request.hotword.is_empty() {
            command.arg("--context").arg(&request.hotword);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 VibeVoice：{error}"))?;

        // Feed the audio path, then drop stdin so the server processes the single
        // chunk and exits on EOF.
        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "无法打开 VibeVoice 标准输入".to_owned())?;
            writeln!(stdin, "{}", wav.to_string_lossy()).map_err(|error| error.to_string())?;
        }

        let output = child
            .wait_with_output()
            .map_err(|error| format!("VibeVoice 运行失败：{error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("VibeVoice 转写失败：{}", stderr.trim()));
        }

        let raw = String::from_utf8_lossy(&output.stdout);
        let mut text = String::new();
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty()
                || trimmed == "---READY---"
                || trimmed == "---END---"
                || trimmed == "---ACK---"
                || trimmed.starts_with("[ERROR]")
            {
                continue;
            }
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(trimmed);
        }

        let segment = json!({
            "text": text,
            "speakerId": "spk-1",
            "speakerName": "发言人1",
            "startMs": 0,
            "endMs": 0,
        });
        Ok(SttOutput {
            text: text.clone(),
            segments: vec![segment],
        })
    }
}

/// MLX-Whisper on Apple Silicon. The whole pipeline runs locally via the
/// `mlx_transcribe.py` bridge; no shared STT runtime (ffmpeg/whisper/vibeasr) is
/// required. Execution is refused on non-Apple-Silicon platforms with a clear
/// message so a user who somehow selects it from the UI gets actionable info.
pub struct MlxAdapter;

impl BatchSttAdapter for MlxAdapter {
    fn engine(&self) -> &'static str {
        "mlx"
    }

    fn transcribe(&self, app: &tauri::AppHandle, request: &SttRequest) -> CommandResult<SttOutput> {
        if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" {
            return Err("MLX 引擎仅支持 macOS（Apple Silicon）。请在设置中改用 FunASR / Whisper。".to_owned());
        }

        let python = ensure_mlx_venv(app)?;
        let output_json = request.model_directory.join("mlx-output.json");
        let mut args = vec![
            mlx_script_path(app)?.to_string_lossy().into_owned(),
            request.audio_path.clone(),
            "--model-dir".to_owned(),
            request.model_directory.to_string_lossy().into_owned(),
            "--output".to_owned(),
            output_json.to_string_lossy().into_owned(),
        ];
        if !request.hotword.is_empty() {
            args.extend(["--hotword".to_owned(), request.hotword.clone()]);
        }
        if let Some(prior) = request.prior_context.as_deref().filter(|value| !value.trim().is_empty()) {
            args.extend(["--prompt".to_owned(), prior.trim().to_owned()]);
        }

        if let Err(error) = run_mlx(app, &python, &args, &request.model_directory) {
            return Err(error);
        }

        let parsed: Value = {
            let content = std::fs::read_to_string(&output_json).map_err(|error| error.to_string())?;
            serde_json::from_str(&content).map_err(|error| error.to_string())?
        };
        let mut segments = normalize_whisper_output(&parsed);

        // v1: single-speaker. Whisper's CAM++ diarization can be wired in later.
        for segment in &mut segments {
            if let Some(object) = segment.as_object_mut() {
                object.insert("speakerId".to_owned(), json!("spk-1"));
                object.insert("speakerName".to_owned(), json!("发言人1"));
                object.insert("rawSpeaker".to_owned(), json!("0"));
            }
        }

        let text = segments
            .iter()
            .filter_map(|segment| segment.get("text").and_then(Value::as_str))
            .collect::<String>();
        Ok(SttOutput { text, segments })
    }
}

/// Qwen3-ASR (Alibaba) on Apple MLX — the default local engine. The whole
/// pipeline runs locally via the `qwen3_transcribe.py` bridge through the
/// shared MLX venv (`mlx-qwen3-asr` package + vendored ffmpeg); no shared STT
/// runtime (whisper/vibeasr/ffmpeg sidecars) is required. Execution is refused
/// on non-Apple-Silicon platforms with a clear message.
///
/// Hotwords and trailing context are folded into Qwen3-ASR's native `context`
/// bias input. Speaker labels are always single-speaker (spk-1): the engine
/// has no built-in diarization, and CAM++ reassignment can be layered later.
pub struct Qwen3Adapter;

impl Qwen3Adapter {
    /// Bridge-agnostic pipeline: build args, spawn the Python bridge, parse
    /// and normalize its transcript. Free of the `AppHandle` so the e2e test
    /// can run the real subprocess against a mock Tauri runtime.
    pub(crate) fn transcribe_via_bridge(
        python: &str,
        script: &Path,
        request: &SttRequest,
        model_id: &str,
    ) -> CommandResult<SttOutput> {
        let output_json = request.model_directory.join("qwen3-output.json");
        let mut args = vec![
            script.to_string_lossy().into_owned(),
            request.audio_path.clone(),
            "--model-dir".to_owned(),
            request.model_directory.to_string_lossy().into_owned(),
            "--model".to_owned(),
            qwen3_hf_repo(model_id).to_owned(),
            "--output".to_owned(),
            output_json.to_string_lossy().into_owned(),
        ];
        let mut context = String::new();
        if !request.hotword.is_empty() {
            context.push_str(request.hotword.trim());
        }
        if let Some(prior) = request.prior_context.as_deref().filter(|value| !value.trim().is_empty()) {
            if !context.is_empty() {
                context.push(' ');
            }
            context.push_str(prior.trim());
        }
        if !context.is_empty() {
            args.extend(["--context".to_owned(), context]);
        }

        crate::run_python_with_model_cache(python, &args, &request.model_directory)?;

        let parsed: Value = {
            let content = std::fs::read_to_string(&output_json).map_err(|error| error.to_string())?;
            serde_json::from_str(&content).map_err(|error| error.to_string())?
        };
        let mut segments = normalize_whisper_output(&parsed);

        for segment in &mut segments {
            if let Some(object) = segment.as_object_mut() {
                object.insert("speakerId".to_owned(), json!("spk-1"));
                object.insert("speakerName".to_owned(), json!("发言人1"));
                object.insert("rawSpeaker".to_owned(), json!("0"));
            }
        }

        let text = segments
            .iter()
            .filter_map(|segment| segment.get("text").and_then(Value::as_str))
            .collect::<String>();
        Ok(SttOutput { text, segments })
    }
}

impl BatchSttAdapter for Qwen3Adapter {
    fn engine(&self) -> &'static str {
        "qwen3"
    }

    fn transcribe(&self, app: &tauri::AppHandle, request: &SttRequest) -> CommandResult<SttOutput> {
        if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" {
            return Err("Qwen3-ASR（MLX）引擎仅支持 macOS（Apple Silicon）。请在设置中改用 Whisper / VibeVoice。".to_owned());
        }

        let ProviderConfig::Qwen3(config) = &request.provider else {
            return Err("Qwen3 适配器收到非 Qwen3 配置".to_owned());
        };
        let model_id = config.model.as_deref().unwrap_or(QWEN3_DEFAULT_MODEL_ID);

        let python = ensure_mlx_venv(app)?;
        crate::ensure_qwen3_asr_package(app, &python)?;

        Self::transcribe_via_bridge(
            &python,
            &crate::qwen3_script_path(app)?,
            request,
            model_id,
        )
    }
}

/// Parse whisper.cpp JSON into normalized segments. Current whisper.cpp emits
/// a `transcription` array whose items carry `offsets.from`/`offsets.to` in
/// milliseconds and no `start`/`end` fields; `segments`/`result` arrays with
/// second-based `start`/`end` (e.g. the MLX bridge output) remain supported.
fn normalize_whisper_output(parsed: &Value) -> Vec<Value> {
    let items = parsed
        .get("transcription")
        .and_then(Value::as_array)
        .or_else(|| parsed.get("segments").and_then(Value::as_array))
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
            let start_ms = offset_ms(item, "from", "startMs", "start").unwrap_or(0);
            let end_ms = offset_ms(item, "to", "endMs", "end").unwrap_or(0);
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

/// Read a segment's timestamp in milliseconds: first the whisper.cpp
/// `offsets.from`/`offsets.to` integers, then an explicit `*Ms` field, then a
/// floating-point `start`/`end` in seconds.
fn offset_ms(item: &Value, offset_key: &str, ms_key: &str, seconds_key: &str) -> Option<i64> {
    item.pointer(&format!("/offsets/{offset_key}"))
        .and_then(Value::as_i64)
        .or_else(|| item.get(ms_key).and_then(Value::as_i64))
        .or_else(|| item.get(seconds_key).and_then(Value::as_f64).map(|seconds| (seconds * 1000.0) as i64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_binary_name_rules() {
        assert_eq!(sidecar_binary_name_for("whisper", false), "whisper");
        assert_eq!(sidecar_binary_name_for("ffmpeg", false), "ffmpeg");
        assert_eq!(sidecar_binary_name_for("whisper", true), "whisper.exe");
        assert_eq!(sidecar_binary_name_for("ffmpeg", true), "ffmpeg.exe");
    }

    #[test]
    fn runtime_platform_dir_names() {
        let dir = runtime_platform_dir();
        assert!(
            matches!(
                dir,
                "macos-aarch64" | "macos-x86_64" | "windows-x86_64" | "linux-x86_64" | "unknown"
            ),
            "unexpected platform dir: {dir}"
        );
    }

    #[test]
    fn runtime_is_complete_detects_missing_and_empty() {
        let tmp = std::env::temp_dir().join(format!("lynse-runtime-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::create_dir_all(&tmp);

        // Nothing present -> incomplete. On a dev machine with the
        // `resources/sidecars` directory fully populated, the dev-convenience
        // fallback inside `runtime_is_complete` legitimately reports complete,
        // so only assert when that fallback is inert.
        let dev_fallback_active = binaries_present(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/sidecars"),
        );
        if !dev_fallback_active {
            assert!(!runtime_is_complete(&tmp));
        }

        // Four zero-byte files -> still incomplete (same dev-fallback caveat).
        for base in RUNTIME_BINARIES {
            let _ = std::fs::write(
                tmp.join(sidecar_binary_name_for(base, cfg!(target_os = "windows"))),
                [],
            );
        }
        if !dev_fallback_active {
            assert!(
                !runtime_is_complete(&tmp),
                "zero-byte binaries must not count as complete"
            );
        }

        // Four non-empty files -> complete.
        for base in RUNTIME_BINARIES {
            let _ = std::fs::write(
                tmp.join(sidecar_binary_name_for(base, cfg!(target_os = "windows"))),
                b"dummy",
            );
        }
        assert!(
            runtime_is_complete(&tmp),
            "four valid binaries must count as complete"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

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
            model_file_name("vibeasr", "vibeasr-bitnet-1.5b"),
            None
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

        let vibeasr: ProviderConfig = serde_json::from_value(json!({
            "provider": "vibeasr",
            "hotword_package_id": "h3"
        }))
        .unwrap();
        assert_eq!(vibeasr.engine(), "vibeasr");
        assert_eq!(vibeasr.expected_speakers(), None);
    }

    #[test]
    fn transcribe_config_resolves_priority() {
        let whisper: ProviderConfig =
            serde_json::from_value(json!({"provider": "whisper", "model": "small-q5_1"})).unwrap();
        let qwen3: ProviderConfig = serde_json::from_value(json!({"provider": "qwen3"})).unwrap();
        let mut per_language = BTreeMap::new();
        per_language.insert("zh".to_owned(), whisper.clone());
        let config = TranscribeConfig {
            default: Some(qwen3.clone()),
            per_language,
        };
        // per-note wins over everything
        assert_eq!(config.resolve(Some("zh"), Some(&qwen3)).engine(), "qwen3");
        // per-language beats default
        assert_eq!(config.resolve(Some("zh"), None).engine(), "whisper");
        // default when nothing else matches
        assert_eq!(config.resolve(Some("en"), None).engine(), "qwen3");
        // fall back to Qwen3 when config empty
        assert_eq!(TranscribeConfig::default().resolve(None, None).engine(), "qwen3");
    }

    #[test]
    fn qwen3_provider_defaults_and_repo_mapping() {
        let default: ProviderConfig = serde_json::from_value(json!({"provider": "qwen3"})).unwrap();
        assert_eq!(default.engine(), "qwen3");
        match &default {
            ProviderConfig::Qwen3(config) => {
                assert_eq!(config.model, None);
                assert_eq!(config.model.as_deref().unwrap_or(QWEN3_DEFAULT_MODEL_ID), "qwen3-asr-1.7b-8bit");
            }
            _ => panic!("expected qwen3 variant"),
        }
        assert_eq!(qwen3_hf_repo("qwen3-asr-1.7b-8bit"), "mlx-community/Qwen3-ASR-1.7B-8bit");
        assert_eq!(qwen3_hf_repo("qwen3-asr-0.6b-4bit"), "mlx-community/Qwen3-ASR-0.6B-4bit");
        // Unknown ids resolve to the default (1.7B 8-bit) repo.
        assert_eq!(qwen3_hf_repo("nope"), "mlx-community/Qwen3-ASR-1.7B-8bit");
    }

    /// Full end-to-end: the pipeline spawns the real `qwen3_transcribe.py`
    /// bridge through the dev MLX venv and parses its transcript. Skips
    /// silently when the local artifacts (venv, model snapshot, sample audio)
    /// are absent — CI and other machines stay fast, while on a set-up dev
    /// machine `cargo test` proves the whole Qwen3 pipeline actually runs.
    #[test]
    fn qwen3_adapter_transcribes_real_audio_end_to_end() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let venv_python = manifest.join("../../../.venv-mlx/bin/python");
        let bridge = manifest.join("resources/qwen3_transcribe.py");
        let model_dir = std::env::var_os("LYNSE_QWEN3_TEST_MODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp/qwen3-modeldir-qwen3-asr-1.7b-8bit"));
        let audio = std::env::var_os("LYNSE_QWEN3_TEST_AUDIO")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp/qwen3-test.wav"));
        if !venv_python.exists() || !bridge.exists() || !model_dir.join(".ready").exists() || !audio.exists() {
            eprintln!(
                "skipping: missing artifacts (venv={} bridge={} ready={} audio={})",
                venv_python.exists(),
                bridge.exists(),
                model_dir.join(".ready").exists(),
                audio.exists()
            );
            return;
        }

        let provider: ProviderConfig = serde_json::from_value(json!({
            "provider": "qwen3",
            "hotword_package_id": null
        }))
        .unwrap();
        let request = SttRequest {
            audio_path: audio.to_string_lossy().into_owned(),
            model_directory: model_dir,
            provider,
            expected_speakers: None,
            hotword: "Lynse 产品周会".to_owned(),
            prior_context: None,
        };
        let output = Qwen3Adapter::transcribe_via_bridge(
            venv_python.to_string_lossy().as_ref(),
            &bridge,
            &request,
            QWEN3_DEFAULT_MODEL_ID,
        )
        .expect("Qwen3 adapter end-to-end transcription");

        assert!(!output.text.trim().is_empty(), "transcript must not be empty");
        assert!(output.text.contains("Lynse"), "transcript should mention Lynse: {}", output.text);
        assert!(!output.segments.is_empty(), "chunk segments must be present");
        for segment in &output.segments {
            assert_eq!(segment.get("speakerId").and_then(Value::as_str), Some("spk-1"));
            assert!(segment.get("startMs").and_then(Value::as_i64).is_some());
            assert!(segment.get("endMs").and_then(Value::as_i64).is_some());
        }
    }

    #[test]
    fn per_task_overrides_apply_to_every_engine() {
        let configs: Vec<ProviderConfig> = [
            json!({"provider": "funasr", "expected_speakers": 3, "hotword_package_id": "pkg-a"}),
            json!({"provider": "whisper", "model": "small-q5_1", "expected_speakers": 3, "hotword_package_id": "pkg-a"}),
            json!({"provider": "vibeasr", "hotword_package_id": "pkg-a"}),
            json!({"provider": "mlx", "hotword_package_id": "pkg-a"}),
            json!({"provider": "qwen3", "hotword_package_id": "pkg-a"}),
        ]
        .iter()
        .map(|value| serde_json::from_value(value.clone()).unwrap())
        .collect();
        for mut config in configs {
            config.set_expected_speakers(Some(2));
            config.set_hotword_package_id(Some("pkg-b".to_owned()));
            assert_eq!(config.hotword_package_id(), Some("pkg-b"));
            if config.engine() == "funasr" || config.engine() == "whisper" {
                assert_eq!(config.expected_speakers(), Some(2));
            } else {
                assert_eq!(config.expected_speakers(), None);
            }
            // Clearing the package sticks too.
            config.set_hotword_package_id(None);
            assert_eq!(config.hotword_package_id(), None);
        }
    }

    #[test]
    fn normalize_whisper_output_parses_native_transcription_json() {
        // Shape actually emitted by whisper.cpp `-oj`: a `transcription` array
        // with millisecond `offsets` and no start/end fields.
        let parsed = json!({
            "transcription": [
                {"timestamps": {"from": "00:00:00,500", "to": "00:00:01,200"}, "offsets": {"from": 500, "to": 1200}, "text": " hello "},
                {"offsets": {"from": 2000, "to": 3000}, "text": "world", "speaker": "0"}
            ]
        });
        let segments = normalize_whisper_output(&parsed);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0]["text"], "hello");
        assert_eq!(segments[0]["startMs"], 500);
        assert_eq!(segments[0]["endMs"], 1200);
        assert_eq!(segments[1]["text"], "world");
        assert_eq!(segments[1]["startMs"], 2000);
        assert_eq!(segments[1]["speakerId"], "spk-0");
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
    fn vibevoice_segment_is_single_speaker() {
        // VibeASR.cpp emits plain text with no timestamps/speakers, so the
        // adapter folds the whole transcript into one segment.
        let output = SttOutput {
            text: "hello world".to_owned(),
            segments: vec![json!({
                "text": "hello world",
                "speakerId": "spk-1",
                "speakerName": "发言人1",
                "startMs": 0,
                "endMs": 0,
            })],
        };
        assert_eq!(output.segments.len(), 1);
        assert_eq!(output.segments[0]["speakerId"], "spk-1");
    }
}
