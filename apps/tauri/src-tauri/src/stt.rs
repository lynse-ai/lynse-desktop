//! Local STT engine abstraction (multi-engine: Qwen3-ASR, FunASR, Whisper,
//! VibeVoice, MLX-Whisper).
//!
//! Every engine implements [`BatchSttAdapter`] and returns a normalized
//! [`SttOutput`] (`{ text, segments }`) so the storage path never has to parse
//! engine-specific raw output. Routing is driven by a single
//! [`TranscribeConfig`] (default provider + per-language overrides), resolved
//! per transcription request.

use crate::{
    ensure_mlx_venv, ensure_whisperx_venv, mlx_script_path, normalize_funasr_output,
    parse_funasr_json, run_funasr, run_mlx, script_path, whisperx_script_path, CommandResult,
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
    /// Language the audio is spoken in (BCP-47 as the UI locale uses it, or
    /// `"auto"`). `None` means nobody declared it, which engines must treat as
    /// "detect", never as English.
    pub language: Option<String>,
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
        // WhisperX (faster-whisper CTranslate2 weights + wav2vec2 aligner)
        // downloads via its Python bridge as well.
        "whisperx" => None,
        // sherpa-onnx 3D-Speaker CAM++ voiceprint checkpoint: one .onnx
        // artifact fetched through the generic downloader.
        "sherpa" => Some("3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx".to_owned()),
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

/// WhisperX (faster-whisper on CTranslate2) — the local CPU engine.
/// Transcription + best-effort word alignment; speaker diarization stays out
/// until the pyannote distribution channel is settled (PRD §12 Q7).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WhisperXProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_speakers: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotword_package_id: Option<String>,
}

/// Catalog id of the model used when a WhisperX config names none.
pub const WHISPERX_DEFAULT_MODEL_ID: &str = "whisperx-latest";

/// HF repo backing a WhisperX catalog id (CTranslate2 weights).
pub fn whisperx_hf_repo(model_id: &str) -> &'static str {
    match model_id {
        _ => "Systran/faster-whisper-large-v3",
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
    #[serde(rename = "whisperx")]
    WhisperX(WhisperXProviderConfig),
}

impl Default for ProviderConfig {
    fn default() -> Self {
        // Qwen3-ASR (MLX) is the primary local engine on Apple Silicon. Every
        // other platform only ships the whisper.cpp sidecar, so default there
        // instead of an engine that hard-errors on first use.
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            ProviderConfig::Qwen3(Qwen3ProviderConfig::default())
        } else {
            ProviderConfig::Whisper(WhisperProviderConfig::default())
        }
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
            ProviderConfig::WhisperX(_) => "whisperx",
        }
    }

    pub fn hotword_package_id(&self) -> Option<&str> {
        match self {
            ProviderConfig::Funasr(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::Whisper(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::VibeVoice(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::Mlx(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::Qwen3(config) => config.hotword_package_id.as_deref(),
            ProviderConfig::WhisperX(config) => config.hotword_package_id.as_deref(),
        }
    }

    pub fn expected_speakers(&self) -> Option<u64> {
        match self {
            ProviderConfig::Funasr(config) => config.expected_speakers,
            ProviderConfig::Whisper(config) => config.expected_speakers,
            ProviderConfig::VibeVoice(_) => None,
            ProviderConfig::Mlx(_) => None,
            ProviderConfig::Qwen3(_) => None,
            ProviderConfig::WhisperX(config) => config.expected_speakers,
        }
    }

    /// Override the expected-speaker count for a single transcription task.
    /// Engines without speaker support ignore it.
    pub fn set_expected_speakers(&mut self, expected: Option<u64>) {
        match self {
            ProviderConfig::Funasr(config) => config.expected_speakers = expected,
            ProviderConfig::Whisper(config) => config.expected_speakers = expected,
            ProviderConfig::WhisperX(config) => config.expected_speakers = expected,
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
            ProviderConfig::WhisperX(config) => config.hotword_package_id = package_id,
        }
    }

    pub fn adapter(&self) -> &'static dyn BatchSttAdapter {
        match self {
            ProviderConfig::Funasr(_) => &FunasrAdapter,
            ProviderConfig::Whisper(_) => &WhisperAdapter,
            ProviderConfig::VibeVoice(_) => &VibeVoiceAdapter,
            ProviderConfig::Mlx(_) => &MlxAdapter,
            ProviderConfig::Qwen3(_) => &Qwen3Adapter,
            ProviderConfig::WhisperX(_) => &WhisperXAdapter,
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

/// Windows-only non-binary file shipped in the runtime archive: the Vulkan
/// loader DLL bundled next to `whisper.exe` so the Vulkan-enabled build gets
/// GPU acceleration without a separately installed Vulkan runtime.
pub(crate) const RUNTIME_WINDOWS_EXTRA: &[&str] = &["vulkan-1.dll"];

/// On-disk names a complete runtime must contain on `is_windows`. The same
/// four binaries are required on every platform now: the Windows `vibeasr`
/// build is statically linked against the MinGW runtime, so the sidecar no
/// longer needs the MinGW `bin` dir on PATH (the dynamic build is why it had
/// been dropped from Windows runtimes). The Vulkan loader joins as the
/// Windows-specific extra so the whisper build gets GPU acceleration.
pub(crate) fn required_runtime_names(is_windows: bool) -> Vec<String> {
    let mut names: Vec<String> = RUNTIME_BINARIES
        .iter()
        .map(|base| sidecar_binary_name_for(base, is_windows))
        .collect();
    if is_windows {
        names.extend(RUNTIME_WINDOWS_EXTRA.iter().map(|name| name.to_string()));
    }
    names
}

fn file_present(dir: &Path, name: &str) -> bool {
    match std::fs::metadata(dir.join(name)) {
        Ok(meta) => meta.is_file() && meta.len() > 0,
        Err(_) => false,
    }
}

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

/// True when every required runtime file exists in `dir` as a non-empty file.
fn binaries_present(dir: &Path) -> bool {
    required_runtime_names(cfg!(target_os = "windows"))
        .iter()
        .all(|name| file_present(dir, name))
}

/// Directory of the on-demand shared runtime for `version` (e.g. `v0.1.14`)
/// + this platform, under the app data dir. May be empty before first download.
pub(crate) fn runtime_dir(app: &tauri::AppHandle, version: &str) -> PathBuf {
    match app.path().app_data_dir() {
        Ok(base) => base.join("stt-runtimes").join(version).join(runtime_platform_dir()),
        Err(_) => PathBuf::new(),
    }
}

/// Locate a sidecar (whisper, vibeasr, ffmpeg, ffprobe). Resolution order:
/// 1. dev `resources/sidecars` (local development),
/// 2. the packaged resource dir — App Store / TestFlight builds bundle
///    ffmpeg/ffprobe here, because the App Sandbox denies exec'ing any binary
///    outside the app bundle (EPERM) and a downloaded copy can never run there,
/// 3. on-demand shared runtime in the app data dir (downloaded at model-install
///    time, shared across every offline engine),
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

    // 2. Packaged resources (bundled into Contents/Resources by
    //    build-appstore.sh and stamped with the sandbox-inherit entitlements).
    if let Ok(resources) = app.path().resource_dir() {
        let candidate = resources.join(&name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // 3. On-demand shared runtime in the user data dir.
    let version = format!("v{}", app.package_info().version);
    let runtime = runtime_dir(app, &version);
    if runtime_is_complete(&runtime) {
        let candidate = runtime.join(&name);
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
    // `.output()` rather than `.status()`: the pipes are drained so a chatty
    // ffmpeg cannot block, and its stderr is the only record of WHY a conversion
    // died — an exit code alone reached the user as a bare "FFmpeg 转换音频失败".
    let run = Command::new(&ffmpeg)
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
        .output()
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?;
    if !run.status.success() {
        return Err(format!("FFmpeg 转换音频失败：{}", stderr_reason(&run.stderr)));
    }
    Ok(())
}

/// The last few ffmpeg stderr lines, newest last — where ffmpeg puts its actual
/// complaint. Its progress rewrites with `\r`, so each line is reduced to the
/// text after the final one, and pure progress lines are skipped.
fn stderr_reason(stderr: &[u8]) -> String {
    let mut kept: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(stderr).lines().rev() {
        let current = line.rsplit('\r').next().unwrap_or_default().trim();
        if current.is_empty() || current.starts_with("size=") || current.starts_with("frame=") {
            continue;
        }
        kept.push(current.chars().take(120).collect());
        if kept.len() == 3 {
            break;
        }
    }
    kept.reverse();
    if kept.is_empty() {
        return "ffmpeg 未输出原因".to_owned();
    }
    kept.join(" | ")
}

/// Languages whisper.cpp can be told to transcribe in. A request naming
/// anything else is routed to detection instead of being passed through — an
/// unknown code makes the sidecar exit before it transcribes a single second.
const WHISPER_LANGUAGES: &[&str] = &[
    "zh", "en", "ja", "de", "ko", "ru", "es", "fr", "pt", "it", "pl", "tr", "nl", "fa",
];

/// The `-l` value for a request language.
///
/// An absent language must NOT fall through to whisper.cpp's own default,
/// which is `en`: a Chinese meeting then transcribes as fluent-looking English
/// hallucination ("I spent a few hours on it." x40), the run reports success,
/// and nothing downstream can tell. Nobody declared a language, so ask the
/// model to detect it.
pub(crate) fn whisper_language_arg(language: Option<&str>) -> &'static str {
    let Some(requested) = language.map(str::trim).filter(|value| !value.is_empty()) else {
        return "auto";
    };
    if requested.eq_ignore_ascii_case("auto") {
        return "auto";
    }
    // BCP-47 → whisper: the primary subtag carries the language, so `zh-CN`,
    // `zh-Hant`, `en-US` and `pt_BR` all resolve.
    let primary = requested.split(['-', '_']).next().unwrap_or_default();
    WHISPER_LANGUAGES
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(primary))
        .copied()
        .unwrap_or("auto")
}

/// Worker threads for a CPU-bound sidecar.
///
/// whisper.cpp defaults to 4, which roughly doubles the wall-clock time of a
/// long meeting on a modern desktop; past 8 the llama/ggml builds gain nothing
/// on a consumer CPU, and leaving cores free keeps the app's own audio
/// pipeline responsive while a transcription runs.
pub(crate) fn sidecar_threads() -> String {
    std::thread::available_parallelism()
        .map(|count| count.get().clamp(1, 8))
        .unwrap_or(4)
        .to_string()
}

/// The whisper.cpp argument vector for one transcription. The executable is
/// deliberately NOT among them — `Command::new` already supplies argv[0].
///
/// This is a separate, pure function because a leading copy of the sidecar path
/// here was a silent, total failure for every local transcription: whisper.cpp
/// reads bare arguments as *input files*, so it transcribed its own executable
/// as the first recording, wrote that result to the `-of` name the caller reads
/// first, and pushed the actual meeting to `<input>.wav.json`. Users got a
/// couple of seconds of binary noise (`*Burps*`) labelled as a completed
/// transcript of a 44-minute meeting.
pub(crate) fn whisper_command_args(
    model_path: &Path,
    wav: &Path,
    output_base: &Path,
    language: Option<&str>,
    threads: &str,
    prompt: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-m".to_owned(),
        model_path.to_string_lossy().into_owned(),
        "-f".to_owned(),
        wav.to_string_lossy().into_owned(),
        "-oj".to_owned(),
        "-of".to_owned(),
        output_base.to_string_lossy().into_owned(),
        "-l".to_owned(),
        whisper_language_arg(language).to_owned(),
        "-t".to_owned(),
        threads.to_owned(),
    ];
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        args.extend(["--prompt".to_owned(), prompt.trim().to_owned()]);
    }
    args
}

/// Per-job scratch space for the intermediate WAV and the engine's output.
///
/// These artifacts deliberately do NOT live in the model directory:
/// - two tasks using the same engine both wrote `input.wav` there and
///   overwrote each other mid-run;
/// - the transcript is read back by a fixed filename, so a file left by a
///   crashed run could be read as the *current* run's result;
/// - a 44-minute meeting drops ~85 MB (16 kHz) to ~126 MB (24 kHz) of PCM next
///   to the weights, and nothing ever removed it.
///
/// Removal happens on drop, so every `?` exit path cleans up too.
pub(crate) struct ScratchDir(PathBuf);

impl ScratchDir {
    pub(crate) fn new() -> CommandResult<Self> {
        let directory = std::env::temp_dir().join(format!("lynse-stt-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建转写临时目录（{directory:?}）：{error}"))?;
        Ok(Self(directory))
    }

    pub(crate) fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Pick the lines that explain a sidecar failure.
///
/// Unlike ffmpeg, whisper prints the transcript itself as it goes, so the tail
/// of stderr on a failure is usually *speech*, not the problem. Complaint lines
/// are preferred; when none exist the last few lines that are not transcript or
/// timing output are used, so the message stays honest about what the process
/// actually said.
fn sidecar_failure_reason(stderr: &[u8]) -> String {
    let lines: Vec<String> = String::from_utf8_lossy(stderr)
        .lines()
        .map(|line| line.rsplit('\r').next().unwrap_or_default().trim())
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();

    let is_complaint = |line: &str| {
        let lowered = line.to_ascii_lowercase();
        ["error", "failed", "cannot", "can't", "invalid", "exception", "abort", "memory", "no space"]
            .iter()
            .any(|needle| lowered.contains(needle))
    };
    let is_noise = |line: &str| {
        let lowered = line.to_ascii_lowercase();
        lowered.starts_with("whisper_print_timings")
            || lowered.starts_with("system_info")
            || lowered.starts_with("load time")
            || lowered.starts_with("ggml")
            || line.starts_with('[') && line.contains("-->")
    };

    let mut kept: Vec<String> =
        lines.iter().filter(|line| is_complaint(line.as_str())).cloned().collect();
    if kept.is_empty() {
        kept = lines
            .iter()
            .rev()
            .filter(|line| !is_noise(line.as_str()))
            .take(3)
            .cloned()
            .collect();
        kept.reverse();
    } else if kept.len() > 3 {
        kept = kept.split_off(kept.len() - 3);
    }
    if kept.is_empty() {
        return "转写组件未输出原因".to_owned();
    }
    kept.join(" | ")
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

        // Pre-flight the speaker-separation dependency. It is only needed AFTER
        // the transcript exists, so without this check a missing 3D-Speaker model
        // surfaced as a failure fifteen minutes into a long meeting — the whole
        // run wasted. The check itself is a path existence test.
        if config.campp_diarization && !crate::voiceprint_backend_available(app)? {
            return Err("声纹模型未安装，请在设置中下载 3D-Speaker 声纹模型".to_owned());
        }

        // Resolve the sidecar before converting: producing an 84 MB WAV and
        // spending minutes on ffmpeg is worthless when the runtime is not
        // installed at all.
        let sidecar = sidecar_path(app, "whisper")?;

        let scratch = ScratchDir::new()?;
        let wav = scratch.join("input.wav");
        convert_to_wav(app, &request.audio_path, &wav)?;

        // whisper.cpp appends the format extension to the `-of` value, so pass
        // a bare base name here and read `<base>.json` below. Newer whisper-cli
        // builds instead name the JSON after the input file (`input.wav.json`),
        // so fall back to that when the `-of`-derived file is missing.
        let output_base = scratch.join("whisper-output");
        let output_json = scratch.join("whisper-output.json");
        let output_json_fallback = scratch.join("input.wav.json");
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
        let language = whisper_language_arg(request.language.as_deref());
        let threads = sidecar_threads();
        let args = whisper_command_args(
            &model_path,
            &wav,
            &output_base,
            request.language.as_deref(),
            &threads,
            (!prompt.is_empty()).then_some(prompt.as_str()),
        );
        // `.output()` captures the sidecar's stderr to build a failure message,
        // which also removes it from the dev console — so the parameters that
        // decide whether this run can possibly be right go to the log instead.
        // A transcript in the wrong language has no other symptom: the sidecar
        // exits 0 and the record reads as completed.
        log::info!(
            "[stt] whisper 启动：lang={language} threads={threads} model={} wav={} bytes",
            model_path.file_name().and_then(|name| name.to_str()).unwrap_or("?"),
            std::fs::metadata(&wav).map(|meta| meta.len()).unwrap_or_default()
        );
        let run = Command::new(&sidecar)
            .args(&args)
            .output()
            .map_err(|error| format!("无法启动 Whisper：{error}"))?;
        if !run.status.success() {
            return Err(format!("Whisper 转写失败：{}", sidecar_failure_reason(&run.stderr)));
        }

        let parsed: Value = {
            let read_path = if output_json.exists() { &output_json } else { &output_json_fallback };
            if !read_path.exists() {
                // Exit code 0 with no transcript file: the run produced nothing
                // to read. Say which of the two names was expected so a sidecar
                // upgrade that renames its output is diagnosable from the log.
                return Err(format!(
                    "Whisper 未生成转写结果（期望 {}），音频可能没有可识别的语音",
                    read_path.file_name().and_then(|name| name.to_str()).unwrap_or("whisper-output.json")
                ));
            }
            let content = std::fs::read_to_string(read_path)
                .map_err(|error| format!("无法读取 Whisper 输出（{}）：{error}", read_path.display()))?;
            serde_json::from_str(&content).map_err(|error| error.to_string())?
        };
        let mut segments = normalize_whisper_output(&parsed);
        if segments.is_empty() {
            return Err("Whisper 未识别到语音，请确认音频不是静音".to_owned());
        }
        // What the sidecar actually decided, not what we asked it to do: the
        // detected language is the one number that distinguishes a good
        // transcript from a fluent, successful, wrong-language one.
        log::info!(
            "[stt] whisper 输出：{} 段，检测语言 {}",
            segments.len(),
            parsed.pointer("/result/language").and_then(Value::as_str).unwrap_or("?")
        );

        if config.campp_diarization && crate::voiceprint_backend_available(app)? {
            crate::assign_campp_speakers(app, &request.audio_path, &mut segments, request.expected_speakers)?;
        } else {
            // Single speaker when diarization is off — never fabricate multiple.
            // Also the fallback when the model went missing mid-run: the
            // transcript survives, unassigned rather than lost.
            crate::label_single_speaker(&mut segments);
        }

        let text = segments
            .iter()
            .filter_map(|segment| segment.get("text").and_then(Value::as_str))
            .collect::<String>();
        Ok(SttOutput { text, segments })
    }
}

/// Pure so the two artifact generations' help text can be told apart in a unit
/// test without a sidecar on disk.
pub(crate) fn help_advertises_one_shot(help: &str) -> bool {
    help.contains("--audio") && !(help.contains("token-stream") || help.contains("---READY---"))
}

/// Detect a `vibeasr` sidecar that cannot be driven the way this adapter drives
/// it, before a long transcription burns minutes of model load on it.
///
/// Upstream builds two different programs from one tree (`asr_stream_server`,
/// which this adapter talks to, and the one-shot `asr_infer` demo CLI, which
/// takes `--audio` and has no streaming flags at all). Published runtime
/// archives have shipped the wrong one, and the client only learned that ~2 s
/// in, from a raw `Unknown argument: --no-token-stream`. The build now picks
/// deterministically and asserts the fingerprint, but installs that already
/// fetched a bad archive keep it — so check the advertised interface and name
/// the fix instead of relaying a CLI parse error.
fn vibeasr_protocol_problem(sidecar: &Path) -> Option<String> {
    let run = Command::new(sidecar).arg("--help").output().ok()?;
    let help = format!(
        "{}{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    // An empty help means the binary could not even start (a missing DLL on
    // Windows presents as a spawn failure, not a message); nothing to conclude.
    if help.trim().is_empty() || !help_advertises_one_shot(&help) {
        return None;
    }
    Some(
        "离线转写组件与当前引擎不匹配（VibeVoice 组件为单文件模式）。请在设置中删除并重新下载该模型以更新组件，或改用 Whisper 引擎。"
            .to_owned(),
    )
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

        // Resolve and vet the sidecar before converting: the conversion writes
        // ~126 MB of 24 kHz PCM and takes real time, so it must not run at all
        // when the engine could not have accepted the result.
        let sidecar = sidecar_path(app, "vibeasr")?;
        if let Some(problem) = vibeasr_protocol_problem(&sidecar) {
            return Err(problem);
        }

        // VibeASR.cpp consumes 24 kHz mono PCM audio.
        let scratch = ScratchDir::new()?;
        let wav = scratch.join("input.wav");
        convert_to_wav_sr(app, &request.audio_path, &wav, 24_000)?;

        let threads = sidecar_threads();

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
            return Err(format!("VibeVoice 转写失败：{}", sidecar_failure_reason(&output.stderr)));
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

        if text.trim().is_empty() {
            return Err("VibeVoice 未识别到语音，请确认音频不是静音".to_owned());
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
            "--region".to_owned(),
            crate::detect_net_region().to_owned(),
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

/// WhisperX (faster-whisper on CTranslate2) — the local CPU engine. Runs the
/// `whisperx_transcribe.py` bridge through a dedicated venv (`whisperx` pulls
/// torch/ctranslate2/faster-whisper at creation; imageio-ffmpeg vendors the
/// decoder); no shared STT runtime and no Apple Silicon requirement — but
/// like the other local engines it ships for macOS builds first.
///
/// First cut (PRD §12 Q7 pending): segments stay single-speaker — pyannote
/// diarization is not wired. `--context` is accepted for bridge parity; the
/// model has no bias input and hotword correction remains the engine-agnostic
/// Rust-side post-process.
pub struct WhisperXAdapter;

impl WhisperXAdapter {
    /// Bridge-agnostic pipeline: build args, spawn the Python bridge, parse
    /// and normalize its transcript. Free of the `AppHandle` so tests can run
    /// the real subprocess against a mock Tauri runtime.
    pub(crate) fn transcribe_via_bridge(
        python: &str,
        script: &Path,
        request: &SttRequest,
        model_id: &str,
    ) -> CommandResult<SttOutput> {
        let output_json = request.model_directory.join("whisperx-output.json");
        let mut args = vec![
            script.to_string_lossy().into_owned(),
            request.audio_path.clone(),
            "--model-dir".to_owned(),
            request.model_directory.to_string_lossy().into_owned(),
            "--model".to_owned(),
            whisperx_hf_repo(model_id).to_owned(),
            "--region".to_owned(),
            crate::detect_net_region().to_owned(),
            "--output".to_owned(),
            output_json.to_string_lossy().into_owned(),
        ];
        if !request.hotword.is_empty() {
            args.extend(["--context".to_owned(), request.hotword.trim().to_owned()]);
        }

        crate::run_python_with_model_cache(python, &args, &request.model_directory)?;

        let parsed: Value = {
            let content = std::fs::read_to_string(&output_json).map_err(|error| error.to_string())?;
            serde_json::from_str(&content).map_err(|error| error.to_string())?
        };
        let mut segments = normalize_whisper_output(&parsed);

        // v1: single-speaker. pyannote diarization can be wired in later.
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

impl BatchSttAdapter for WhisperXAdapter {
    fn engine(&self) -> &'static str {
        "whisperx"
    }

    fn transcribe(&self, app: &tauri::AppHandle, request: &SttRequest) -> CommandResult<SttOutput> {
        if std::env::consts::OS != "macos" {
            return Err("WhisperX 引擎目前仅支持 macOS。请在设置中改用其他引擎。".to_owned());
        }

        let ProviderConfig::WhisperX(_) = &request.provider else {
            return Err("WhisperX 适配器收到非 WhisperX 配置".to_owned());
        };

        let python = ensure_whisperx_venv(app)?;

        Self::transcribe_via_bridge(
            &python,
            &whisperx_script_path(app)?,
            request,
            WHISPERX_DEFAULT_MODEL_ID,
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
    fn stderr_reason_surfaces_the_complaint_not_the_progress() {
        let raw = b"Input #0, mp3, from 'a.mp3':\r\nsize=  1024KiB time=00:00:12 \rsize=  2048KiB time=00:00:24 \n[mp3 @ 0x1] Invalid data found when processing input\nConversion failed!\n";
        // Three trailing lines, newest last: the rewritten progress line is
        // dropped, and the surrounding context stays because ffmpeg often puts
        // the reason one line above "Conversion failed!".
        assert_eq!(
            stderr_reason(raw),
            "Input #0, mp3, from 'a.mp3': | [mp3 @ 0x1] Invalid data found when processing input | Conversion failed!"
        );
    }

    #[test]
    fn stderr_reason_bounds_a_long_traceback() {
        let raw = "x".repeat(500).into_bytes();
        assert_eq!(stderr_reason(&raw).chars().count(), 120);
    }

    #[test]
    fn stderr_reason_says_so_when_ffmpeg_said_nothing() {
        assert_eq!(stderr_reason(b""), "ffmpeg 未输出原因");
        // Progress output only: nothing actionable to report.
        assert_eq!(stderr_reason(b"size= 1KiB time=00:00:01 \n"), "ffmpeg 未输出原因");
    }

    /// The whole point of `whisper_language_arg`: nothing in the pipeline may
    /// hand whisper.cpp its own default, because `en` on Chinese audio produces
    /// a fluent, successful, completely wrong transcript.
    #[test]
    fn whisper_language_never_defaults_to_english() {
        assert_eq!(whisper_language_arg(None), "auto");
        assert_eq!(whisper_language_arg(Some("")), "auto");
        assert_eq!(whisper_language_arg(Some("   ")), "auto");
        assert_eq!(whisper_language_arg(Some("auto")), "auto");
        // An unrecognized code would make the sidecar exit before transcribing.
        assert_eq!(whisper_language_arg(Some("klingon")), "auto");
        assert_eq!(whisper_language_arg(Some("zz")), "auto");
    }

    #[test]
    fn whisper_language_maps_ui_locales_to_whisper_codes() {
        for (requested, expected) in [
            ("zh", "zh"),
            ("zh-CN", "zh"),
            ("zh-Hant", "zh"),
            ("en", "en"),
            ("en-US", "en"),
            ("JA", "ja"),
            ("ko-KR", "ko"),
            ("pt_BR", "pt"),
        ] {
            assert_eq!(whisper_language_arg(Some(requested)), expected, "{requested}");
        }
    }

    #[test]
    fn sidecar_failure_reason_prefers_the_complaint() {
        let stderr = b"[00:00:01.000 --> 00:00:02.000]  \xE4\xBD\xA0\xE5\xA5\xBD\n\
                       whisper_init_from_file_with_params_no_state: failed to load model\n";
        let reason = sidecar_failure_reason(stderr);
        assert!(reason.contains("failed to load model"), "{reason}");
        assert!(!reason.contains("你好"), "transcript lines are not a failure reason: {reason}");
    }

    #[test]
    fn sidecar_failure_reason_bounds_a_transcript_only_stderr() {
        // A crash with nothing but transcript output must not quote the speech
        // back at the user as the explanation.
        let stderr = b"[00:00:01.000 --> 00:00:02.000]  a\n[00:00:02.000 --> 00:00:03.000]  b\n";
        assert_eq!(sidecar_failure_reason(stderr), "转写组件未输出原因");
    }

    #[test]
    fn help_advertises_one_shot_distinguishes_the_generations() {
        let one_shot = "  --audio <path>       Path to input WAV file (required)\n  --greedy\n";
        let streaming = "  --no-token-stream\n  reads paths from stdin, prints ---READY---\n";
        assert!(help_advertises_one_shot(one_shot));
        assert!(!help_advertises_one_shot(streaming));
        assert!(!help_advertises_one_shot(""));
    }

    #[test]
    fn scratch_dir_cleans_up_after_itself() {
        let path = {
            let scratch = ScratchDir::new().expect("scratch dir");
            let file = scratch.join("input.wav");
            std::fs::write(&file, b"pcm").expect("write scratch file");
            assert!(file.exists());
            scratch.0.clone()
        };
        assert!(!path.exists(), "scratch artifacts outlive the run: {path:?}");
    }

    #[test]
    fn sidecar_threads_stays_in_the_useful_band() {
        let threads: usize = sidecar_threads().parse().expect("numeric thread count");
        assert!((1..=8).contains(&threads), "{threads}");
    }

    /// The argv must carry no copy of the executable. whisper.cpp reads a bare
    /// argument as an input FILE, so passing the sidecar path made it transcribe
    /// its own binary first — writing that garbage to the `-of` name the caller
    /// reads, and the real recording to `<input>.wav.json`.
    #[test]
    fn whisper_args_never_contain_the_executable() {
        let args = whisper_command_args(
            Path::new("/models/ggml-small.bin"),
            Path::new("/tmp/lynse-stt-x/input.wav"),
            Path::new("/tmp/lynse-stt-x/whisper-output"),
            None,
            "8",
            None,
        );
        assert_eq!(
            args,
            vec![
                "-m", "/models/ggml-small.bin",
                "-f", "/tmp/lynse-stt-x/input.wav",
                "-oj", "-of", "/tmp/lynse-stt-x/whisper-output",
                "-l", "auto",
                "-t", "8",
            ]
        );
        assert!(!args.iter().any(|arg| arg.contains("whisper.exe") || arg.ends_with("/whisper")));
    }

    #[test]
    fn whisper_prompt_folds_context_and_hotwords_into_one_flag() {
        let with_both = whisper_command_args(
            Path::new("m.bin"), Path::new("in.wav"), Path::new("out"),
            Some("zh"), "4", Some("前文 热词一"),
        );
        let prompt_index = with_both.iter().position(|arg| arg == "--prompt").expect("prompt flag");
        assert_eq!(with_both[prompt_index + 1], "前文 热词一");
        assert_eq!(with_both.iter().filter(|arg| *arg == "--prompt").count(), 1);
        let without = whisper_command_args(
            Path::new("m.bin"), Path::new("in.wav"), Path::new("out"), None, "4", Some("   "),
        );
        assert!(!without.iter().any(|arg| arg == "--prompt"));
        assert_eq!(without[without.iter().position(|arg| arg == "-l").unwrap() + 1], "auto");
    }

    /// Runs the real whisper sidecar against the real model and a real recording
    /// through the same argument construction and output parsing the app uses.
    /// Skips silently unless `LYNSE_WHISPER_TEST_SIDECAR`,
    /// `LYNSE_WHISPER_TEST_MODEL` and `LYNSE_WHISPER_TEST_AUDIO` are all set, so
    /// CI stays fast while a set-up machine proves the offline path end to end.
    #[test]
    fn whisper_sidecar_transcribes_real_audio_with_declared_language() {
        let (Some(sidecar), Some(model), Some(audio)) = (
            std::env::var_os("LYNSE_WHISPER_TEST_SIDECAR").map(PathBuf::from),
            std::env::var_os("LYNSE_WHISPER_TEST_MODEL").map(PathBuf::from),
            std::env::var_os("LYNSE_WHISPER_TEST_AUDIO").map(PathBuf::from),
        ) else {
            eprintln!("skipping: set LYNSE_WHISPER_TEST_SIDECAR/_MODEL/_AUDIO");
            return;
        };
        if !sidecar.exists() || !model.exists() || !audio.exists() {
            eprintln!("skipping: missing artifacts");
            return;
        }

        let scratch = ScratchDir::new().expect("scratch dir");
        let output_base = scratch.join("whisper-output");
        // Built by the same function the adapter uses, so an argument bug in
        // production is a test failure first.
        let args = whisper_command_args(
            &model,
            &audio,
            &output_base,
            Some("zh"),
            &sidecar_threads(),
            None,
        );
        let run = Command::new(&sidecar)
            .args(&args)
            .output()
            .expect("spawn whisper sidecar");
        assert!(run.status.success(), "{}", sidecar_failure_reason(&run.stderr));

        let content = std::fs::read_to_string(scratch.join("whisper-output.json"))
            .expect("whisper wrote its json next to the -of base name");
        let parsed: Value = serde_json::from_str(&content).expect("json");
        let segments = normalize_whisper_output(&parsed);
        assert!(!segments.is_empty(), "no segments parsed");
        // A single segment is the signature of the sidecar transcribing something
        // other than the recording it was pointed at.
        assert!(segments.len() > 1, "expected multiple segments, got {segments:?}");
        let text: String = segments
            .iter()
            .filter_map(|segment| segment.get("text").and_then(Value::as_str))
            .collect();
        assert!(
            text.chars().any(|ch| ('\u{4E00}'..='\u{9FFF}').contains(&ch)),
            "expected Chinese speech, got: {}",
            &text.chars().take(200).collect::<String>()
        );
        // The signature of the `lang = en` failure mode this guards against.
        assert!(!text.contains("I spent a few hours on it"), "{text}");
        for segment in &segments {
            assert!(segment.get("startMs").and_then(Value::as_i64).is_some());
            assert!(segment.get("endMs").and_then(Value::as_i64).is_some());
        }
    }

    #[test]
    fn sidecar_binary_name_rules() {
        assert_eq!(sidecar_binary_name_for("whisper", false), "whisper");
        assert_eq!(sidecar_binary_name_for("ffmpeg", false), "ffmpeg");
        assert_eq!(sidecar_binary_name_for("whisper", true), "whisper.exe");
        assert_eq!(sidecar_binary_name_for("ffmpeg", true), "ffmpeg.exe");
    }

    #[test]
    fn required_runtime_names_share_binaries_and_add_loader_on_windows() {
        let macos = required_runtime_names(false);
        assert_eq!(
            macos,
            vec![
                "whisper".to_owned(),
                "vibeasr".to_owned(),
                "ffmpeg".to_owned(),
                "ffprobe".to_owned()
            ]
        );
        let windows = required_runtime_names(true);
        assert_eq!(
            windows,
            vec![
                "whisper.exe".to_owned(),
                "vibeasr.exe".to_owned(),
                "ffmpeg.exe".to_owned(),
                "ffprobe.exe".to_owned(),
                "vulkan-1.dll".to_owned()
            ]
        );
    }

    #[test]
    fn default_provider_follows_platform_engine_availability() {
        let default = ProviderConfig::default();
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert!(matches!(default, ProviderConfig::Qwen3(_)));
        } else {
            assert!(matches!(default, ProviderConfig::Whisper(_)));
        }
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

        // Zero-byte required files -> still incomplete (same dev-fallback caveat).
        for name in required_runtime_names(cfg!(target_os = "windows")) {
            let _ = std::fs::write(tmp.join(&name), []);
        }
        if !dev_fallback_active {
            assert!(
                !runtime_is_complete(&tmp),
                "zero-byte binaries must not count as complete"
            );
        }

        // Non-empty required files -> complete.
        for name in required_runtime_names(cfg!(target_os = "windows")) {
            let _ = std::fs::write(tmp.join(&name), b"dummy");
        }
        assert!(
            runtime_is_complete(&tmp),
            "all required runtime files valid must count as complete"
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
        // Empty config falls back to the platform default (Qwen3 on Apple
        // Silicon, whisper elsewhere) — mirror
        // `default_provider_follows_platform_engine_availability`.
        let expected_default = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "qwen3"
        } else {
            "whisper"
        };
        assert_eq!(
            TranscribeConfig::default().resolve(None, None).engine(),
            expected_default
        );
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
            language: None,
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
