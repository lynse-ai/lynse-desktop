use chrono::{DateTime, Utc};
#[cfg(target_os = "macos")]
use highlandcows_eventkit::{CalendarEvent, CalendarStore, EventKitError};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod live_translation;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[path = "live_translation_stub.rs"]
mod live_translation;
mod logging;
mod inspiration_voice;
mod meeting_detector;
mod feishu;
mod bots;
mod recording_card;
mod audio_editor;
mod stt;
// Microphone TCC prompt from the main app process (macOS); stubs elsewhere.
mod mic_permission;
// Wire codec for the Volcengine AST provider used by `live_translation`. Kept
// platform-independent so its golden-vector tests run everywhere, even where
// live translation itself falls back to the stub.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(dead_code)
)]
mod vault;
// Dual-track recording contract shared by the macOS capture sidecar and the
// Windows WASAPI engine: track manifest, timeline/framing, WAV writers and
// the echo-canceller ABI.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
mod audio_contract;
// Windows in-process capture engine for dual-track meeting recording
// (WASAPI loopback + microphone through the shared echo-canceller ABI).
#[cfg(target_os = "windows")]
mod windows_capture;
mod volc_ast;
// Wire protocol for the Tencent Cloud real-time ASR provider (URL signing +
// result frames), mirroring `volc_ast`. Platform-independent so its tests run
// everywhere.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(dead_code)
)]
mod tencent_asr;
mod webdav;
mod workbuddy;
mod storage;
mod content_migration;
mod window_effects;

use live_translation::LiveTranslationManager;

const VOICEPRINT_MATCH_THRESHOLD: f64 = 0.31;

struct AppState {
    model_download_in_progress: Mutex<bool>,
    /// Guards against two WebDAV syncs running at once (manual button + the
    /// launch/interval auto-sync can overlap).
    webdav_sync_in_progress: Mutex<bool>,
    /// Mirror of the recording state used to rebuild the tray menu when it
    /// changes (e.g. start, stop, pause). Mirrored here so the rebuild
    /// function and the update command can share a single source of truth.
    tray_ui: Mutex<TrayUiState>,
}

#[derive(Default, Clone, Copy)]
struct TrayUiState {
    recording: bool,
    paused: bool,
    elapsed_secs: u64,
}

pub(crate) type CommandResult<T> = Result<T, String>;

fn app_data_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub(crate) fn local_store_path(app: &AppHandle, directory: &str) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?.join(directory).join("index.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(path)
}

pub(crate) fn model_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?.join("local-asr-models").join("funasr");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

/// Directory holding a concrete engine/model's artifacts. FunASR kept a single
/// model bundle at the base (legacy); Qwen3/Whisper/VibeVoice/MLX use a
/// per-model subfolder.
pub(crate) fn engine_model_dir(app: &AppHandle, engine: &str, model_id: &str) -> CommandResult<PathBuf> {
    if engine == "funasr" {
        return model_dir(app);
    }
    let path = app_data_dir(app)?
        .join("local-asr-models")
        .join(engine)
        .join(model_id);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub(crate) fn read_array(path: &Path) -> CommandResult<Vec<Value>> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(serde_json::from_str(&content).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn write_array(path: &Path, values: &[Value]) -> CommandResult<()> {
    let temporary = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(values).map_err(|error| error.to_string())?;
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub(crate) fn list_store(app: &AppHandle, directory: &str) -> CommandResult<Vec<Value>> {
    let path = local_store_path(app, directory)?;
    let mut values = read_array(&path)?;
    values.sort_by(|left, right| {
        right
            .get("createdAt")
            .and_then(Value::as_str)
            .cmp(&left.get("createdAt").and_then(Value::as_str))
    });
    Ok(values)
}

pub(crate) fn get_store_value(app: &AppHandle, directory: &str, id: &str) -> CommandResult<Option<Value>> {
    Ok(list_store(app, directory)?.into_iter().find(|value| value.get("id").and_then(Value::as_str) == Some(id)))
}

fn save_store_value(app: &AppHandle, directory: &str, value: Value) -> CommandResult<Value> {
    let id = value.get("id").and_then(Value::as_str).ok_or("Record id is required")?.to_owned();
    let path = local_store_path(app, directory)?;
    let mut values = read_array(&path)?;
    if let Some(index) = values.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        values[index] = value.clone();
    } else {
        values.push(value.clone());
    }
    write_array(&path, &values)?;
    Ok(value)
}

pub(crate) fn remove_store_value(app: &AppHandle, directory: &str, id: &str) -> CommandResult<()> {
    let path = local_store_path(app, directory)?;
    let values = read_array(&path)?;
    let next: Vec<Value> = values
        .into_iter()
        .filter(|value| value.get("id").and_then(Value::as_str) != Some(id))
        .collect();
    write_array(&path, &next)
}

fn update_store_value(app: &AppHandle, directory: &str, id: &str, patch: Map<String, Value>) -> CommandResult<Option<Value>> {
    let path = local_store_path(app, directory)?;
    let mut values = read_array(&path)?;
    let Some(value) = values.iter_mut().find(|value| value.get("id").and_then(Value::as_str) == Some(id)) else {
        return Ok(None);
    };
    let object = value.as_object_mut().ok_or("Stored record must be an object")?;
    object.extend(patch);
    let updated = Value::Object(object.clone());
    write_array(&path, &values)?;
    Ok(Some(updated))
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn save_todo(app: &AppHandle, mut todo: Value) -> CommandResult<Value> {
    let object = todo.as_object_mut().ok_or("Todo must be an object")?;
    let title = object.get("title").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if title.is_empty() { return Err("Todo title is required".to_owned()) }
    if object.get("id").and_then(Value::as_str).map(str::trim).unwrap_or_default().is_empty() {
        object.insert("id".to_owned(), json!(format!("todo:{}", Uuid::new_v4())));
    }
    let timestamp = now();
    object.entry("createdAt".to_owned()).or_insert_with(|| json!(timestamp));
    object.insert("updatedAt".to_owned(), json!(timestamp));
    object.entry("completed".to_owned()).or_insert_with(|| json!(false));
    let saved = save_store_value(app, "local-todos", todo)?;
    // Mirror the todo into the Obsidian-style Tasks folder (markdown file).
    vault::sync_task(app, &saved);
    Ok(saved)
}

fn calendar_event_times(start_at: &str, end_at: &str) -> CommandResult<(DateTime<Utc>, DateTime<Utc>)> {
    let start = DateTime::parse_from_rfc3339(start_at)
        .map_err(|_| "Calendar start time must be an ISO-8601 timestamp")?
        .with_timezone(&Utc);
    let end = DateTime::parse_from_rfc3339(end_at)
        .map_err(|_| "Calendar end time must be an ISO-8601 timestamp")?
        .with_timezone(&Utc);
    if end <= start { return Err("Calendar end time must be later than start time".to_owned()) }
    Ok((start, end))
}

#[cfg(target_os = "macos")]
fn add_todo_to_system_calendar(
    app: &AppHandle,
    todo_id: &str,
    title: &str,
    source_title: Option<&str>,
    start_at: &str,
    end_at: &str,
) -> CommandResult<Value> {
    // Local todos are the source of truth for their own title/source; cloud
    // todos (absent from the local store) bring theirs through the args.
    let (event_title, source) = match get_store_value(app, "local-todos", todo_id)? {
        Some(todo) => {
            let stored_title = todo.get("title").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).ok_or("Todo title is required")?;
            let stored_source = todo.get("sourceTitle").and_then(Value::as_str).filter(|value| !value.trim().is_empty());
            (stored_title.to_owned(), stored_source.map(str::to_owned))
        }
        None => {
            let title = Some(title.trim()).filter(|value| !value.is_empty()).ok_or("Todo title is required")?;
            let source = source_title.map(str::trim).filter(|value| !value.is_empty());
            (title.to_owned(), source.map(str::to_owned))
        }
    };
    let (start, end) = calendar_event_times(start_at, end_at)?;
    let notes = source.map(|value| format!("来自 Lynse 待办\n来源：{value}"));

    let store = CalendarStore::builder()
        .connect()
        .map_err(|error| format!("无法连接系统日历：{error}"))?;
    // Full access, not write-only: on macOS 14+ defaultCalendarForNewEvents
    // only resolves under full access — under write-only it returns nil and
    // every save fails with "no default Calendar configured".
    log::info!("[calendar] EventKit authorization status: {:?}", CalendarStore::authorization_status());
    let access = store.authorize().map_err(|error| {
        log::error!("[calendar] EventKit authorization failed: {error}");
        match error {
            EventKitError::AuthorizationDenied => {
                "系统日历权限已被拒绝，请在 系统设置 → 隐私与安全性 → 日历 中允许 Lynse".to_owned()
            }
            EventKitError::AuthorizationRestricted => "日历访问被系统策略限制".to_owned(),
            other => format!("无法获取日历权限：{other}"),
        }
    })?;
    // defaultCalendarForNewEvents can still be nil under full access when no
    // default is configured in Calendar.app; fall back to the first writable
    // calendar instead of failing the save.
    let calendar_identifier = match store.default_calendar(&access) {
        Ok(Some(cal)) => Some(cal.calendar_identifier),
        Ok(None) => {
            let writable = store
                .lists(&access)
                .ok()
                .and_then(|cals| cals.into_iter().find(|cal| cal.allows_content_modifications));
            match writable {
                Some(cal) => {
                    log::info!("[calendar] no default calendar configured, falling back to: {}", cal.title);
                    Some(cal.calendar_identifier)
                }
                None => return Err("日历中没有任何可写入的日历，请先在 日历 App 中添加账户或日历".to_owned()),
            }
        }
        Err(error) => return Err(format!("无法读取系统日历列表：{error}")),
    };
    let event_id = store.save(&CalendarEvent {
        identifier: None,
        title: event_title,
        notes,
        calendar_identifier,
        start_date: Some(start),
        end_date: Some(end),
        is_all_day: false,
        location: None,
    }, &access).map_err(|error| format!("保存日历事件失败：{error}"))?;
    log::info!("[calendar] event saved: {event_id}");

    let mut patch = Map::new();
    patch.insert("calendarEventId".to_owned(), json!(event_id));
    patch.insert("calendarAddedAt".to_owned(), json!(now()));
    patch.insert("calendarStartAt".to_owned(), json!(start_at));
    patch.insert("calendarEndAt".to_owned(), json!(end_at));
    patch.insert("updatedAt".to_owned(), json!(now()));
    match update_store_value(app, "local-todos", todo_id, patch.clone())? {
        Some(updated) => {
            // Keep the markdown task mirror in sync with calendar metadata.
            vault::sync_task(app, &updated);
            Ok(updated)
        }
        // Cloud todos live server-side only — hand the calendar metadata back
        // so the frontend can persist it alongside the cloud record.
        None => {
            let mut record = Map::new();
            record.insert("id".to_owned(), json!(todo_id));
            record.extend(patch);
            Ok(Value::Object(record))
        }
    }
}

pub(crate) fn script_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/funasr_transcribe.py");
    if development.exists() {
        return Ok(development);
    }
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    Ok(resources.join("funasr_transcribe.py"))
}

fn python_command() -> String {
    if let Ok(value) = env::var("LYNSE_FUNASR_PYTHON") {
        return value;
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.venv-funasr/bin/python");
    if development.exists() {
        return development.to_string_lossy().into_owned();
    }
    "python3".to_owned()
}

pub(crate) fn run_funasr(_app: &AppHandle, arguments: &[String], model_directory: &Path) -> CommandResult<String> {
    let output = Command::new(python_command())
        .args(arguments)
        .env("MODELSCOPE_CACHE", model_directory)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return String::from_utf8(output.stdout).map_err(|error| error.to_string());
    }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if error.is_empty() {
        format!("FunASR exited with {}", output.status)
    } else {
        error
    })
}

/// Resource path to the MLX-Whisper bridge, mirroring [`script_path`].
pub(crate) fn mlx_script_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/mlx_transcribe.py");
    if development.exists() {
        return Ok(development);
    }
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    Ok(resources.join("mlx_transcribe.py"))
}

/// Resource path to the Qwen3-ASR bridge, mirroring [`mlx_script_path`].
pub(crate) fn qwen3_script_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/qwen3_transcribe.py");
    if development.exists() {
        return Ok(development);
    }
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    Ok(resources.join("qwen3_transcribe.py"))
}

/// Resource path to the MOSS-Transcribe-Diarize bridge, mirroring
/// [`qwen3_script_path`].
pub(crate) fn moss_script_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/moss_transcribe.py");
    if development.exists() {
        return Ok(development);
    }
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    Ok(resources.join("moss_transcribe.py"))
}

/// Resource path to the WhisperX bridge, mirroring [`moss_script_path`].
pub(crate) fn whisperx_script_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/whisperx_transcribe.py");
    if development.exists() {
        return Ok(development);
    }
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    Ok(resources.join("whisperx_transcribe.py"))
}

/// Ensure `mlx-qwen3-asr` (+ its vendored ffmpeg helper) is importable in the
/// MLX venv, pip-installing on first use. The shared venv is created by
/// [`ensure_mlx_venv`], which predates the Qwen3 engine — installs that already
/// have a venv therefore pick up the new package lazily, right here.
pub(crate) fn ensure_qwen3_asr_package(_app: &AppHandle, python: &str) -> CommandResult<()> {
    let python_path = PathBuf::from(python);
    let check = Command::new(python)
        .args(["-c", "import mlx_qwen3_asr"])
        .env("HF_HUB_OFFLINE", "1")
        .output()
        .map_err(|error| format!("无法运行 MLX Python：{error}"))?;
    if check.status.success() {
        return Ok(());
    }
    let pip = python_path
        .parent()
        .map(|directory| directory.join("pip"))
        .unwrap_or_else(|| PathBuf::from("pip"));
    log::info!("[stt] 首次使用 Qwen3 引擎，安装 mlx-qwen3-asr 依赖…");
    let install = Command::new(&pip)
        .args(["install", "--quiet", "--disable-pip-version-check", "mlx-qwen3-asr", "imageio-ffmpeg", "modelscope"])
        .status()
        .map_err(|error| format!("安装 mlx-qwen3-asr 失败：{error}"))?;
    if !install.success() {
        return Err("安装 mlx-qwen3-asr 失败（请检查网络，或手动安装到 MLX 虚拟环境）".to_owned());
    }
    Ok(())
}

/// Ensure the MOSS bridge's Python dependencies are importable in the shared
/// MLX venv (mlx-lm for the Qwen3 backbone, tokenizers + soundfile for the
/// port, imageio-ffmpeg for audio decode), pip-installing on first use. The
/// MOSS model weights download through the bridge itself, like Qwen3.
pub(crate) fn ensure_moss_packages(_app: &AppHandle, python: &str) -> CommandResult<()> {
    let check = Command::new(python)
        .args(["-c", "import mlx_lm, tokenizers, soundfile, imageio_ffmpeg"])
        .env("HF_HUB_OFFLINE", "1")
        .output()
        .map_err(|error| format!("无法运行 MLX Python：{error}"))?;
    if check.status.success() {
        return Ok(());
    }
    // Some venvs (e.g. the dev `.venv-mlx`) ship no `bin/pip` wrapper, so go
    // through the interpreter's pip module instead of a path that may not exist.
    log::info!("[stt] 首次使用 MOSS 引擎，安装 mlx-lm/tokenizers/soundfile 依赖…");
    let install = Command::new(python)
        .args(["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "mlx-lm", "tokenizers", "soundfile", "imageio-ffmpeg"])
        .status()
        .map_err(|error| format!("安装 MOSS 转写依赖失败：{error}"))?;
    if !install.success() {
        return Err("安装 MOSS 转写依赖失败（请检查网络，或手动安装到 MLX 虚拟环境）".to_owned());
    }
    Ok(())
}

/// Resolve the download region from the machine's public IP, detected once per
/// process and cached: mainland-China IPs download models from ModelScope
/// (huggingface.co is blocked or throttled there); everything else prefers
/// HuggingFace. Both geo endpoints are best-effort with short timeouts — on
/// total failure we return `global` and the python bridge still falls back to
/// the other source, so a misdetection costs speed, not the download.
pub(crate) fn detect_net_region() -> &'static str {
    static REGION: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    REGION.get_or_init(|| {
        for url in ["https://ipinfo.io/json", "http://ip-api.com/json/?fields=countryCode"] {
            let output = Command::new("curl")
                .args(["-fsSL", "--connect-timeout", "3", "-m", "5", url])
                .output();
            let body = match output {
                Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).into_owned(),
                _ => continue,
            };
            let parsed: Value = match serde_json::from_str(&body) {
                Ok(parsed) => parsed,
                Err(_) => continue,
            };
            let country = parsed
                .get("country")
                .and_then(Value::as_str)
                .or_else(|| parsed.get("countryCode").and_then(Value::as_str))
                .unwrap_or_default();
            if !country.is_empty() {
                return if country.eq_ignore_ascii_case("CN") { "cn" } else { "global" };
            }
        }
        "global"
    })
}

/// Ensure a usable MLX venv exists, creating one (and `pip install`-ing
/// `mlx-whisper` + `imageio-ffmpeg`) on first use. Returns the python path.
pub(crate) fn ensure_mlx_venv(app: &AppHandle) -> CommandResult<String> {
    if let Ok(value) = env::var("LYNSE_MLX_PYTHON") {
        return Ok(value);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.venv-mlx/bin/python");
    if development.exists() {
        return Ok(development.to_string_lossy().into_owned());
    }
    let venv = app_data_dir(app)?.join("mlx-venv");
    let python = venv.join("bin/python");
    if python.exists() {
        return Ok(python.to_string_lossy().into_owned());
    }

    log::info!("[stt] 创建 MLX 虚拟环境：{}", venv.display());
    fs::create_dir_all(&venv).map_err(|error| error.to_string())?;
    let status = Command::new("python3")
        .args(["-m", "venv", venv.to_string_lossy().as_ref()])
        .status()
        .map_err(|error| format!("无法创建 MLX 虚拟环境（python3 不可用）：{error}"))?;
    if !status.success() {
        return Err("创建 MLX 虚拟环境失败".to_owned());
    }
    let pip = venv.join("bin/pip");
    let install = Command::new(&pip)
        .args(["install", "--quiet", "--disable-pip-version-check", "mlx-whisper", "imageio-ffmpeg"])
        .status()
        .map_err(|error| format!("安装 mlx-whisper 失败：{error}"))?;
    if !install.success() {
        return Err("安装 mlx-whisper 失败（请检查网络，或手动安装到 .venv-mlx）".to_owned());
    }
    Ok(python.to_string_lossy().into_owned())
}

/// Ensure a usable WhisperX venv exists, creating one (and `pip install`-ing
/// `whisperx`, which pulls torch/ctranslate2/faster-whisper, plus
/// `imageio-ffmpeg`) on first use. Returns the python path. Kept separate from
/// the MLX venv: the CPU torch stack is large and unrelated to MLX wheels.
///
/// Interpreter selection matters: whisperx pins `ctranslate2` versions that
/// ship no wheels for the newest CPython (3.14 fails as of 2026-09), so we
/// prefer the newest interpreter that is *known-compatible* (3.12/3.11/3.13)
/// and only fall back to the system `python3`.
pub(crate) fn ensure_whisperx_venv(app: &AppHandle) -> CommandResult<String> {
    if let Ok(value) = env::var("LYNSE_WHISPERX_PYTHON") {
        return Ok(value);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.venv-whisperx/bin/python");
    if development.exists() {
        return Ok(development.to_string_lossy().into_owned());
    }
    let venv = app_data_dir(app)?.join("whisperx-venv");
    let python = venv.join("bin/python");
    if python.exists() {
        return Ok(python.to_string_lossy().into_owned());
    }

    let interpreter = ["python3.12", "python3.11", "python3.13", "python3"]
        .into_iter()
        .find(|candidate| Command::new(candidate).arg("--version").output().map(|output| output.status.success()).unwrap_or(false))
        .ok_or("未找到可用的 python3 解释器（whisperx 需要 3.10–3.13）")?;

    log::info!("[stt] 创建 WhisperX 虚拟环境（{interpreter}）：{}", venv.display());
    fs::create_dir_all(&venv).map_err(|error| error.to_string())?;
    let status = Command::new(interpreter)
        .args(["-m", "venv", venv.to_string_lossy().as_ref()])
        .status()
        .map_err(|error| format!("无法创建 WhisperX 虚拟环境：{error}"))?;
    if !status.success() {
        return Err("创建 WhisperX 虚拟环境失败".to_owned());
    }
    let pip = venv.join("bin/pip");
    let install = Command::new(&pip)
        .args(["install", "--quiet", "--disable-pip-version-check", "whisperx", "imageio-ffmpeg"])
        .status()
        .map_err(|error| format!("安装 whisperx 失败：{error}"))?;
    if !install.success() {
        return Err("安装 whisperx 失败（请检查网络，或手动安装到 .venv-whisperx）".to_owned());
    }
    Ok(python.to_string_lossy().into_owned())
}

/// Spawn a Python bridge with the model directory scoped as its HF/ModelScope
/// cache root; returns captured stdout.
pub(crate) fn run_python_with_model_cache(
    python: &str,
    arguments: &[String],
    model_directory: &Path,
) -> CommandResult<String> {
    let script = arguments
        .first()
        .map(Path::new)
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "python".to_owned());
    let output = match Command::new(python)
        .args(arguments)
        .env("MODELSCOPE_CACHE", model_directory)
        .env("HF_HOME", model_directory)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            log::error!("[stt] 无法启动 Python 桥 {script}（{python}）：{error}");
            return Err(error.to_string());
        }
    };
    if output.status.success() {
        return String::from_utf8(output.stdout).map_err(|error| error.to_string());
    }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    log::error!("[stt] Python 桥 {script} 异常退出（{}）：{}", output.status, log_tail(&error));
    Err(if error.is_empty() {
        format!("MLX 进程退出：{}", output.status)
    } else {
        error
    })
}

/// Last lines of a potentially huge stderr blob — Python tracebacks put the
/// actual exception at the end, so the tail carries the diagnosis.
fn log_tail(text: &str) -> String {
    let tail: Vec<&str> = text.lines().rev().take(20).collect();
    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// Run the MLX-Whisper bridge with an explicit Python interpreter. `MODELSCOPE_CACHE`
/// is harmless (MLX uses `HF_HOME`); both point the model cache at `model_directory`.
pub(crate) fn run_mlx(
    _app: &AppHandle,
    python: &str,
    arguments: &[String],
    model_directory: &Path,
) -> CommandResult<String> {
    run_python_with_model_cache(python, arguments, model_directory)
}

pub(crate) fn parse_funasr_json(stdout: &str) -> CommandResult<Value> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('{') || line.starts_with('['))
        .ok_or_else(|| "FunASR did not return JSON output".to_owned())
        .and_then(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn value_text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(clean_text).unwrap_or_default()
}

fn speaker_raw(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn normalize_funasr_output(raw: Value) -> Value {
    let root = raw.as_array().and_then(|items| items.first()).unwrap_or(&raw);
    let sentences = root.get("sentence_info").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut segments = Vec::new();
    for (index, sentence) in sentences.iter().enumerate() {
        let text = value_text(sentence.get("sentence")).or_else_if_empty(value_text(sentence.get("text")));
        if text.is_empty() {
            continue;
        }
        let raw_speaker = speaker_raw(sentence.get("spk").or_else(|| sentence.get("speaker")));
        let speaker_name = value_text(sentence.get("speakerName")).or_else_if_empty(value_text(sentence.get("speaker_name")));
        let speaker_name = if speaker_name.is_empty() {
            raw_speaker.as_deref().map(|speaker| match speaker.parse::<usize>() {
                Ok(number) => format!("发言人{}", number + 1),
                Err(_) => format!("发言人{speaker}"),
            })
        } else {
            Some(speaker_name)
        };
        let speaker_id = raw_speaker.as_deref().map(|speaker| match speaker.parse::<usize>() {
            Ok(number) => format!("spk-{}", number + 1),
            Err(_) => format!("spk-{speaker}"),
        });
        segments.push(json!({
            "id": format!("seg-{}", index + 1),
            "text": text,
            "startMs": sentence.get("start").cloned().unwrap_or(Value::Null),
            "endMs": sentence.get("end").cloned().unwrap_or(Value::Null),
            "speakerId": speaker_id,
            "speakerName": speaker_name,
            "rawSpeaker": raw_speaker,
            "confidence": sentence.get("confidence").or_else(|| sentence.get("score")).cloned().unwrap_or(Value::Null),
            "voiceprintId": sentence.get("voiceprint_id").cloned().unwrap_or(Value::Null)
        }));
    }
    let text = value_text(root.get("text"));
    let text = if text.is_empty() {
        segments.iter().filter_map(|segment| segment.get("text").and_then(Value::as_str)).collect::<String>()
    } else {
        text
    };
    json!({ "text": text, "segments": segments })
}

trait StringFallback {
    fn or_else_if_empty(self, fallback: String) -> String;
}

impl StringFallback for String {
    fn or_else_if_empty(self, fallback: String) -> String {
        if self.is_empty() { fallback } else { self }
    }
}

fn apply_hotwords(text: String, terms: &[Value]) -> String {
    terms.iter().fold(text, |result, term| {
        if term.get("enabled").and_then(Value::as_bool) == Some(false) {
            return result;
        }
        let from = value_text(term.get("term"));
        let to = value_text(term.get("replacement"));
        if from.is_empty() || to.is_empty() { result } else { result.replace(&from, &to) }
    })
}

fn active_hotword_terms(app: &AppHandle, package_id: Option<&str>) -> CommandResult<Vec<Value>> {
    let Some(package_id) = package_id else { return Ok(Vec::new()) };
    let Some(package) = get_store_value(app, "local-hotwords", package_id)? else { return Ok(Vec::new()) };
    if package.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(Vec::new());
    }
    Ok(package.get("terms").and_then(Value::as_array).cloned().unwrap_or_default())
}

// ── STT model catalog (multi-engine) ────────────────────

/// One downloadable artifact within a model. Most models ship a single file;
/// VibeVoice ships two GGUF weights (VAE encoder + LM decoder).
pub struct SttModelFile {
    pub file_name: &'static str,
    pub size_bytes: u64,
    /// Fixed-version download URL (mirrored to hf-mirror.com automatically).
    pub download_url: &'static str,
    /// Pinned SHA-256. Empty => verification skipped (fill before shipping).
    pub sha256: &'static str,
}

/// A pinned, downloadable model for one engine.
pub struct SttModelEntry {
    pub provider: &'static str,
    pub id: &'static str,
    pub label: &'static str,
    pub size_bytes: u64,
    /// Fixed-version download URL for single-artifact models. Empty for engines
    /// with a custom download (FunASR, MLX) or multi-file models (see `files`).
    pub download_url: &'static str,
    /// Pinned SHA-256 of the single artifact. Empty => verification skipped.
    pub sha256: &'static str,
    /// Extra model files (e.g. VibeVoice's two GGUF weights). Engines with a
    /// single artifact use `download_url`/`sha256` instead.
    pub files: &'static [SttModelFile],
}

/// VibeVoice-ASR-BitNet weights (Microsoft, MIT): a VAE encoder GGUF plus an
/// LM decoder GGUF, both required by the `vibeasr` sidecar.
pub const VIBEVOICE_BITNET_FILES: &[SttModelFile] = &[
    SttModelFile {
        file_name: "vibeasr-vae-encoder-i8_s.gguf",
        size_bytes: 0,
        download_url:
            "https://huggingface.co/microsoft/VibeVoice-ASR-BitNet/resolve/main/vibeasr-vae-encoder-i8_s.gguf",
        sha256: "",
    },
    SttModelFile {
        file_name: "vibeasr-lm-i2_s-embed-q6_k.gguf",
        size_bytes: 0,
        download_url:
            "https://huggingface.co/microsoft/VibeVoice-ASR-BitNet/resolve/main/vibeasr-lm-i2_s-embed-q6_k.gguf",
        sha256: "",
    },
];

pub const STT_MODELS: &[SttModelEntry] = &[
    SttModelEntry {
        provider: "qwen3",
        id: "qwen3-asr-1.7b-8bit",
        label: "Qwen3-ASR 1.7B（本地·Apple Silicon MLX 8-bit，推荐，~2 GiB）",
        // Approximate download totals (see run_python_model_download_with_progress).
        size_bytes: 2 * 1024 * 1024 * 1024,
        download_url: "",
        sha256: "",
        files: &[],
    },
    SttModelEntry {
        provider: "qwen3",
        id: "qwen3-asr-0.6b-4bit",
        label: "Qwen3-ASR 0.6B（本地·Apple Silicon MLX 4-bit，极速，~0.6 GiB）",
        size_bytes: 644_245_094,
        download_url: "",
        sha256: "",
        files: &[],
    },
    SttModelEntry {
        provider: "moss",
        id: "moss-transcribe-8bit",
        label: "MOSS-Transcribe-Diarize 0.9B（本地·说话人分离·时间戳，Apple Silicon MLX 8-bit，~1.1 GiB）",
        size_bytes: 1_181_116_006,
        download_url: "",
        sha256: "",
        files: &[],
    },
    SttModelEntry {
        provider: "whisper",
        id: "small-q5_1",
        label: "Whisper small (q5_1, ~190 MB)",
        size_bytes: 199_229_824,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
        sha256: "",
        files: &[],
    },
    SttModelEntry {
        provider: "whisper",
        id: "medium-q5_0",
        label: "Whisper medium (q5_0, ~539 MB)",
        size_bytes: 565_165_670,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin",
        sha256: "",
        files: &[],
    },
    SttModelEntry {
        provider: "whisper",
        id: "large-v3-turbo-q5_0",
        label: "Whisper large-v3-turbo (q5_0, ~574 MB)",
        size_bytes: 601_882_112,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
        sha256: "",
        files: &[],
    },
    SttModelEntry {
        provider: "vibeasr",
        id: "vibeasr-bitnet-1.5b",
        label: "VibeVoice-ASR-BitNet 1.5B（本地·CPU，中英法等 7 语种，~1.6 GiB）",
        size_bytes: 0,
        download_url: "",
        sha256: "",
        files: VIBEVOICE_BITNET_FILES,
    },
    SttModelEntry {
        provider: "mlx",
        id: "whisper-large-v3-turbo",
        label: "MLX-Whisper large-v3-turbo（本地·Apple Silicon，~1.5 GiB）",
        size_bytes: 1_610_612_736,
        download_url: "",
        sha256: "",
        files: &[],
    },
    SttModelEntry {
        provider: "whisperx",
        id: "whisperx-latest",
        label: "WhisperX large-v3（本地·CPU，转写 + 词级对齐，~3 GiB）",
        size_bytes: 3_221_225_472,
        download_url: "",
        sha256: "",
        files: &[],
    },
];

fn stt_model_entry(provider: &str, model_id: &str) -> CommandResult<&'static SttModelEntry> {
    STT_MODELS
        .iter()
        .find(|entry| entry.provider == provider && entry.id == model_id)
        .ok_or_else(|| format!("未知的 STT 模型：{provider}/{model_id}"))
}

/// Enumerate the on-disk files that make up a model: multi-file models (e.g.
/// VibeVoice's two GGUF weights) list each `files` entry, single-artifact
/// models use their `download_url`, and FunASR/MLX (custom Python download)
/// return nothing here.
fn model_download_targets(entry: &SttModelEntry) -> Vec<(String, String, String, u64)> {
    if !entry.files.is_empty() {
        entry
            .files
            .iter()
            .map(|file| {
                (
                    file.file_name.to_owned(),
                    file.download_url.to_owned(),
                    file.sha256.to_owned(),
                    file.size_bytes,
                )
            })
            .collect()
    } else if !entry.download_url.is_empty() {
        let file_name = stt::model_file_name(entry.provider, entry.id)
            .unwrap_or_else(|| entry.id.to_owned());
        vec![(
            file_name,
            entry.download_url.to_owned(),
            entry.sha256.to_owned(),
            entry.size_bytes,
        )]
    } else {
        Vec::new()
    }
}

fn model_is_installed(app: &AppHandle, provider: &str, model_id: &str) -> bool {
    let entry = match stt_model_entry(provider, model_id) {
        Ok(entry) => entry,
        Err(_) => return false,
    };
    let directory = match engine_model_dir(app, provider, model_id) {
        Ok(directory) => directory,
        Err(_) => return false,
    };
    let targets = model_download_targets(entry);
    if targets.is_empty() {
        // FunASR/MLX mark readiness with a directory file rather than an artifact.
        if !directory.join(".ready").exists() {
            return false;
        }
    } else {
        for (file_name, _, _, _) in &targets {
            if !directory.join(file_name).exists() {
                return false;
            }
        }
    }
    // Whisper/VibeVoice also require the shared on-demand runtime
    // (whisper, vibeasr, ffmpeg, ffprobe). FunASR, MLX and Qwen3 do not:
    // FunASR ships its own bundle and the MLX engines run through a
    // self-contained Python venv with a vendored ffmpeg (imageio-ffmpeg).
    if provider != "funasr" && provider != "mlx" && provider != "qwen3" && provider != "moss" {
        let version = format!("v{}", app.package_info().version);
        let runtime = stt::runtime_dir(app, &version);
        if !stt::runtime_is_complete(&runtime) {
            return false;
        }
    }
    true
}

fn model_status_list(app: &AppHandle) -> CommandResult<Value> {
    let models: Vec<Value> = STT_MODELS
        .iter()
        .map(|entry| {
            json!({
                "provider": entry.provider,
                "id": entry.id,
                "label": entry.label,
                "sizeBytes": if entry.files.is_empty() {
                    entry.size_bytes
                } else {
                    entry.files.iter().map(|file| file.size_bytes).sum()
                },
                "status": if model_is_installed(app, entry.provider, entry.id) { "installed" } else { "not_installed" },
                "modelDir": engine_model_dir(app, entry.provider, entry.id)
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            })
        })
        .collect();
    Ok(json!({ "models": models }))
}

/// Assign speaker labels to segments using CAM++ embeddings + greedy
/// clustering. Used by Whisper's optional speaker separation.
pub(crate) fn assign_campp_speakers(
    app: &AppHandle,
    audio_path: &str,
    segments: &mut [Value],
    funasr_dir: &Path,
    expected_speakers: Option<u64>,
) -> CommandResult<()> {
    if segments.is_empty() {
        return Ok(());
    }
    let candidates: Vec<Value> = segments
        .iter()
        .filter_map(|segment| {
            let id = segment.get("id")?.clone();
            let start = segment.get("startMs")?.clone();
            let end = segment.get("endMs")?.clone();
            if start.as_i64()? >= end.as_i64()? {
                None
            } else {
                Some(json!({ "id": id, "startMs": start, "endMs": end }))
            }
        })
        .collect();
    let embeddings = run_voiceprint_extraction(app, audio_path, &candidates, funasr_dir)?;
    let threshold = VOICEPRINT_MATCH_THRESHOLD;
    let mut clusters: Vec<Vec<f64>> = Vec::new();
    let mut assignment: HashMap<String, usize> = HashMap::new();
    for candidate in &candidates {
        let id = candidate.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let Some(embedding) = embeddings.get(&id) else { continue };
        let mut best: Option<(f64, usize)> = None;
        for (index, centroid) in clusters.iter().enumerate() {
            let score = cosine_similarity(embedding, centroid);
            if score > best.as_ref().map(|found| found.0).unwrap_or(0.0) {
                best = Some((score, index));
            }
        }
        let cluster_index = match best {
            Some((score, index)) if score >= threshold => index,
            _ => {
                clusters.push(embedding.clone());
                clusters.len() - 1
            }
        };
        assignment.insert(id, cluster_index);
    }
    if let Some(expected) = expected_speakers.filter(|value| *value > 0) {
        if clusters.len() as u64 > expected {
            for index in assignment.values_mut() {
                if *index >= expected as usize {
                    *index = 0;
                }
            }
        }
    }
    for segment in segments.iter_mut() {
        let id = segment.get("id").and_then(Value::as_str).map(str::to_owned);
        if let Some(id) = id.as_deref() {
            if let Some(object) = segment.as_object_mut() {
                let cluster_index = assignment.get(id).copied().unwrap_or(0);
                object.insert("speakerId".to_owned(), json!(format!("spk-{}", cluster_index + 1)));
                object.insert("speakerName".to_owned(), json!(format!("发言人{}", cluster_index + 1)));
                object.insert("rawSpeaker".to_owned(), json!(cluster_index));
            }
        }
    }
    Ok(())
}

fn sha256_of_file(path: &Path) -> CommandResult<String> {
    let output = if cfg!(target_os = "windows") {
        Command::new("certutil")
            .args(["-hashfile", path.to_string_lossy().as_ref(), "SHA256"])
            .output()
    } else {
        Command::new("shasum")
            .args(["-a", "256", path.to_string_lossy().as_ref()])
            .output()
    }
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法计算文件哈希".to_owned());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.split_whitespace().next().unwrap_or("").to_owned())
}

/// Produce the list of URLs to try, in order. Hugging Face (`huggingface.co`)
/// is blocked or extremely slow from mainland China, so when the primary URL
/// points there we also try the `hf-mirror.com` mirror which proxies the same
/// repositories and is reachable domestically. Direct access is always
/// attempted first so users outside China are unaffected.
fn model_download_candidates(primary: &str) -> Vec<String> {
    let mirror = primary
        .replacen("https://huggingface.co/", "https://hf-mirror.com/", 1)
        .replacen("http://huggingface.co/", "https://hf-mirror.com/", 1);
    if mirror != primary {
        vec![primary.to_owned(), mirror]
    } else {
        vec![primary.to_owned()]
    }
}

/// Best-effort resolve of a download's total byte size via an HTTP HEAD request
/// (following redirects). Returns the size, or 0 when it cannot be determined so
/// callers fall back to an indeterminate progress bar. Tries each candidate URL.
/// Used so unknown-size downloads (e.g. VibeVoice GGUF weights, the shared
/// runtime archive) still render a determinate percentage instead of a sweep.
///
/// Timeouts are deliberately short: this runs on the download path before any
/// progress can be shown, so a probe hanging for 30s reads as a frozen UI.
fn resolve_content_length(candidates: &[String]) -> u64 {
    for url in candidates {
        match Command::new("curl")
            .args(["-sIL", "--connect-timeout", "8", "--max-time", "10", url])
            .output()
        {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                // The final response (after redirects) carries the real file
                // size; take the last `content-length` header we can find.
                for line in text.lines().rev() {
                    let trimmed = line.trim();
                    if let Some(rest) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
                        if let Ok(n) = rest.trim().parse::<u64>() {
                            if n > 0 {
                                return n;
                            }
                        }
                    }
                }
            }
            Err(_) => continue,
        }
    }
    0
}

fn download_stt_model_file(app: &AppHandle, entry: &SttModelEntry) -> CommandResult<()> {
    let directory = engine_model_dir(app, entry.provider, entry.id)?;
    let targets = model_download_targets(entry);
    if targets.is_empty() {
        return Err(format!("模型 {} 没有可下载的文件", entry.id));
    }
    // Files that are already installed are skipped, so a resumed download
    // only accounts for what is actually left to fetch.
    let pending: Vec<(String, String, String, u64)> = targets
        .into_iter()
        .filter(|(file_name, _, _, _)| !directory.join(file_name).exists())
        .collect();
    if pending.is_empty() {
        return Ok(());
    }

    // Emit an immediate indeterminate signal so the UI reacts to the click
    // instead of sitting still while we probe each file's real size below.
    emit_download_progress(app, entry.provider, entry.id, 0, 0, None, "preparing", None);

    // Resolve every pending file's size up front. Models like VibeVoice ship
    // several GGUF weights whose catalog size is unknown; scoring progress
    // per-file would restart the bar at 0% each time the next file begins.
    // A resolved total yields a determinate bar; 0 keeps the sweep.
    let sizes: Vec<u64> = pending
        .iter()
        .map(|(_, url, _, size)| {
            if *size > 0 {
                *size
            } else {
                resolve_content_length(&model_download_candidates(url))
            }
        })
        .collect();
    let grand_total: u64 = sizes.iter().sum();
    let initial_percent = if grand_total > 0 { Some(0u32) } else { None };
    emit_download_progress(
        app,
        entry.provider,
        entry.id,
        0,
        grand_total,
        initial_percent,
        "downloading",
        None,
    );

    // Bytes already accounted for by files that finished downloading, so the
    // reported progress runs monotonically across the whole model.
    let mut done_bytes: u64 = 0;

    for ((file_name, url, sha256, _), &size) in pending.iter().zip(sizes.iter()) {
        let target = directory.join(file_name);
        let part = directory.join(format!("{file_name}.part"));
        let candidates = model_download_candidates(url);
        let mut last_error = "模型下载失败".to_owned();
        let mut downloaded = false;
        for candidate in &candidates {
            // Spawn curl (instead of blocking on `.status()`) so we can poll the
            // partial file's size while it downloads and stream progress to the UI.
            let mut child = Command::new("curl")
                .args([
                    "-fL",
                    "--retry",
                    "3",
                    "--connect-timeout",
                    "20",
                    "-o",
                    part.to_string_lossy().as_ref(),
                    candidate,
                ])
                .spawn()
                .map_err(|error| format!("无法启动下载（curl）：{error}"))?;
            loop {
                let received = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
                let overall = done_bytes + received;
                let percent = if grand_total > 0 {
                    Some(((overall as f64 / grand_total as f64) * 100.0).min(100.0) as u32)
                } else {
                    None
                };
                emit_download_progress(
                    app,
                    entry.provider,
                    entry.id,
                    overall,
                    grand_total,
                    percent,
                    "downloading",
                    None,
                );
                match child.try_wait().map_err(|error| error.to_string())? {
                    Some(status) => {
                        if status.success() {
                            // Brief "verifying" phase before the atomic move.
                            // Only the final file can report 100%.
                            let file_done = done_bytes + size;
                            let verify_percent = if grand_total > 0 {
                                Some(((file_done as f64 / grand_total as f64) * 100.0).min(100.0) as u32)
                            } else {
                                None
                            };
                            emit_download_progress(
                                app,
                                entry.provider,
                                entry.id,
                                file_done,
                                grand_total,
                                verify_percent,
                                "verifying",
                                None,
                            );
                            verify_and_install(&part, &target, sha256)?;
                            downloaded = true;
                            break;
                        }
                        // Failed attempt: drop the partial file and try the next
                        // candidate (or bail out).
                        let _ = fs::remove_file(&part);
                        if candidates.len() > 1 {
                            last_error = format!("通过 {candidate} 下载失败，正在尝试备用镜像");
                        }
                        break;
                    }
                    None => thread::sleep(Duration::from_millis(250)),
                }
            }
            if downloaded {
                break;
            }
        }
        if !downloaded {
            return Err(last_error);
        }
        // This file counts toward the model's overall progress.
        done_bytes += size;
    }
    Ok(())
}

/// Verify the downloaded `.part` file against the expected SHA-256 and
/// atomically move it into place. On a hash mismatch the partial file is
/// removed so no "installed" artifact — and therefore no `model_is_installed`
/// state — is left behind.
fn verify_and_install(part: &Path, target: &Path, expected_sha256: &str) -> CommandResult<()> {
    if !expected_sha256.is_empty() {
        let actual = sha256_of_file(part)?;
        if actual != expected_sha256 {
            let _ = fs::remove_file(part);
            return Err(format!(
                "模型校验失败：期望 {expected}，实际 {actual}",
                expected = expected_sha256,
                actual = actual
            ));
        }
    }
    fs::rename(part, target).map_err(|error| error.to_string())?;
    Ok(())
}

// ── On-demand shared STT runtime ─────────────────────────
//
// Whisper and VibeVoice rely on four binaries (whisper, vibeasr, ffmpeg,
// ffprobe) that are no longer bundled with the app. They are fetched once, on
// first offline-model install, and shared across every offline engine. The
// archive URL and its embedded SHA-256 are version-specific; the SHA is
// compiled into the client so a tampered/replaced archive fails verification.

/// GitHub repo that hosts the per-platform runtime archives. Keep in sync with
/// the release workflow that uploads them.
const RUNTIME_REPO: &str = "lynse-ai/lynse-desktop";

/// Tencent CloudBase static hosting mirror serving the same per-tag layout as
/// the GitHub release (`updates/<tag>/<archive>`). Compiled in from the
/// release workflow's env; absent in local dev builds, whose candidate list
/// then starts at GitHub direct.
const RUNTIME_MIRROR_BASE: Option<&'static str> = option_env!("LYNSE_UPDATES_MIRROR_BASE");

/// Per-platform runtime archive base name, e.g.
/// `lynse-stt-runtime-macos-aarch64.tar.gz`.
fn runtime_archive_name() -> String {
    format!("lynse-stt-runtime-{}.tar.gz", stt::runtime_platform_dir())
}

/// GitHub download URL for this app version's runtime archive — also the
/// source the CloudBase mirror copies from. Mirrors the git tag exactly (e.g.
/// `v0.1.15`).
fn runtime_github_url(version: &str) -> String {
    format!(
        "https://github.com/{RUNTIME_REPO}/releases/download/{version}/{}",
        runtime_archive_name()
    )
}

/// Mirror URL for this version's runtime archive; `None` when the build has
/// no mirror compiled in.
fn runtime_mirror_url(version: &str) -> Option<String> {
    match RUNTIME_MIRROR_BASE {
        Some(base) if !base.is_empty() => Some(format!("{base}/{version}/{}", runtime_archive_name())),
        _ => None,
    }
}

/// Same domestic-mirror strategy as model downloads: GitHub Releases is blocked
/// or throttled from mainland China, so try the CloudBase mirror first, then
/// the direct GitHub URL, then `ghproxy`-style mirrors. GitHub direct stays in
/// the list so non-China users and unmirrored old tags are unaffected.
fn runtime_download_candidates(version: &str) -> Vec<String> {
    let github = runtime_github_url(version);
    let mut list: Vec<String> = runtime_mirror_url(version).into_iter().collect();
    list.push(github.clone());
    for mirror in [
        github.replace("https://github.com/", "https://ghproxy.net/https://github.com/"),
        github.replace("https://github.com/", "https://mirror.ghproxy.com/https://github.com/"),
    ] {
        if mirror != github {
            list.push(mirror);
        }
    }
    list
}

/// Embedded SHA-256 for this platform's runtime archive, compiled in from the
/// release CI. `None` locally (no CI env) means verification cannot run and the
/// runtime MUST NOT be installed.
fn expected_runtime_sha() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        option_env!("LYNSE_RUNTIME_SHA_MACOS_AARCH64")
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        option_env!("LYNSE_RUNTIME_SHA_MACOS_X86_64")
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        option_env!("LYNSE_RUNTIME_SHA_WINDOWS_X86_64")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        option_env!("LYNSE_RUNTIME_SHA_LINUX_X86_64")
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    {
        None
    }
}

/// Ensure the shared runtime is present; download + verify + install it if
/// missing. A complete runtime is a no-op, so callers may invoke freely.
pub(crate) fn ensure_runtime_available(app: &AppHandle, provider: &str, model_id: &str) -> CommandResult<()> {
    let version = format!("v{}", app.package_info().version);
    let final_dir = stt::runtime_dir(app, &version);
    if stt::runtime_is_complete(&final_dir) {
        return Ok(());
    }
    download_runtime(app, provider, model_id, &version, &final_dir)
}

/// Download, verify and install the shared runtime. Errors never leave a
/// partial or promoted runtime behind. Progress is reported under the model
/// card the user clicked, so the runtime + model phases read as one flow.
fn download_runtime(app: &AppHandle, provider: &str, model_id: &str, version: &str, final_dir: &Path) -> CommandResult<()> {
    // In release builds the SHA is compiled in via CI and verification always
    // runs. In local dev builds it is absent, so we install the runtime
    // unverified (clearly warned) rather than refusing outright — this keeps the
    // download path exercisable during development.
    let expected_sha = expected_runtime_sha();
    if expected_sha.is_none() {
        log::warn!("离线转写组件未做 SHA-256 校验（本地开发构建），仅用于本地测试，请勿分发。");
    }

    let archive = runtime_archive_name();
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?.join("stt-runtimes");
    let downloads = base.join("downloads");
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let part = downloads.join(format!("{archive}.part"));

    let candidates = runtime_download_candidates(version);
    // Resolve the archive size so the runtime download shows a determinate
    // percentage bar; falls back to 0 → indeterminate sweep.
    let total = resolve_content_length(&candidates);
    let initial_percent = if total > 0 { Some(0u32) } else { None };
    emit_download_progress(app, provider, model_id, 0, total, initial_percent, "runtime_downloading", None);
    let mut last_error = "离线转写组件下载失败".to_owned();
    for url in &candidates {
        let mut child = Command::new("curl")
            .args(["-fL", "--retry", "3", "--connect-timeout", "20", "-o", part.to_string_lossy().as_ref(), url])
            .spawn()
            .map_err(|error| format!("无法启动下载（curl）：{error}"))?;
        loop {
            let received = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
            let percent = if total > 0 {
                Some(((received as f64 / total as f64) * 100.0).min(100.0) as u32)
            } else {
                None
            };
            emit_download_progress(app, provider, model_id, received, total, percent, "runtime_downloading", None);
            match child.try_wait().map_err(|error| error.to_string())? {
                Some(status) => {
                    if !status.success() {
                        let _ = fs::remove_file(&part);
                        last_error = format!("通过 {url} 下载失败，正在尝试备用镜像");
                        break;
                    }
                    emit_download_progress(app, provider, model_id, total, total, Some(100), "runtime_verifying", None);
                    if let Err(error) = install_runtime_archive(&part, final_dir, expected_sha) {
                        let _ = fs::remove_file(&part);
                        return Err(error);
                    }
                    let _ = fs::remove_file(&part);
                    emit_download_progress(app, provider, model_id, 0, 0, Some(100), "runtime_installing", None);
                    return Ok(());
                }
                None => thread::sleep(Duration::from_millis(250)),
            }
        }
    }
    Err(last_error)
}

/// Verify SHA-256 (when `expected_sha` is `Some`), extract, confirm the four
/// binaries, then atomically move the staging dir into the final runtime
/// location. A failed install leaves nothing behind and never overwrites a
/// working runtime. A `None` expected SHA (local dev build) skips verification.
fn install_runtime_archive(part: &Path, final_dir: &Path, expected_sha: Option<&str>) -> CommandResult<()> {
    if let Some(expected) = expected_sha {
        let actual = sha256_of_file(part)?;
        if actual != expected {
            return Err(format!("离线转写组件校验失败：期望 {expected}，实际 {actual}"));
        }
    }

    // Stage inside the same parent dir so the final move is a same-filesystem
    // rename (atomic on the same volume).
    let parent = final_dir.parent().ok_or("无法确定运行时父目录")?.to_path_buf();
    fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;

    let status = Command::new("tar")
        .args(["xzf", part.to_string_lossy().as_ref(), "-C", staging.to_string_lossy().as_ref()])
        .status()
        .map_err(|error| format!("无法解压离线转写组件：{error}"))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&staging);
        return Err("离线转写组件解压失败".to_owned());
    }

    if !stt::runtime_is_complete(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err("离线转写组件不完整（缺少必要程序）".to_owned());
    }

    // On macOS the downloaded binaries carry a quarantine xattr and would be
    // blocked by Gatekeeper; strip it and ad-hoc sign so they launch.
    #[cfg(target_os = "macos")]
    finalize_macos_runtime(&staging)?;

    if final_dir.exists() {
        fs::remove_dir_all(final_dir).map_err(|error| error.to_string())?;
    }
    fs::rename(&staging, final_dir).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn finalize_macos_runtime(dir: &Path) -> CommandResult<()> {
    use std::os::unix::fs::PermissionsExt;
    for base in stt::RUNTIME_BINARIES {
        let path = dir.join(base);
        if !path.exists() {
            continue;
        }
        let _ = fs::set_permissions(&path, PermissionsExt::from_mode(0o755));
        let _ = Command::new("xattr")
            .args(["-dr", "com.apple.quarantine", path.to_string_lossy().as_ref()])
            .status();
        let _ = Command::new("codesign")
            .args(["--force", "--sign", "-", path.to_string_lossy().as_ref()])
            .status();
    }
    Ok(())
}

/// Stream STT model download progress to the frontend. Emit failures (e.g. no
/// active listener) are intentionally swallowed so they never abort a download.
fn emit_download_progress(
    app: &AppHandle,
    provider: &str,
    model_id: &str,
    received_bytes: u64,
    total_bytes: u64,
    percent: Option<u32>,
    phase: &str,
    error: Option<&str>,
) {
    let _ = app.emit(
        "stt-download-progress",
        json!({
            "provider": provider,
            "modelId": model_id,
            "receivedBytes": received_bytes,
            "totalBytes": total_bytes,
            "percent": percent,
            "phase": phase,
            "error": error,
        }),
    );
}

/// Recursively sum file sizes under `path` (0 when it does not exist yet).
fn directory_size(path: &Path) -> u64 {
    fn walk(dir: &Path, total: &mut u64) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => walk(&entry.path(), total),
                Ok(_) => {
                    if let Ok(meta) = entry.metadata() {
                        *total += meta.len();
                    }
                }
                Err(_) => continue,
            }
        }
    }
    let mut total = 0;
    walk(path, &mut total);
    total
}

/// Run one Python-bridge model download while polling its target directory.
/// The Python bridges block on `.output()`, so the snapshot downloads
/// (HuggingFace / ModelScope) have no streamable progress — but both caches
/// land under `--model-dir` (`HF_HOME`/`MODELSCOPE_CACHE` point there), which
/// makes the directory's on-disk size an honest downloaded-bytes proxy. The
/// catalog total is an approximation, so the percent is capped at 99 until
/// the command's own `done`/`error` event settles the bar.
fn run_python_model_download_with_progress(
    app: &AppHandle,
    provider: &str,
    model_id: &str,
    directory: &Path,
    total_bytes: u64,
    run: impl FnOnce() -> CommandResult<String>,
) -> CommandResult<String> {
    let stop = Arc::new(AtomicBool::new(false));
    let poller = {
        let app = app.clone();
        let provider = provider.to_owned();
        let model_id = model_id.to_owned();
        let directory = directory.to_path_buf();
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let received = directory_size(&directory);
                let percent = if total_bytes > 0 {
                    Some(
                        ((received.min(total_bytes) as f64 / total_bytes as f64) * 100.0).min(99.0)
                            as u32,
                    )
                } else {
                    None
                };
                emit_download_progress(&app, &provider, &model_id, received, total_bytes, percent, "downloading", None);
                thread::sleep(Duration::from_millis(500));
            }
        })
    };
    let result = run();
    stop.store(true, Ordering::Relaxed);
    let _ = poller.join();
    result
}

fn resolve_provider(app: &AppHandle, language: Option<&str>, per_note: Option<&stt::ProviderConfig>) -> stt::ProviderConfig {
    let config = load_transcribe_config(app).unwrap_or_default();
    config.resolve(language, per_note)
}

fn ensure_model_installed(app: &AppHandle, provider: &str, model_id: &str) -> CommandResult<()> {
    if !model_is_installed(app, provider, model_id) {
        return Err(match provider {
            // FunASR is retired from the catalog; a stored funasr config can no
            // longer run, so point the user at its replacement.
            "funasr" => "FunASR 引擎已由 Qwen3-ASR 接替，请在设置中选择并下载新引擎".to_owned(),
            "qwen3" => "Qwen3-ASR 模型未安装，请先在设置中下载".to_owned(),
            _ => format!("STT 模型未安装：{provider}/{model_id}"),
        });
    }
    Ok(())
}

fn record_speaker_key(segment: &Value) -> Option<String> {
    ["rawSpeaker", "speakerId", "speakerName"]
        .iter()
        .find_map(|key| segment.get(*key).and_then(Value::as_str).map(ToOwned::to_owned))
}

fn voiceprint_candidates(segments: &[Value]) -> Vec<Value> {
    let mut candidates: HashMap<String, (i64, Value)> = HashMap::new();
    for segment in segments {
        let Some(key) = record_speaker_key(segment) else { continue };
        let Some(start) = segment.get("startMs").and_then(Value::as_i64) else { continue };
        let Some(end) = segment.get("endMs").and_then(Value::as_i64) else { continue };
        if end <= start { continue }
        let candidate = json!({ "id": segment.get("id").cloned().unwrap_or(Value::Null), "speakerKey": key, "startMs": start, "endMs": end });
        let duration = end - start;
        match candidates.get(&key) {
            Some((existing, _)) if *existing >= duration => (),
            _ => { candidates.insert(key, (duration, candidate)); }
        }
    }
    candidates.into_values().map(|(_, value)| value).collect()
}

fn embeddings_from_stdout(stdout: &str) -> CommandResult<HashMap<String, Vec<f64>>> {
    let parsed = parse_funasr_json(stdout)?;
    let mut result = HashMap::new();
    for item in parsed.get("embeddings").and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = item.get("id").and_then(Value::as_str) else { continue };
        let embedding = item.get("embedding").and_then(Value::as_array).map(|values| {
            values.iter().filter_map(Value::as_f64).collect::<Vec<_>>()
        }).unwrap_or_default();
        if !embedding.is_empty() { result.insert(id.to_owned(), embedding); }
    }
    Ok(result)
}

fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    let length = left.len().min(right.len());
    if length == 0 { return 0.0 }
    let (mut dot, mut left_norm, mut right_norm) = (0.0, 0.0, 0.0);
    for index in 0..length {
        dot += left[index] * right[index];
        left_norm += left[index] * left[index];
        right_norm += right[index] * right[index];
    }
    if left_norm == 0.0 || right_norm == 0.0 { 0.0 } else { dot / (left_norm.sqrt() * right_norm.sqrt()) }
}

fn average_embeddings(embeddings: &[Vec<f64>]) -> Vec<f64> {
    let valid: Vec<&Vec<f64>> = embeddings.iter().filter(|embedding| !embedding.is_empty()).collect();
    let Some(length) = valid.iter().map(|embedding| embedding.len()).min() else { return Vec::new() };
    let mut averaged = vec![0.0; length];
    for embedding in &valid {
        for (index, value) in embedding.iter().take(length).enumerate() { averaged[index] += value; }
    }
    for value in &mut averaged { *value /= valid.len() as f64; }
    let norm = averaged.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm > 0.0 { for value in &mut averaged { *value /= norm; } }
    averaged
}

pub(crate) fn run_voiceprint_extraction(app: &AppHandle, audio_path: &str, candidates: &[Value], directory: &Path) -> CommandResult<HashMap<String, Vec<f64>>> {
    if candidates.is_empty() { return Ok(HashMap::new()) }
    let segments: Vec<Value> = candidates.iter().map(|candidate| json!({
        "id": candidate.get("id").cloned().unwrap_or(Value::Null),
        "startMs": candidate.get("startMs").cloned().unwrap_or(Value::Null),
        "endMs": candidate.get("endMs").cloned().unwrap_or(Value::Null)
    })).collect();
    let args = vec![
        script_path(app)?.to_string_lossy().into_owned(), audio_path.to_owned(),
        "--model-dir".to_owned(), directory.to_string_lossy().into_owned(),
        "--extract-voiceprint".to_owned(), "--segments-json".to_owned(),
        serde_json::to_string(&segments).map_err(|error| error.to_string())?
    ];
    embeddings_from_stdout(&run_funasr(app, &args, directory)?)
}

fn apply_voiceprints(app: &AppHandle, audio_path: &str, segments: &mut [Value], directory: &Path) -> CommandResult<()> {
    // Voiceprint matching relies on the FunASR/CAM++ model. If it isn't
    // installed, skip silently rather than failing a Whisper/VibeVoice job.
    if !directory.join(".ready").exists() {
        return Ok(());
    }
    let voiceprints = list_store(app, "local-voiceprints")?;
    if voiceprints.is_empty() || segments.is_empty() { return Ok(()) }
    let candidates = voiceprint_candidates(segments);
    let embeddings = run_voiceprint_extraction(app, audio_path, &candidates, directory)?;
    let mut matches = HashMap::new();
    for candidate in candidates {
        let Some(id) = candidate.get("id").and_then(Value::as_str) else { continue };
        let Some(key) = candidate.get("speakerKey").and_then(Value::as_str) else { continue };
        let Some(embedding) = embeddings.get(id) else { continue };
        let best = voiceprints.iter().filter_map(|voiceprint| {
            let reference = voiceprint.get("embedding").and_then(Value::as_array)?
                .iter().filter_map(Value::as_f64).collect::<Vec<_>>();
            let score = cosine_similarity(embedding, &reference);
            Some((score, voiceprint))
        }).max_by(|left, right| left.0.total_cmp(&right.0));
        if let Some((score, voiceprint)) = best.filter(|(score, _)| *score >= VOICEPRINT_MATCH_THRESHOLD) {
            let _ = score;
            matches.insert(key.to_owned(), voiceprint.clone());
        }
    }
    for segment in segments {
        let Some(key) = record_speaker_key(segment) else { continue };
        let Some(voiceprint) = matches.get(&key) else { continue };
        if let Some(object) = segment.as_object_mut() {
            object.insert("speakerName".to_owned(), voiceprint.get("name").cloned().unwrap_or(Value::Null));
            object.insert("voiceprintId".to_owned(), voiceprint.get("id").cloned().unwrap_or(Value::Null));
        }
    }
    Ok(())
}

/// Apply per-task overrides from the request options onto the resolved
/// provider before it is frozen into the record, so the choices made in the
/// upload dialog (expected speakers, hotword package) actually take effect:
/// - `expectedSpeakers` > 0 overrides the config; absent/0 keeps the config.
/// - `hotwordPackageId`: absent keeps the config, `null` means explicit
///   "none" for this task, a string selects that package.
fn apply_per_task_overrides(provider: &mut stt::ProviderConfig, options: Option<&Value>) {
    let Some(options) = options else { return };
    let expected = options
        .get("expectedSpeakers")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0);
    if let Some(expected) = expected {
        provider.set_expected_speakers(Some(expected));
    }
    if let Some(package) = options.get("hotwordPackageId") {
        if package.is_null() {
            provider.set_hotword_package_id(None);
        } else if let Some(package_id) = package.as_str() {
            provider.set_hotword_package_id(Some(package_id.to_owned()));
        }
    }
}

fn create_queued_record(app: &AppHandle, audio_path: &str, options: Option<&Value>) -> CommandResult<Value> {
    let created_at = now();
    let language = options.and_then(|value| value.get("language")).and_then(Value::as_str);
    let per_note = options
        .and_then(|value| value.get("providerConfig"))
        .filter(|value| !value.is_null())
        .and_then(|value| serde_json::from_value::<stt::ProviderConfig>(value.clone()).ok());
    let mut provider = resolve_provider(app, language, per_note.as_ref());
    apply_per_task_overrides(&mut provider, options);
    let model_id = match &provider {
        stt::ProviderConfig::Funasr(_) => "funasr-paraformer",
        stt::ProviderConfig::Whisper(config) => config.model.as_model_id(),
        stt::ProviderConfig::VibeVoice(_) => "vibeasr-bitnet-1.5b",
        stt::ProviderConfig::Mlx(_) => "whisper-large-v3-turbo",
        stt::ProviderConfig::Qwen3(config) => config.model.as_deref().unwrap_or(stt::QWEN3_DEFAULT_MODEL_ID),
        stt::ProviderConfig::Moss(config) => config.model.as_deref().unwrap_or(stt::MOSS_DEFAULT_MODEL_ID),
        stt::ProviderConfig::WhisperX(_) => stt::WHISPERX_DEFAULT_MODEL_ID,
    };
    Ok(json!({
        "id": format!("local:{}", Uuid::new_v4()),
        "title": Path::new(audio_path).file_name().and_then(|value| value.to_str()).unwrap_or(audio_path),
        "sourcePath": audio_path,
        "createdAt": created_at,
        "updatedAt": created_at,
        "transcriptText": "",
        "status": "queued",
        "progressPhase": "queued",
        "expectedSpeakers": options.and_then(|value| value.get("expectedSpeakers")).cloned().unwrap_or(Value::Null),
        "hotwordPackageId": options.and_then(|value| value.get("hotwordPackageId")).cloned().unwrap_or(Value::Null),
        "language": options.and_then(|value| value.get("language")).cloned().unwrap_or(Value::Null),
        "providerConfig": serde_json::to_value(&provider).map_err(|error| error.to_string())?,
        "priorContext": options.and_then(|value| value.get("priorContext")).cloned().unwrap_or(Value::Null),
        "engine": provider.engine(),
        "modelId": model_id,
        "segments": []
    }))
}

fn fail_interrupted_records(app: &AppHandle) -> CommandResult<()> {
    let path = local_store_path(app, "local-transcriptions")?;
    let mut records = read_array(&path)?;
    let timestamp = now();
    let mut changed = false;
    for record in &mut records {
        let status = record.get("status").and_then(Value::as_str);
        if !matches!(status, Some("queued" | "transcribing")) {
            continue;
        }
        let object = record.as_object_mut().ok_or("Stored record must be an object")?;
        object.insert("status".to_owned(), json!("failed"));
        object.insert("progressPhase".to_owned(), json!("failed"));
        object.insert("error".to_owned(), json!("转写被中断，请重试"));
        object.insert("updatedAt".to_owned(), json!(timestamp));
        object.insert("completedAt".to_owned(), json!(timestamp));
        log::warn!(
            "[stt] 启动时标记中断的转写记录：{}（{}）",
            object.get("id").and_then(Value::as_str).unwrap_or("?"),
            object.get("title").and_then(Value::as_str).unwrap_or("?")
        );
        changed = true;
    }
    if changed {
        write_array(&path, &records)?;
    }
    Ok(())
}

/// Best-effort audio duration probe via the bundled ffprobe. Returns `None`
/// when the shared runtime isn't installed or the duration can't be parsed, so
/// callers simply skip the field instead of storing a wrong value.
fn probe_audio_duration_ms(app: &AppHandle, path: &str) -> Option<i64> {
    let ffprobe = stt::sidecar_path(app, "ffprobe").ok()?;
    let output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let seconds: f64 = String::from_utf8_lossy(&output.stdout).trim().parse().ok()?;
    let duration_ms = (seconds * 1000.0).round() as i64;
    (duration_ms > 0).then_some(duration_ms)
}

/// A finished dual-channel recording's per-track offline-transcription
/// inputs, resolved from the track manifest against the session directory.
/// Records without a usable manifest fall back to single-file transcription.
fn dual_track_files(record: &Value) -> Option<Vec<(&'static str, PathBuf)>> {
    let manifest = record.get("trackManifest").filter(|value| value.is_object())?;
    let tracks = manifest.get("tracks")?.as_array()?;
    let source_dir = PathBuf::from(record.get("sourcePath").and_then(Value::as_str)?)
        .parent()?
        .to_path_buf();
    let pick = |id: &str| -> Option<PathBuf> {
        tracks
            .iter()
            .find(|track| track.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|track| track.get("file").and_then(Value::as_str))
            .map(|file| source_dir.join(file))
            .filter(|path| path.exists())
    };
    let mic = pick("mic_processed")?;
    let system = pick("system_processed")?;
    Some(vec![("mic", mic), ("system", system)])
}

/// Speaker attribution for offline per-track results: `mic → local` and
/// `system → remote` is fixed by the capture layout; voiceprints and model
/// diarization never override it.
fn track_speaker(source: &str) -> (&'static str, &'static str) {
    if source == "mic" {
        ("local", "本机")
    } else {
        ("remote", "远端")
    }
}

/// Transcribes both tracks of a dual-channel recording serially (one local
/// model at a time) and merges the results on the shared timeline. A failed
/// track keeps the other track's transcript and reports per-track status so
/// the UI can offer a targeted retry.
fn transcribe_dual_tracks(
    app: &AppHandle,
    record: &Value,
    tracks: &[(&'static str, PathBuf)],
) -> CommandResult<(String, Vec<Value>, Option<i64>, Value)> {
    let mut merged: Vec<Value> = Vec::new();
    let mut statuses = Map::new();
    let mut duration_ms: Option<i64> = None;
    let mut last_error: Option<String> = None;
    let mut any_completed = false;
    for (source, path) in tracks {
        let path_text = path.to_string_lossy().into_owned();
        match transcribe_single_track(app, record, &path_text) {
            Ok((_, mut segments, probe)) => {
                any_completed = true;
                let (speaker_id, speaker_name) = track_speaker(source);
                for segment in &mut segments {
                    if let Some(object) = segment.as_object_mut() {
                        object.insert("source".to_owned(), json!(source));
                        object.insert("speakerId".to_owned(), json!(speaker_id));
                        object.insert("speakerName".to_owned(), json!(speaker_name));
                    }
                }
                merged.append(&mut segments);
                if probe.is_some() {
                    duration_ms = probe;
                }
                statuses.insert(source.to_string(), json!({ "status": "completed" }));
            }
            Err(error) => {
                last_error = Some(error.clone());
                statuses.insert(source.to_string(), json!({ "status": "failed", "error": error }));
            }
        }
    }
    if !any_completed {
        return Err(last_error.unwrap_or_else(|| "转录失败".to_owned()));
    }
    // Shared-timeline merge; mic sorts before system at equal starts so a
    // simultaneous reply keeps a stable reading order.
    merged.sort_by_key(|segment| {
        (
            segment.get("startMs").and_then(Value::as_i64).unwrap_or(0),
            segment.get("source").and_then(Value::as_str) != Some("mic"),
        )
    });
    let transcript = merged
        .iter()
        .filter_map(|segment| {
            let text = segment.get("text").and_then(Value::as_str)?.trim();
            if text.is_empty() {
                return None;
            }
            let name = segment.get("speakerName").and_then(Value::as_str).unwrap_or("");
            Some(format!("{}：{}", name, text))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok((transcript, merged, duration_ms, Value::Object(statuses)))
}

/// Transcribes one audio file with the record's frozen engine config.
/// Returns (transcript text, segments, duration probe).
fn transcribe_single_track(
    app: &AppHandle,
    record: &Value,
    audio_path: &str,
) -> CommandResult<(String, Vec<Value>, Option<i64>)> {
    // Use the frozen per-record provider config (set at creation time) so a
    // later change to the default routing never affects an in-flight task.
    let provider: stt::ProviderConfig = record
        .get("providerConfig")
        .filter(|value| !value.is_null())
        .and_then(|value| serde_json::from_value::<stt::ProviderConfig>(value.clone()).ok())
        .ok_or("本地转写缺少引擎配置")?;
    let model_id = record.get("modelId").and_then(Value::as_str).unwrap_or_else(|| match &provider {
        stt::ProviderConfig::Funasr(_) => "funasr-paraformer",
        stt::ProviderConfig::Whisper(config) => config.model.as_model_id(),
        stt::ProviderConfig::VibeVoice(_) => "vibeasr-bitnet-1.5b",
        stt::ProviderConfig::Mlx(_) => "whisper-large-v3-turbo",
        stt::ProviderConfig::Qwen3(config) => config.model.as_deref().unwrap_or(stt::QWEN3_DEFAULT_MODEL_ID),
        stt::ProviderConfig::Moss(config) => config.model.as_deref().unwrap_or(stt::MOSS_DEFAULT_MODEL_ID),
        stt::ProviderConfig::WhisperX(_) => stt::WHISPERX_DEFAULT_MODEL_ID,
    });
    ensure_model_installed(app, provider.engine(), model_id)?;
    let directory = engine_model_dir(app, provider.engine(), model_id)?;
    let funasr_dir = model_dir(app)?;
    let expected_speakers = provider.expected_speakers();
    let hotword_package_id = provider.hotword_package_id().map(str::to_owned);
    let terms = active_hotword_terms(app, hotword_package_id.as_deref())?;
    let hotword = terms.iter().filter(|term| term.get("enabled").and_then(Value::as_bool) != Some(false))
        .filter_map(|term| term.get("term").and_then(Value::as_str)).collect::<Vec<_>>().join(" ");
    let prior_context = record.get("priorContext").and_then(Value::as_str).map(str::to_owned);
    let request = stt::SttRequest {
        audio_path: audio_path.to_owned(),
        model_directory: directory.clone(),
        provider: provider.clone(),
        expected_speakers,
        hotword,
        prior_context,
    };
    let output = provider.adapter().transcribe(app, &request)?;
    let normalized = json!({ "text": output.text, "segments": output.segments });
    let transcript = apply_hotwords(value_text(normalized.get("text")), &terms);
    let mut segments = normalized.get("segments").and_then(Value::as_array).cloned().unwrap_or_default();
    for segment in &mut segments {
        if let Some(object) = segment.as_object_mut() {
            let text = value_text(object.get("text"));
            object.insert("text".to_owned(), json!(apply_hotwords(text, &terms)));
        }
    }
    apply_voiceprints(app, audio_path, &mut segments, &funasr_dir)?;
    Ok((transcript, segments, probe_audio_duration_ms(app, audio_path)))
}

fn transcribe_record(app: &AppHandle, record: Value) -> CommandResult<Value> {
    let id = record.get("id").and_then(Value::as_str).ok_or("Record id is required")?.to_owned();
    let started_at = now();
    let mut started = Map::new();
    started.insert("status".to_owned(), json!("transcribing"));
    started.insert("progressPhase".to_owned(), json!("transcribing"));
    started.insert("startedAt".to_owned(), json!(started_at));
    started.insert("updatedAt".to_owned(), json!(started_at));
    started.insert("error".to_owned(), Value::Null);
    update_store_value(app, "local-transcriptions", &id, started)?;
    let engine = record.get("engine").and_then(Value::as_str).unwrap_or("unknown");
    let model_id = record.get("modelId").and_then(Value::as_str).unwrap_or("unknown");
    let title = record.get("title").and_then(Value::as_str).unwrap_or("unknown");
    log::info!("[stt] 转写开始：{title}（engine={engine} model={model_id} id={id}）");

    let result: CommandResult<(String, Vec<Value>, Option<i64>, Option<Value>)> =
        match dual_track_files(&record) {
            Some(tracks) => transcribe_dual_tracks(app, &record, &tracks)
                .map(|(transcript, segments, duration, statuses)| {
                    (transcript, segments, duration, Some(statuses))
                }),
            None => {
                let audio_path = record
                    .get("sourcePath")
                    .and_then(Value::as_str)
                    .ok_or("Source path is required")?;
                transcribe_single_track(app, &record, audio_path)
                    .map(|(transcript, segments, duration)| (transcript, segments, duration, None))
            }
        };

    match result {
        Ok((transcript, segments, audio_duration_ms, track_statuses)) => {
            let completed_at = now();
            let duration = chrono::DateTime::parse_from_rfc3339(&completed_at).ok()
                .zip(chrono::DateTime::parse_from_rfc3339(&started_at).ok())
                .map(|(end, start)| (end - start).num_milliseconds()).unwrap_or_default();
            log::info!("[stt] 转写完成：{title}（耗时 {duration}ms，{} 段，id={id}）", segments.len());
            let mut patch = Map::new();
            patch.insert("transcriptText".to_owned(), json!(transcript));
            patch.insert("segments".to_owned(), json!(segments));
            patch.insert("status".to_owned(), json!("completed"));
            patch.insert("progressPhase".to_owned(), json!("completed"));
            patch.insert("completedAt".to_owned(), json!(completed_at));
            patch.insert("updatedAt".to_owned(), json!(completed_at));
            // `durationMs` is the recording's real length (surfaced as the file
            // duration in the UI); the wall-clock time transcription took is
            // stored separately as `elapsedMs`.
            if let Some(audio_duration_ms) = audio_duration_ms {
                patch.insert("durationMs".to_owned(), json!(audio_duration_ms));
            }
            if let Some(statuses) = track_statuses {
                patch.insert("trackStatuses".to_owned(), statuses);
            }
            patch.insert("elapsedMs".to_owned(), json!(duration));
            patch.insert("error".to_owned(), Value::Null);
            update_store_value(app, "local-transcriptions", &id, patch)?.ok_or("Local transcription record disappeared".to_owned())
        }
        Err(error) => {
            log::error!("[stt] 转写失败：{title}（engine={engine}，{error}）");
            let failed_at = now();
            let mut patch = Map::new();
            patch.insert("status".to_owned(), json!("failed"));
            patch.insert("progressPhase".to_owned(), json!("failed"));
            patch.insert("error".to_owned(), json!(error.clone()));
            patch.insert("updatedAt".to_owned(), json!(failed_at));
            patch.insert("completedAt".to_owned(), json!(failed_at));
            let _ = update_store_value(app, "local-transcriptions", &id, patch);
            Err(error)
        }
    }
}

#[tauri::command]
fn local_transcription_list(app: AppHandle) -> CommandResult<Vec<Value>> { list_store(&app, "local-transcriptions") }

#[tauri::command]
fn todo_list(app: AppHandle) -> CommandResult<Vec<Value>> { list_store(&app, "local-todos") }

#[tauri::command]
fn todo_save(app: AppHandle, todo: Value) -> CommandResult<Value> { save_todo(&app, todo) }

#[tauri::command]
fn todo_delete(app: AppHandle, id: String) -> CommandResult<()> {
    remove_store_value(&app, "local-todos", &id)?;
    vault::remove_task(&app, &id);
    Ok(())
}

/// Persist an inspiration (create or edit).
///
/// Durable per-inspiration directory: `<content>/Inspirations/<uuid>/` — the
/// vault folder's `Inspirations/` subfolder once the vault is enabled, else
/// the legacy `<app_data>/inspirations/<uuid>/`. Records store relative file
/// names only, so relocating the root needs no index rewrite.
fn inspiration_dir(app: &AppHandle, uuid: &str) -> CommandResult<PathBuf> {
    Ok(vault::content_dir(app, vault::ContentKind::Inspirations)?.join(uuid))
}

/// Create: fresh attachments arrive as `pendingAudioPath` / `pendingImages`
/// pointing at staging (or picked) files; they are adopted into the
/// inspiration's durable directory (`inspirations/<uuid>/`) before the record
/// is stored.
///
/// Edit (`id` already exists): the renderer sends its full intent — `text`,
/// `tags`, `images` (the keep-list of existing files) and `pendingImages` —
/// and every field it does NOT send (createdAt, audio, transcript…) is merged
/// from the stored record. Image files dropped from the keep-list are deleted
/// from disk; `audio.wav` is never touched here.
fn save_inspiration(app: &AppHandle, inspiration: Value) -> CommandResult<Value> {
    let object = inspiration.as_object().ok_or("Inspiration must be an object")?;
    let text = object.get("text").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    let pending_path = object.get("pendingAudioPath").and_then(Value::as_str).map(str::to_owned).filter(|value| !value.is_empty());
    let pending_images = object.get("pendingImages").and_then(Value::as_array).cloned().unwrap_or_default();
    // An explicit `images` array expresses the keep-list for edits; an absent
    // field means "not an image edit", so nothing on disk is touched.
    let images_field_present = object.get("images").map(Value::is_array).unwrap_or(false);
    let keep_images: Vec<String> = if images_field_present {
        object.get("images").and_then(Value::as_array).map(|images| {
            images.iter().filter_map(|image| image.get("file").and_then(Value::as_str).map(str::to_owned)).collect()
        }).unwrap_or_default()
    } else {
        Vec::new()
    };

    let requested_id = object.get("id").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned();
    let existing = if requested_id.is_empty() {
        None
    } else {
        get_store_value(app, "local-inspirations", &requested_id)?
    };
    let has_attachments = pending_path.is_some() || !pending_images.is_empty() || !keep_images.is_empty();
    if text.is_empty() && !has_attachments && existing.is_none() {
        return Err("Inspiration text, image or audio is required".to_owned());
    }
    let id = if requested_id.is_empty() {
        format!("inspiration:{}", Uuid::new_v4())
    } else {
        requested_id
    };
    let uuid = id.strip_prefix("inspiration:").unwrap_or(&id).to_owned();
    let timestamp = now();

    // Merge onto the stored record for edits so unsent fields survive.
    let mut record = match existing {
        Some(mut existing) => {
            let merged = existing.as_object_mut().ok_or("Stored record must be an object")?;
            merged.insert("text".to_owned(), json!(text));
            merged.insert("updatedAt".to_owned(), json!(timestamp));
            if let Some(tags) = object.get("tags") {
                merged.insert("tags".to_owned(), tags.clone());
            }
            existing
        }
        None => json!({
            "id": id,
            "text": text,
            "tags": object.get("tags").cloned().unwrap_or_else(|| json!([])),
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "transcriptStatus": "none",
        }),
    };
    let record_object = record.as_object_mut().ok_or("Record must be an object")?;

    if pending_path.is_some() || !pending_images.is_empty() {
        fs::create_dir_all(inspiration_dir(app, &uuid)?).map_err(|error| error.to_string())?;
    }

    // AUDIO: adopt a freshly captured memo (creation flow only — edits keep
    // the existing WAV untouched).
    if let Some(pending) = pending_path {
        if record_object.get("audio").and_then(Value::as_object).is_none() {
            let directory = inspiration_dir(app, &uuid)?;
            let destination = directory.join("audio.wav");
            if !destination.exists() {
                // Staging lives under app data while the destination may be
                // the vault folder, so the rename can hit a volume boundary;
                // copy is the fallback.
                if fs::rename(&pending, &destination).is_err() {
                    fs::copy(&pending, &destination).map_err(|error| error.to_string())?;
                    let _ = fs::remove_file(&pending);
                }
                // Best-effort cleanup of the now-empty capture directory.
                if let Some(parent) = Path::new(&pending).parent() {
                    if parent.file_name().and_then(|value| value.to_str()).unwrap_or_default().starts_with("capture-") {
                        let _ = fs::remove_dir_all(parent);
                    }
                }
            }
            let duration = object.get("pendingAudioDurationMs").and_then(Value::as_i64).unwrap_or(0);
            record_object.insert("audio".to_owned(), json!({ "file": "audio.wav", "durationMs": duration }));
        }
    }

    // IMAGES: final list = keep-list + newly adopted staged/picked files,
    // then prune files that fell out of the keep-list.
    if images_field_present || !pending_images.is_empty() {
        let directory = inspiration_dir(app, &uuid)?;
        if !pending_images.is_empty() {
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        }
        let previous_images = record_object.get("images").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut final_images: Vec<Value> = Vec::new();
        for file in &keep_images {
            // Carry over the stored metadata (width/height) of kept images.
            let previous = previous_images.iter().find(|image| {
                image.get("file").and_then(Value::as_str) == Some(file.as_str())
            });
            final_images.push(previous.cloned().unwrap_or_else(|| json!({ "file": file })));
        }
        let staging_root = app_data_dir(app)?.join("inspirations").join("staging");
        for image in &pending_images {
            let Some(source) = image.get("sourcePath").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
                continue;
            };
            let source_path = Path::new(source);
            let extension = source_path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .filter(|value| is_safe_asset_file_name(value))
                .unwrap_or_else(|| "img".to_owned());
            let file_name = format!("img-{}.{}", final_images.len() + 1, extension);
            let destination = directory.join(&file_name);
            if !destination.exists() {
                // Staged pastes are ours to move; picked files stay put.
                if source_path.starts_with(&staging_root) {
                    fs::rename(source_path, &destination).map_err(|error| error.to_string())?;
                } else {
                    fs::copy(source_path, &destination).map_err(|error| error.to_string())?;
                }
            }
            let mut entry = Map::new();
            entry.insert("file".to_owned(), json!(file_name));
            for key in ["width", "height"] {
                if let Some(value) = image.get(key).and_then(Value::as_i64) {
                    entry.insert(key.to_owned(), json!(value));
                }
            }
            final_images.push(Value::Object(entry));
        }
        // Prune unreferenced image files (removed during an edit).
        if images_field_present {
            if let Ok(entries) = fs::read_dir(&directory) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let referenced = final_images.iter().any(|image| {
                        image.get("file").and_then(Value::as_str) == Some(name.as_str())
                    });
                    if name.starts_with("img-") && !referenced {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
        record_object.insert("images".to_owned(), json!(final_images));
    }
    let saved = save_store_value(app, "local-inspirations", record)?;
    // Mirror the memo into the Obsidian-style Journal folder (markdown file
    // + copied attachments).
    vault::sync_journal(app, &saved);
    Ok(saved)
}

/// Transcribe an inspiration memo with the current default STT routing. Unlike
/// `transcribe_record` this never touches `local-transcriptions`: the result is
/// patched straight into the inspiration record. A missing model keeps the
/// audio and marks the record `unavailable` so the UI can offer a retry after
/// the model is installed.
fn transcribe_inspiration(app: &AppHandle, mut record: Value, audio_path: PathBuf) -> CommandResult<Value> {
    let id = record.get("id").and_then(Value::as_str).ok_or("Record id is required")?.to_owned();
    let patch_status = |status: &str, error: Option<&str>| -> CommandResult<Value> {
        let mut patch = Map::new();
        patch.insert("transcriptStatus".to_owned(), json!(status));
        patch.insert("transcriptError".to_owned(), json!(error));
        patch.insert("updatedAt".to_owned(), json!(now()));
        let updated = update_store_value(app, "local-inspirations", &id, patch)?
            .ok_or_else(|| "Inspiration disappeared while transcribing".to_owned());
        if let Ok(record) = updated.as_ref() {
            // The transcript (or its failure state) lands in the journal mirror.
            vault::sync_journal(app, record);
        }
        updated
    };
    let provider = resolve_provider(app, None, None);
    let model_id = match &provider {
        stt::ProviderConfig::Funasr(_) => "funasr-paraformer",
        stt::ProviderConfig::Whisper(config) => config.model.as_model_id(),
        stt::ProviderConfig::VibeVoice(_) => "vibeasr-bitnet-1.5b",
        stt::ProviderConfig::Mlx(_) => "whisper-large-v3-turbo",
        stt::ProviderConfig::Qwen3(config) => config.model.as_deref().unwrap_or(stt::QWEN3_DEFAULT_MODEL_ID),
        stt::ProviderConfig::Moss(config) => config.model.as_deref().unwrap_or(stt::MOSS_DEFAULT_MODEL_ID),
        stt::ProviderConfig::WhisperX(_) => stt::WHISPERX_DEFAULT_MODEL_ID,
    };
    if !model_is_installed(app, provider.engine(), model_id) {
        return patch_status("unavailable", Some("本地 ASR 模型未安装，请先在设置中下载语音识别模型"));
    }
    let result = (|| -> CommandResult<String> {
        let directory = engine_model_dir(app, provider.engine(), model_id)?;
        let hotword_package_id = provider.hotword_package_id().map(str::to_owned);
        let terms = active_hotword_terms(app, hotword_package_id.as_deref())?;
        let hotword = terms.iter().filter(|term| term.get("enabled").and_then(Value::as_bool) != Some(false))
            .filter_map(|term| term.get("term").and_then(Value::as_str)).collect::<Vec<_>>().join(" ");
        let request = stt::SttRequest {
            audio_path: audio_path.to_string_lossy().into_owned(),
            model_directory: directory,
            provider: provider.clone(),
            expected_speakers: provider.expected_speakers(),
            hotword,
            prior_context: None,
        };
        let output = provider.adapter().transcribe(app, &request)?;
        Ok(apply_hotwords(output.text, &terms))
    })();
    match result {
        Ok(transcript) => {
            if let Some(object) = record.as_object_mut() {
                object.insert("transcript".to_owned(), json!(transcript));
            }
            patch_status("completed", None)
        }
        Err(error) => {
            let _ = patch_status("failed", Some(&error));
            Err(error)
        }
    }
}

#[tauri::command]
fn inspiration_list(app: AppHandle) -> CommandResult<Vec<Value>> { list_store(&app, "local-inspirations") }

/// Async: adopting attachments copies multi-megabyte images on disk, which
/// must not run on the main thread (sync commands are main-thread bound).
#[tauri::command(async)]
fn inspiration_save(app: AppHandle, inspiration: Value) -> CommandResult<Value> { save_inspiration(&app, inspiration) }

/// Async: deleting removes the whole attachment directory from disk.
#[tauri::command(async)]
fn inspiration_delete(app: AppHandle, id: String) -> CommandResult<()> {
    remove_store_value(&app, "local-inspirations", &id)?;
    vault::remove_journal(&app, &id);
    let uuid = id.strip_prefix("inspiration:").unwrap_or(&id);
    let directory = inspiration_dir(&app, uuid)?;
    if directory.exists() {
        fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn inspiration_transcribe(app: AppHandle, id: String) -> CommandResult<Value> {
    let record = get_store_value(&app, "local-inspirations", &id)?.ok_or("Inspiration not found")?;
    let audio_file = record.get("audio")
        .and_then(|audio| audio.get("file"))
        .and_then(Value::as_str)
        .ok_or("Inspiration has no audio")?
        .to_owned();
    let uuid = id.strip_prefix("inspiration:").unwrap_or(&id);
    let audio_path = inspiration_dir(&app, uuid)?.join(audio_file);
    if !audio_path.exists() {
        return Err("灵感音频文件不存在".to_owned());
    }
    let mut record = record;
    let object = record.as_object_mut().ok_or("Stored record must be an object")?;
    object.insert("transcriptStatus".to_owned(), json!("pending"));
    object.insert("updatedAt".to_owned(), json!(now()));
    let record = save_store_value(&app, "local-inspirations", record)?;
    vault::sync_journal(&app, &record);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || transcribe_inspiration(&handle, record, audio_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn inspiration_audio_url(app: AppHandle, id: String) -> CommandResult<Option<String>> {
    Ok(get_store_value(&app, "local-inspirations", &id)?.map(|_| {
        format!("local-media://localhost/{}", utf8_percent_encode(&id, NON_ALPHANUMERIC))
    }))
}

/// Guard for asset file names served through `local-media`: anything outside
/// this set is rejected so the handler can never be talked into traversal.
fn is_safe_asset_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Best-effort image format sniffing from the leading magic bytes; falls back
/// to a generic extension (browsers sniff `<img>` content anyway).
fn sniff_image_extension(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        "heic"
    } else {
        "img"
    }
}

fn inspiration_staging_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let directory = app_data_dir(app)?.join("inspirations").join("staging");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn staged_image_response(path: &Path, file_name: &str) -> Value {
    json!({
        "path": path.to_string_lossy(),
        "url": format!(
            "local-media://localhost/{}",
            utf8_percent_encode(&format!("staging:{file_name}"), NON_ALPHANUMERIC)
        ),
    })
}

fn write_staged_image(app: &AppHandle, bytes: Vec<u8>, prefix: &str, extension: &str) -> CommandResult<Value> {
    if bytes.is_empty() {
        return Err("Image payload is empty".to_owned());
    }
    let file_name = format!("{prefix}-{}.{extension}", Uuid::new_v4());
    let path = inspiration_staging_dir(app)?.join(&file_name);
    fs::write(&path, &bytes).map_err(|error| error.to_string())?;
    Ok(staged_image_response(&path, &file_name))
}

/// Stage one pasted/captured image (raw bytes over the Tauri IPC) into
/// `inspirations/staging/` and return its path plus a preview URL. The bytes
/// are adopted into the inspiration's durable directory on save; the staging
/// folder is wiped on the next launch, so nothing here is durable.
///
/// Kept sync on purpose (the borrowed `Request` cannot cross an async
/// command) and therefore main-thread bound. macOS never uses this path —
/// pushing multi-megabyte image bytes through the webview IPC froze the whole
/// app; the capture sheet reads the pasteboard via
/// [`inspiration_stage_image_from_clipboard`] instead. This is the fallback
/// for platforms without that command.
#[tauri::command]
fn inspiration_stage_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> CommandResult<Value> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("Image payload must be raw bytes".to_owned()),
    };
    let extension = sniff_image_extension(&bytes);
    write_staged_image(&app, bytes, "paste", extension)
}

/// Same staging step for images picked from disk: copies the picked file into
/// staging so previews and adoption flow through one uniform pipeline. Runs on
/// the async thread pool — a multi-megabyte photo read+copied on the main
/// thread froze the whole app (sync commands are main-thread bound).
#[tauri::command(async)]
fn inspiration_stage_image_from_path(app: AppHandle, path: String) -> CommandResult<Value> {
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err("Image file is empty".to_owned());
    }
    let extension = Path::new(&path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| is_safe_asset_file_name(value))
        .unwrap_or_else(|| sniff_image_extension(&bytes).to_owned());
    write_staged_image(&app, bytes, "pick", &extension)
}

/// Pull the clipboard image (PNG preferred, TIFF transcoded to PNG) from the
/// system pasteboard. Must run on the main thread (AppKit). Returns the bytes
/// plus their extension.
#[cfg(target_os = "macos")]
fn read_clipboard_image_bytes() -> CommandResult<(Vec<u8>, &'static str)> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard};
    use objc2_foundation::NSDictionary;

    unsafe {
        let pasteboard = NSPasteboard::generalPasteboard();
        // Screenshots land as PNG; Continuity Camera photos land as TIFF.
        if let Some(data) = pasteboard.dataForType(objc2_app_kit::NSPasteboardTypePNG) {
            return Ok((data.to_vec(), "png"));
        }
        let Some(tiff) = pasteboard.dataForType(objc2_app_kit::NSPasteboardTypeTIFF) else {
            return Err("剪贴板中没有图片".to_owned());
        };
        let Some(rep) = NSBitmapImageRep::imageRepWithData(&tiff) else {
            return Err("剪贴板图片无法解析".to_owned());
        };
        let Some(png) = rep.representationUsingType_properties(
            NSBitmapImageFileType::PNG,
            &NSDictionary::dictionary(),
        ) else {
            return Err("剪贴板图片转码失败".to_owned());
        };
        Ok((png.to_vec(), "png"))
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn inspiration_stage_image_from_clipboard(app: AppHandle) -> CommandResult<Value> {
    // Pasteboard access is AppKit — hop to the main thread, then do the disk
    // write on the blocking pool.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(read_clipboard_image_bytes());
    })
    .map_err(|error| error.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, extension) = rx.recv().map_err(|_| "读取剪贴板失败".to_owned())??;
        write_staged_image(&handle, bytes, "paste", extension)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn inspiration_stage_image_from_clipboard(_app: AppHandle) -> CommandResult<Value> {
    Err("剪贴板图片暂仅支持 macOS".to_owned())
}

/// Serve URL for one saved inspiration image (or the memo WAV when file is
/// omitted — see [`inspiration_audio_url`]).
#[tauri::command]
fn inspiration_image_url(app: AppHandle, id: String, file: String) -> CommandResult<Option<String>> {
    Ok(get_store_value(&app, "local-inspirations", &id)?.map(|_| {
        format!(
            "local-media://localhost/{}",
            utf8_percent_encode(&format!("{id}/{file}"), NON_ALPHANUMERIC)
        )
    }))
}

/// Ask the responder chain to run the macOS Continuity Camera flow
/// (`insertFromIPhoneOrIPad:`): the system opens the paired iPhone's camera
/// and the photo lands in the focused webview element as a paste, which the
/// capture sheet's paste handler attaches. Errors when no responder supports
/// it so the UI can point at paste/file alternatives.
#[cfg(target_os = "macos")]
#[tauri::command]
fn inspiration_capture_from_iphone() -> CommandResult<()> {
    use objc2::runtime::{AnyObject, Bool};
    use std::ptr;

    unsafe {
        let app: *mut AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
        if app.is_null() {
            return Err("NSApplication unavailable".to_owned());
        }
        let action = objc2::sel!(insertFromIPhoneOrIPad:);
        let handled: Bool =
            objc2::msg_send![app, sendAction:action, to:ptr::null_mut::<AnyObject>(), from:ptr::null_mut::<AnyObject>()];
        if handled.as_bool() {
            Ok(())
        } else {
            Err("当前窗口暂不支持 iPhone 相机，请使用截图粘贴或本地图片导入".to_owned())
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn inspiration_capture_from_iphone() -> CommandResult<()> {
    Err("iPhone 相机仅支持 macOS".to_owned())
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn todo_add_to_calendar(
    app: AppHandle,
    todo_id: String,
    title: String,
    source_title: Option<String>,
    start_at: String,
    end_at: String,
    confirmed: bool,
) -> CommandResult<Value> {
    if !confirmed { return Err("Calendar events can only be created after explicit confirmation".to_owned()) }
    tauri::async_runtime::spawn_blocking(move || {
        add_todo_to_system_calendar(&app, &todo_id, &title, source_title.as_deref(), &start_at, &end_at)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn todo_add_to_calendar(
    _app: AppHandle,
    _todo_id: String,
    _title: String,
    _source_title: Option<String>,
    _start_at: String,
    _end_at: String,
    _confirmed: bool,
) -> CommandResult<Value> {
    Err("System calendar integration is only available on macOS".to_owned())
}

#[tauri::command]
fn local_transcription_get(app: AppHandle, id: String) -> CommandResult<Option<Value>> { get_store_value(&app, "local-transcriptions", &id) }

#[tauri::command]
fn local_transcription_delete(app: AppHandle, id: String) -> CommandResult<()> { remove_store_value(&app, "local-transcriptions", &id) }

#[tauri::command]
fn local_transcription_audio_url(app: AppHandle, id: String) -> CommandResult<Option<String>> {
    // `?v=<updatedAt>` busts the webview's cache after an in-place edit
    // overwrites the record's audio; the media handler only reads the path.
    Ok(get_store_value(&app, "local-transcriptions", &id)?.map(|record| {
        let version = record.get("updatedAt").and_then(Value::as_str).unwrap_or_default();
        format!(
            "local-media://localhost/{}?v={}",
            utf8_percent_encode(&id, NON_ALPHANUMERIC),
            utf8_percent_encode(version, NON_ALPHANUMERIC)
        )
    }))
}

/// Audio URL for one track of a dual-channel recording (`file` must be
/// listed in the record's track manifest — see `media_response_body`).
#[tauri::command]
fn local_transcription_track_audio_url(
    app: AppHandle,
    id: String,
    file: String,
) -> CommandResult<Option<String>> {
    let record = get_store_value(&app, "local-transcriptions", &id)?;
    let Some(record) = record else { return Ok(None) };
    let allowed = record
        .get("trackManifest")
        .and_then(|manifest| manifest.get("tracks"))
        .and_then(Value::as_array)
        .map(|tracks| {
            tracks
                .iter()
                .any(|track| track.get("file").and_then(Value::as_str) == Some(file.as_str()))
        })
        .unwrap_or(false);
    if !allowed {
        return Err("Unknown recording track".to_owned());
    }
    let version = record.get("updatedAt").and_then(Value::as_str).unwrap_or_default();
    Ok(Some(format!(
        "local-media://localhost/{}/{}?v={}",
        utf8_percent_encode(&id, NON_ALPHANUMERIC),
        utf8_percent_encode(&file, NON_ALPHANUMERIC),
        utf8_percent_encode(version, NON_ALPHANUMERIC),
    )))
}

#[tauri::command]
fn local_stt_model_status(app: AppHandle) -> CommandResult<Value> {
    model_status_list(&app)
}

/// Runs on the async thread pool (`command(async)`): a model download blocks
/// for minutes, which would freeze the whole app if it ran on the main thread.
#[tauri::command(async)]
fn local_stt_download_model(
    app: AppHandle,
    state: tauri::State<AppState>,
    provider: String,
    model_id: String,
) -> CommandResult<Value> {
    {
        let mut downloading = state.model_download_in_progress.lock().map_err(|_| "Model download lock is poisoned")?;
        if *downloading { return model_status_list(&app); }
        *downloading = true;
    }
    let result = (|| {
        let entry = stt_model_entry(&provider, &model_id)?;
        let total_bytes = entry.size_bytes;
        if provider == "funasr" || provider == "mlx" || provider == "qwen3" || provider == "moss" || provider == "whisperx" {
            // FunASR, MLX and Qwen3 download through their Python helpers rather
            // than a fixed URL. The indeterminate event makes the UI react at
            // once; run_python_model_download_with_progress then streams real
            // byte progress once the snapshot download starts writing files.
            emit_download_progress(&app, &provider, &model_id, 0, 0, None, "downloading", None);
            if provider == "mlx" {
                let directory = engine_model_dir(&app, &provider, &model_id)?;
                fs::create_dir_all(&directory).ok();
                let python = ensure_mlx_venv(&app)?;
                let args = vec![
                    mlx_script_path(&app)?.to_string_lossy().into_owned(),
                    "--download-models".to_owned(),
                    "--model-dir".to_owned(),
                    directory.to_string_lossy().into_owned(),
                ];
                if let Err(error) = run_python_model_download_with_progress(
                    &app,
                    &provider,
                    &model_id,
                    &directory,
                    total_bytes,
                    || run_mlx(&app, &python, &args, &directory),
                ) {
                    emit_download_progress(&app, &provider, &model_id, 0, 0, None, "error", Some(error.as_str()));
                    return Err(error);
                }
            } else if provider == "qwen3" {
                let directory = engine_model_dir(&app, &provider, &model_id)?;
                fs::create_dir_all(&directory).ok();
                let python = ensure_mlx_venv(&app)?;
                ensure_qwen3_asr_package(&app, &python)?;
                let args = vec![
                    qwen3_script_path(&app)?.to_string_lossy().into_owned(),
                    "--download-models".to_owned(),
                    "--model-dir".to_owned(),
                    directory.to_string_lossy().into_owned(),
                    "--model".to_owned(),
                    stt::qwen3_hf_repo(&model_id).to_owned(),
                    "--region".to_owned(),
                    detect_net_region().to_owned(),
                ];
                if let Err(error) = run_python_model_download_with_progress(
                    &app,
                    &provider,
                    &model_id,
                    &directory,
                    total_bytes,
                    || run_mlx(&app, &python, &args, &directory),
                ) {
                    emit_download_progress(&app, &provider, &model_id, 0, 0, None, "error", Some(error.as_str()));
                    return Err(error);
                }
            } else if provider == "whisperx" {
                let directory = engine_model_dir(&app, &provider, &model_id)?;
                fs::create_dir_all(&directory).ok();
                let python = ensure_whisperx_venv(&app)?;
                let args = vec![
                    whisperx_script_path(&app)?.to_string_lossy().into_owned(),
                    "--download-models".to_owned(),
                    "--model-dir".to_owned(),
                    directory.to_string_lossy().into_owned(),
                    "--model".to_owned(),
                    stt::whisperx_hf_repo(&model_id).to_owned(),
                    "--region".to_owned(),
                    detect_net_region().to_owned(),
                ];
                if let Err(error) = run_python_model_download_with_progress(
                    &app,
                    &provider,
                    &model_id,
                    &directory,
                    total_bytes,
                    || run_mlx(&app, &python, &args, &directory),
                ) {
                    emit_download_progress(&app, &provider, &model_id, 0, 0, None, "error", Some(error.as_str()));
                    return Err(error);
                }
            } else if provider == "moss" {
                let directory = engine_model_dir(&app, &provider, &model_id)?;
                fs::create_dir_all(&directory).ok();
                let python = ensure_mlx_venv(&app)?;
                ensure_moss_packages(&app, &python)?;
                let args = vec![
                    moss_script_path(&app)?.to_string_lossy().into_owned(),
                    "--download-models".to_owned(),
                    "--model-dir".to_owned(),
                    directory.to_string_lossy().into_owned(),
                    "--model".to_owned(),
                    stt::moss_hf_repo(&model_id).to_owned(),
                    "--region".to_owned(),
                    detect_net_region().to_owned(),
                ];
                if let Err(error) = run_python_model_download_with_progress(
                    &app,
                    &provider,
                    &model_id,
                    &directory,
                    total_bytes,
                    || run_mlx(&app, &python, &args, &directory),
                ) {
                    emit_download_progress(&app, &provider, &model_id, 0, 0, None, "error", Some(error.as_str()));
                    return Err(error);
                }
            } else {
                let directory = model_dir(&app)?;
                let args = vec![
                    script_path(&app)?.to_string_lossy().into_owned(),
                    "--download-models".to_owned(),
                    "--model-dir".to_owned(),
                    directory.to_string_lossy().into_owned(),
                ];
                if let Err(error) = run_python_model_download_with_progress(
                    &app,
                    &provider,
                    &model_id,
                    &directory,
                    total_bytes,
                    || run_funasr(&app, &args, &directory),
                ) {
                    emit_download_progress(&app, &provider, &model_id, 0, 0, None, "error", Some(error.as_str()));
                    return Err(error);
                }
            }
            emit_download_progress(&app, &provider, &model_id, 0, 0, None, "done", None);
        } else {
            // Whisper/VibeVoice require the shared on-demand runtime
            // (whisper, vibeasr, ffmpeg, ffprobe). Download it first if
            // missing; a previously-downloaded model skips the model download
            // but still ensures the runtime is present.
            if let Err(error) = ensure_runtime_available(&app, &provider, &model_id) {
                emit_download_progress(&app, &provider, &model_id, 0, 0, None, "error", Some(error.as_str()));
                return Err(error);
            }
            if let Err(error) = download_stt_model_file(&app, entry) {
                emit_download_progress(&app, &provider, &model_id, 0, 0, None, "error", Some(error.as_str()));
                return Err(error);
            }
            emit_download_progress(&app, &provider, &model_id, 0, 0, None, "done", None);
        }
        model_status_list(&app)
    })();
    if let Ok(mut downloading) = state.model_download_in_progress.lock() { *downloading = false; }
    result
}

/// `command(async)`: directory deletion and status re-listing run off the main
/// thread, so a large model dir can't freeze the UI.
#[tauri::command(async)]
fn local_stt_delete_model(
    app: AppHandle,
    state: tauri::State<AppState>,
    provider: String,
    model_id: String,
) -> CommandResult<Value> {
    if *state.model_download_in_progress.lock().map_err(|_| "Model download lock is poisoned")? {
        return Err("Cannot delete while a model is downloading".to_owned());
    }
    let directory = engine_model_dir(&app, &provider, &model_id)?;
    remove_model_dir(&directory)?;
    if provider == "funasr" {
        let base = model_dir(&app)?;
        remove_model_dir(&base)?;
    }
    model_status_list(&app)
}

/// Remove a single model directory. A model deletion only ever touches its own
/// directory, so other installed models remain completely unaffected.
fn remove_model_dir(directory: &Path) -> CommandResult<()> {
    if directory.exists() {
        fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn local_transcription_transcribe(app: AppHandle, audio_path: String, options: Option<Value>) -> CommandResult<Value> {
    let record = create_queued_record(&app, &audio_path, options.as_ref())?;
    save_store_value(&app, "local-transcriptions", record.clone())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || transcribe_record(&handle, record))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn local_transcription_retry(
    app: AppHandle,
    id: String,
    options: Option<Value>,
) -> CommandResult<Value> {
    // `options.track` ("mic" | "system") re-runs one track of a dual-channel
    // recording and replaces just that track's results — the other track's
    // transcript stays exactly as it was.
    let track = options
        .as_ref()
        .and_then(|value| value.get("track"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|track| track == "mic" || track == "system");
    let Some(track) = track else {
        let mut record = get_store_value(&app, "local-transcriptions", &id)?.ok_or("Local transcription not found")?;
        let object = record.as_object_mut().ok_or("Stored record must be an object")?;
        object.insert("transcriptText".to_owned(), json!(""));
        object.insert("segments".to_owned(), json!([]));
        object.insert("status".to_owned(), json!("queued"));
        object.insert("progressPhase".to_owned(), json!("queued"));
        object.insert("error".to_owned(), Value::Null);
        save_store_value(&app, "local-transcriptions", record.clone())?;
        let handle = app.clone();
        return tauri::async_runtime::spawn_blocking(move || transcribe_record(&handle, record))
            .await
            .map_err(|error| error.to_string())?;
    };

    let mut record = get_store_value(&app, "local-transcriptions", &id)?.ok_or("Local transcription not found")?;
    let tracks = dual_track_files(&record)
        .ok_or_else(|| "这份录音没有保留可重试的音轨".to_owned())?;
    let path = tracks
        .iter()
        .find(|(source, _)| *source == track)
        .map(|(_, path)| path.clone())
        .ok_or_else(|| "未知音轨".to_owned())?;
    {
        let object = record.as_object_mut().ok_or("Stored record must be an object")?;
        let mut statuses = object
            .get("trackStatuses")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        statuses.insert(track.clone(), json!({ "status": "transcribing" }));
        object.insert("trackStatuses".to_owned(), Value::Object(statuses));
        object.insert("updatedAt".to_owned(), json!(now()));
        object.insert("error".to_owned(), Value::Null);
    }
    save_store_value(&app, "local-transcriptions", record.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = transcribe_single_track(&app, &record, &path.to_string_lossy().as_ref());
        let mut statuses = record
            .get("trackStatuses")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let object = record.as_object_mut().ok_or("Stored record must be an object")?;
        match result {
            Ok((_, mut segments, probe)) => {
                let (speaker_id, speaker_name) = track_speaker(&track);
                for segment in &mut segments {
                    if let Some(entry) = segment.as_object_mut() {
                        entry.insert("source".to_owned(), json!(track));
                        entry.insert("speakerId".to_owned(), json!(speaker_id));
                        entry.insert("speakerName".to_owned(), json!(speaker_name));
                    }
                }
                if let Some(array) = object.get("segments").and_then(Value::as_array).cloned() {
                    let mut kept: Vec<Value> = array
                        .into_iter()
                        .filter(|segment| segment.get("source").and_then(Value::as_str) != Some(track.as_str()))
                        .collect();
                    kept.append(&mut segments);
                    kept.sort_by_key(|segment| {
                        (
                            segment.get("startMs").and_then(Value::as_i64).unwrap_or(0),
                            segment.get("source").and_then(Value::as_str) != Some("mic"),
                        )
                    });
                    object.insert("segments".to_owned(), json!(kept));
                }
                if let Some(probe) = probe {
                    object.insert("durationMs".to_owned(), json!(probe));
                }
                statuses.insert(track, json!({ "status": "completed" }));
                let all_done = statuses.values().all(|status| {
                    status.get("status").and_then(Value::as_str) == Some("completed")
                });
                if all_done {
                    object.insert("status".to_owned(), json!("completed"));
                    object.insert("progressPhase".to_owned(), json!("completed"));
                    object.insert("completedAt".to_owned(), json!(now()));
                }
                object.insert("trackStatuses".to_owned(), Value::Object(statuses));
                object.insert("updatedAt".to_owned(), json!(now()));
                // Rebuild the prefixed transcript from the merged segments.
                let transcript = object.get("segments").and_then(Value::as_array).map(|segments| {
                    segments.iter().filter_map(|segment| {
                        let text = segment.get("text").and_then(Value::as_str)?.trim();
                        if text.is_empty() { return None; }
                        let name = segment.get("speakerName").and_then(Value::as_str).unwrap_or("");
                        Some(format!("{}：{}", name, text))
                    }).collect::<Vec<_>>().join("\n\n")
                }).unwrap_or_default();
                object.insert("transcriptText".to_owned(), json!(transcript));
                save_store_value(&app, "local-transcriptions", record.clone())?;
                Ok(record)
            }
            Err(error) => {
                statuses.insert(track.clone(), json!({ "status": "failed", "error": error.clone() }));
                let any_ok = statuses.values().any(|status| {
                    status.get("status").and_then(Value::as_str) == Some("completed")
                });
                if !any_ok {
                    object.insert("status".to_owned(), json!("failed"));
                    object.insert("progressPhase".to_owned(), json!("failed"));
                }
                object.insert("trackStatuses".to_owned(), Value::Object(statuses));
                object.insert("error".to_owned(), json!(error.clone()));
                object.insert("updatedAt".to_owned(), json!(now()));
                let _ = save_store_value(&app, "local-transcriptions", record.clone());
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn local_transcription_list_hotword_packages(app: AppHandle) -> CommandResult<Vec<Value>> { list_store(&app, "local-hotwords") }

#[tauri::command]
fn local_transcription_save_hotword_package(app: AppHandle, pkg: Value) -> CommandResult<Value> { save_store_value(&app, "local-hotwords", pkg) }

#[tauri::command]
fn local_transcription_delete_hotword_package(app: AppHandle, id: String) -> CommandResult<()> { remove_store_value(&app, "local-hotwords", &id) }

#[tauri::command]
fn local_transcription_list_voiceprints(app: AppHandle) -> CommandResult<Vec<Value>> { list_store(&app, "local-voiceprints") }

#[tauri::command]
fn local_transcription_update_voiceprint(app: AppHandle, mut voiceprint: Value) -> CommandResult<Value> {
    voiceprint.as_object_mut().ok_or("Voiceprint must be an object")?.insert("updatedAt".to_owned(), json!(now()));
    save_store_value(&app, "local-voiceprints", voiceprint)
}

#[tauri::command]
fn local_transcription_delete_voiceprint(app: AppHandle, id: String) -> CommandResult<()> { remove_store_value(&app, "local-voiceprints", &id) }

/// `command(async)`: voiceprint extraction spawns a Python process and loads
/// the CAM++ model, blocking for seconds to minutes.
#[tauri::command(async)]
fn local_transcription_create_voiceprint(app: AppHandle, input: Value) -> CommandResult<Value> {
    let record_id = input.get("sampleRecordId").and_then(Value::as_str).ok_or("Sample record id is required")?;
    let name = input.get("name").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("Voiceprint name is required")?;
    let selected_ids: Vec<&str> = input.get("sampleSegmentIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let record = get_store_value(&app, "local-transcriptions", record_id)?.ok_or("Local transcription not found")?;
    let audio_path = record.get("sourcePath").and_then(Value::as_str).ok_or("Source path is required")?;
    let segments: Vec<Value> = record.get("segments").and_then(Value::as_array).into_iter().flatten()
        .filter(|segment| segment.get("id").and_then(Value::as_str).is_some_and(|id| selected_ids.contains(&id)))
        .cloned().collect();
    let candidates: Vec<Value> = segments.iter().filter_map(|segment| {
        let id = segment.get("id")?.clone();
        let start = segment.get("startMs")?.clone();
        let end = segment.get("endMs")?.clone();
        if start.as_i64()? >= end.as_i64()? { None } else { Some(json!({ "id": id, "startMs": start, "endMs": end })) }
    }).collect();
    if candidates.is_empty() { return Err("Selected segment does not have usable audio timestamps".to_owned()) }
    let directory = model_dir(&app)?;
    if !directory.join(".ready").exists() {
        return Err("Local ASR model is not installed".to_owned());
    }
    let embeddings = run_voiceprint_extraction(&app, audio_path, &candidates, &directory)?;
    let values = candidates.iter().filter_map(|candidate| candidate.get("id").and_then(Value::as_str)).filter_map(|id| embeddings.get(id).cloned()).collect::<Vec<_>>();
    let embedding = average_embeddings(&values);
    if embedding.is_empty() { return Err("Voiceprint embedding extraction failed".to_owned()) }
    let timestamp = now();
    let voiceprint = json!({
        "id": format!("voiceprint:{}", Uuid::new_v4()), "name": name, "createdAt": timestamp, "updatedAt": timestamp,
        "sampleRecordId": record_id, "sampleSegmentIds": selected_ids, "embedding": embedding,
        "sampleText": segments.iter().filter_map(|segment| segment.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
    });
    save_store_value(&app, "local-voiceprints", voiceprint.clone())?;
    let sample_speaker_keys: HashSet<String> = segments.iter().filter_map(record_speaker_key).collect();
    if !sample_speaker_keys.is_empty() {
        let updated_segments = record
            .get("segments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut segment| {
                if record_speaker_key(&segment).is_some_and(|key| sample_speaker_keys.contains(&key)) {
                    if let Some(object) = segment.as_object_mut() {
                        object.insert("speakerName".to_owned(), voiceprint["name"].clone());
                        object.insert("voiceprintId".to_owned(), voiceprint["id"].clone());
                    }
                }
                segment
            })
            .collect::<Vec<_>>();
        let mut patch = Map::new();
        patch.insert("segments".to_owned(), json!(updated_segments));
        patch.insert("updatedAt".to_owned(), json!(now()));
        update_store_value(&app, "local-transcriptions", record_id, patch)?;
    }
    Ok(voiceprint)
}

fn stt_config_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?.join("local-stt-config").join("config.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(path)
}

fn load_transcribe_config(app: &AppHandle) -> CommandResult<stt::TranscribeConfig> {
    let path = stt_config_path(app)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(serde_json::from_str(&content).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(stt::TranscribeConfig::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn save_transcribe_config(app: &AppHandle, config: stt::TranscribeConfig) -> CommandResult<stt::TranscribeConfig> {
    let path = stt_config_path(app)?;
    let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(config)
}

#[tauri::command]
fn local_stt_config_get(app: AppHandle) -> CommandResult<stt::TranscribeConfig> {
    load_transcribe_config(&app)
}

#[tauri::command]
fn local_stt_config_save(app: AppHandle, config: stt::TranscribeConfig) -> CommandResult<stt::TranscribeConfig> {
    save_transcribe_config(&app, config)
}

const SECRET_SERVICE: &str = "com.lynse.sparknote";

/// Single keychain entry that holds every secret as a JSON map. Kept in sync
/// with `VAULT_ACCOUNT` in `src/secure-storage.ts`.
#[cfg(debug_assertions)]
const SECRET_VAULT_ACCOUNT: &str = "lynse_secrets_v1";

/// Per-key entries written by builds that predate the single-vault layout. Only
/// read during the one-time migration out of the keychain.
#[cfg(debug_assertions)]
const LEGACY_SECRET_ACCOUNTS: [&str; 6] = [
    "lynse_api_key",
    "lynse_token",
    "lynse_live_translation_ilivedata_secret_key",
    "lynse_live_translation_qwen_api_key",
    "lynse_live_translation_volc_api_key",
    "lynse_qoder_pat",
];

/// Debug builds keep secrets in a `0600` file next to the rest of the app data
/// instead of in the OS keychain.
///
/// macOS attaches a keychain item's access control list to the code signature
/// of the binary that touched it. A dev binary is relinked — and therefore
/// re-signed ad hoc — on every `cargo build`, so the "Always Allow" grant made
/// for yesterday's binary does not cover today's, and the user is asked for
/// their login password on every launch, usually several times per session.
/// Release builds carry a stable signature and keep using the real keychain.
#[cfg(debug_assertions)]
const DEV_SECRET_FILE: &str = "secrets.dev.json";

fn keyring_get(account: &str) -> CommandResult<Option<String>> {
    let entry = keyring::Entry::new(SECRET_SERVICE, account).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(debug_assertions))]
fn keyring_set(account: &str, value: &str) -> CommandResult<()> {
    let entry = keyring::Entry::new(SECRET_SERVICE, account).map_err(|error| error.to_string())?;
    entry.set_password(value).map_err(|error| error.to_string())
}

#[cfg(not(debug_assertions))]
fn keyring_delete(account: &str) -> CommandResult<()> {
    let entry = keyring::Entry::new(SECRET_SERVICE, account).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(debug_assertions)]
fn dev_secret_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(app_data_dir(app)?.join(DEV_SECRET_FILE))
}

#[cfg(debug_assertions)]
fn dev_secret_read_map(app: &AppHandle) -> HashMap<String, String> {
    let Ok(path) = dev_secret_path(app) else {
        return HashMap::new();
    };
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<HashMap<String, String>>(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

#[cfg(debug_assertions)]
fn dev_secret_write_map(app: &AppHandle, map: &HashMap<String, String>) -> CommandResult<()> {
    let path = dev_secret_path(app)?;
    let content = serde_json::to_string(map).map_err(|error| error.to_string())?;
    fs::write(&path, content).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Copy whatever the release build left in the keychain into the dev store.
///
/// Runs at most once per process and only while the dev store file is missing,
/// so a dev build touches the keychain exactly once over its lifetime — after
/// the import it never reads or writes the keychain again, which is what stops
/// the repeated password prompts. Accounts that are absent from the keychain
/// are simply skipped; the file is still created so the next launch can tell
/// that the import already happened.
#[cfg(debug_assertions)]
fn dev_secret_import_from_keychain(app: &AppHandle) {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Ok(path) = dev_secret_path(app) else {
            return;
        };
        if path.exists() {
            return;
        }

        let mut vault: Map<String, Value> = match keyring_get(SECRET_VAULT_ACCOUNT) {
            Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
            _ => Map::new(),
        };
        for account in LEGACY_SECRET_ACCOUNTS {
            if vault.contains_key(account) {
                continue;
            }
            if let Ok(Some(value)) = keyring_get(account) {
                vault.insert((*account).to_owned(), Value::String(value));
            }
        }

        let mut map = HashMap::new();
        if !vault.is_empty() {
            match serde_json::to_string(&vault) {
                Ok(raw) => {
                    map.insert(SECRET_VAULT_ACCOUNT.to_owned(), raw);
                }
                Err(error) => log::error!("[secrets] could not serialize imported vault: {error}"),
            }
        }
        if let Err(error) = dev_secret_write_map(app, &map) {
            log::error!("[secrets] dev store import failed: {error}");
        }
    });
}

pub(crate) fn secret_get(app: &AppHandle, account: &str) -> CommandResult<Option<String>> {
    secret_get_impl(app, account)
}

pub(crate) fn secret_set(app: &AppHandle, account: &str, value: &str) -> CommandResult<()> {
    secret_set_impl(app, account, value)
}

pub(crate) fn secret_delete(app: &AppHandle, account: &str) -> CommandResult<()> {
    secret_delete_impl(app, account)
}

#[cfg(debug_assertions)]
fn secret_get_impl(app: &AppHandle, account: &str) -> CommandResult<Option<String>> {
    if dev_secret_path(app)?.exists() {
        return Ok(dev_secret_read_map(app).get(account).cloned());
    }
    dev_secret_import_from_keychain(app);
    Ok(dev_secret_read_map(app).get(account).cloned())
}

#[cfg(not(debug_assertions))]
fn secret_get_impl(_app: &AppHandle, account: &str) -> CommandResult<Option<String>> {
    keyring_get(account)
}

#[cfg(debug_assertions)]
fn secret_set_impl(app: &AppHandle, account: &str, value: &str) -> CommandResult<()> {
    let mut map = dev_secret_read_map(app);
    map.insert(account.to_owned(), value.to_owned());
    dev_secret_write_map(app, &map)
}

#[cfg(not(debug_assertions))]
fn secret_set_impl(_app: &AppHandle, account: &str, value: &str) -> CommandResult<()> {
    keyring_set(account, value)
}

#[cfg(debug_assertions)]
fn secret_delete_impl(app: &AppHandle, account: &str) -> CommandResult<()> {
    let mut map = dev_secret_read_map(app);
    map.remove(account);
    dev_secret_write_map(app, &map)
}

#[cfg(not(debug_assertions))]
fn secret_delete_impl(_app: &AppHandle, account: &str) -> CommandResult<()> {
    keyring_delete(account)
}

#[tauri::command]
fn secure_set_secret(app: AppHandle, account: String, value: String) -> CommandResult<()> {
    secret_set(&app, &account, &value)
}

#[tauri::command]
fn secure_get_secret(app: AppHandle, account: String) -> CommandResult<Option<String>> {
    secret_get(&app, &account)
}

#[tauri::command]
fn secure_delete_secret(app: AppHandle, account: String) -> CommandResult<()> {
    secret_delete(&app, &account)
}

fn media_response_body(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = request
        .uri()
        .path()
        .strip_prefix('/')
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned());
    let result = (|| -> CommandResult<(PathBuf, u64, u64, bool, u64)> {
        let id = id.ok_or("Missing local media id")?;
        let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
        // Paths come in two shapes: `<id>` resolves the record's audio file,
        // `<id>/<file>` picks a concrete asset (a saved inspiration image),
        // and `staging:<file>` previews an attachment that is not saved yet.
        let (id, asset_file) = match id.split_once('/') {
            Some((id, file)) => (id.to_owned(), Some(file.to_owned())),
            None => (id, None),
        };
        if let Some(file) = asset_file.as_deref() {
            if !is_safe_asset_file_name(file) {
                return Err("Unsafe local media asset name".to_owned());
            }
        }
        let path = if let Some(file) = id.strip_prefix("staging:") {
            if !is_safe_asset_file_name(file) {
                return Err("Unsafe local media asset name".to_owned());
            }
            data_dir.join("inspirations").join("staging").join(file)
        } else if let Some(inspiration_uuid) = id.strip_prefix("inspiration:") {
            let file = match asset_file {
                Some(file) => file,
                None => {
                    let index = data_dir.join("local-inspirations").join("index.json");
                    let record = read_array(&index)?.into_iter()
                        .find(|value| value.get("id").and_then(Value::as_str) == Some(id.as_str()))
                        .ok_or("Unknown local media id")?;
                    record.get("audio")
                        .and_then(|audio| audio.get("file"))
                        .and_then(Value::as_str)
                        .ok_or("Missing audio file")?
                        .to_owned()
                }
            };
            if !is_safe_asset_file_name(&file) {
                return Err("Unsafe local media asset name".to_owned());
            }
            vault::content_dir(app, vault::ContentKind::Inspirations)?
                .join(inspiration_uuid)
                .join(file)
        } else {
            let index = data_dir.join("local-transcriptions").join("index.json");
            let record = read_array(&index)?.into_iter()
                .find(|value| value.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or("Unknown local media id")?;
            let source = PathBuf::from(record.get("sourcePath").and_then(Value::as_str).ok_or("Missing source path")?);
            // `<id>/<file>` on a recording picks a concrete audio track from
            // the session directory (本机/远端 per-track listening). Only
            // files listed in the record's track manifest are servable.
            match asset_file.as_deref() {
                Some(file) => {
                    let allowed = record.get("trackManifest")
                        .and_then(|manifest| manifest.get("tracks"))
                        .and_then(Value::as_array)
                        .map(|tracks| tracks.iter().any(|track| track.get("file").and_then(Value::as_str) == Some(file)))
                        .unwrap_or(false);
                    if !allowed {
                        return Err("Unknown recording track".to_owned());
                    }
                    source.parent().map(|dir| dir.join(file)).ok_or("Missing session directory")?
                }
                None => source,
            }
        };
        let total = fs::metadata(&path).map_err(|error| error.to_string())?.len();
        let range = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
        let (start, end, partial) = parse_range(range, total);
        Ok((path, start, end, partial, total))
    })();
    let Ok((path, start, end, partial, total)) = result else {
        return Response::builder()
            // WKWebView treats custom-scheme fetches as cross-origin; without
            // this header `fetch("local-media://…")` fails and waveform
            // decoding (editor + player scrubber) never sees the bytes.
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap();
    };
    let mut file = match File::open(&path) { Ok(file) => file, Err(_) => return Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap() };
    // Read exactly the requested span. WebKit probes media with offset
    // ranges (an m4a's moov atom sits at the tail), so a range response must
    // carry `end - start + 1` bytes — a full-file buffer overruns EOF here
    // and fails every such load.
    let span = end.saturating_sub(start).saturating_add(1);
    let mut body = vec![0; span as usize];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)).is_err() {
        return Response::builder()
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .unwrap();
    }
    let mut builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_TYPE, mime_guess::from_path(&path).first_or_octet_stream().essence_str())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len());
    if partial {
        builder = builder.status(StatusCode::PARTIAL_CONTENT).header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
    }
    builder.body(body).unwrap()
}

fn parse_range(range: Option<&str>, length: u64) -> (u64, u64, bool) {
    let Some(range) = range.and_then(|value| value.strip_prefix("bytes=")) else { return (0, length.saturating_sub(1), false) };
    let Some((start, end)) = range.split_once('-') else { return (0, length.saturating_sub(1), false) };
    let start = start.parse::<u64>().unwrap_or(0).min(length.saturating_sub(1));
    let end = end.parse::<u64>().unwrap_or_else(|_| length.saturating_sub(1)).min(length.saturating_sub(1));
    (start, end.max(start), true)
}

fn copy_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() { copy_directory(&entry.path(), &target)?; } else if !target.exists() { fs::copy(entry.path(), target)?; }
    }
    Ok(())
}

fn migrate_electron_data(app: &AppHandle) -> CommandResult<()> {
    let target = app_data_dir(app)?;
    let marker = target.join(".electron-data-migrated");
    if marker.exists() {
        return Ok(());
    }
    let home = env::var_os("HOME").map(PathBuf::from).ok_or("Home directory is unavailable")?;
    for name in ["Lynse", "Lynse Dev"] {
        let source = home.join("Library/Application Support").join(name);
        if !source.exists() { continue }
        for relative in ["local-transcriptions", "local-hotwords", "local-voiceprints", "local-asr-models/funasr"] {
            let from = source.join(relative);
            let to = target.join(relative);
            if from.exists() && !to.exists() { copy_directory(&from, &to).map_err(|error| error.to_string())?; }
        }
    }
    fs::write(marker, now()).map_err(|error| error.to_string())
}

// ── Version / update checking ──────────────────────────────
// Update detection, download, and install are handled end-to-end by
// tauri-plugin-updater (endpoints + pubkey live in tauri.conf.json), with
// release assets published to GitHub Releases by `.github/workflows/release.yml`.

/// The macOS build number the release workflow stamps into the bundle's
/// Info.plist (`CFBundleVersion` — the monotonic CI run number, see the
/// "Stamp build number" step). Dev builds have no bundle and return None.
/// Windows/msi builds carry no build number either.
#[cfg(target_os = "macos")]
fn bundle_build_number() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let plist = fs::read_to_string(exe.parent()?.parent()?.join("Info.plist")).ok()?;
    // Anchor on the full key tag so a stray "CFBundleVersion" in a comment or
    // value can't redirect the search, and the following <string> is the value.
    let key = plist.find("CFBundleVersion</key>")? + "CFBundleVersion</key>".len();
    let open = plist[key..].find("<string>")? + "<string>".len();
    let close = plist[open..].find("</string>")?;
    let value = plist[open..open + close].trim();
    // This string is rendered verbatim in the About window, and a concurrent
    // build can leave the plist half-written. Only accept a short token, so a
    // corrupt plist hides the build number instead of leaking raw XML into the UI.
    let sane = !value.is_empty()
        && value.len() <= 16
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    sane.then(|| value.to_string())
}

#[cfg(not(target_os = "macos"))]
fn bundle_build_number() -> Option<String> {
    None
}

#[tauri::command]
fn get_app_info(app: AppHandle) -> Value {
    let version = app.package_info().version.to_string();
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        other => other,
    };
    json!({ "version": version, "build": bundle_build_number(), "platform": platform })
}

/// Reveal the app log folder in the system file manager so users can attach
/// logs to a bug report ("Settings → About → View logs").
#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("resolve log dir: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("create log dir: {error}"))?;
    tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|error| error.to_string())
}

/// Default combined log-tail budget for the bug report dialog. The tail also
/// rides along in the prefilled GitHub issue URL, so it must stay small
/// enough for browsers and the issue form (kept well under ~8k chars after
/// the frontend clamps it again).
const DIAGNOSTICS_LOG_TAIL_BYTES: usize = 16 * 1024;
/// Hard cap for the same budget, so a caller passing a huge value can't
/// balloon the report bundle or the IPC payload.
const DIAGNOSTICS_LOG_TAIL_MAX_BYTES: usize = 64 * 1024;

/// Log files written by tauri-plugin-log (`lynse.log` plus rotated archives
/// under the OS log dir), newest first by modified time.
fn diagnostics_log_files(log_dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(log_dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_lowercase();
            (name.starts_with("lynse") && name.ends_with(".log")).then(|| entry.path())
        })
        .collect();
    files.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|meta| meta.modified())
            .map(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .ok()
            .flatten()
            .unwrap_or_default()
    });
    files.reverse();
    files
}

/// Tail of the app's log files for the in-app bug report dialog. Newest files
/// are read first so the result carries the most recent lines even when the
/// tail spans rotated archives; `truncated` reports that older bytes were
/// left out.
#[tauri::command(async)]
fn diagnostics_read_logs(app: AppHandle, max_bytes: Option<usize>) -> CommandResult<Value> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("resolve log dir: {error}"))?;
    let budget = max_bytes
        .unwrap_or(DIAGNOSTICS_LOG_TAIL_BYTES)
        .min(DIAGNOSTICS_LOG_TAIL_MAX_BYTES);
    let files = diagnostics_log_files(&log_dir);
    let total_bytes: u64 = files
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|meta| meta.len())
        .sum();

    let mut remaining = budget;
    // Collected newest-first; re-ordered oldest-first before returning so the
    // tail reads chronologically.
    let mut parts: Vec<String> = Vec::new();
    for file in &files {
        if remaining == 0 {
            break;
        }
        let Ok(content) = fs::read_to_string(file) else {
            continue;
        };
        let take = remaining.min(content.len());
        // Nudge forward to a char boundary so the slice never splits a
        // multi-byte character.
        let mut start = content.len() - take;
        while start < content.len() && !content.is_char_boundary(start) {
            start += 1;
        }
        parts.push(content[start..].to_string());
        remaining -= take;
    }
    parts.reverse();
    Ok(json!({
        "dir": log_dir.to_string_lossy(),
        "tail": parts.join(""),
        "truncated": total_bytes > budget as u64,
        "files": files.len(),
    }))
}

/// Assemble a bug-report bundle on disk: the user's composed markdown, the
/// staged screenshots, and (optionally) copies of the raw log files. Only
/// file names are accepted for attachments and they are re-resolved inside
/// the inspiration staging dir, so a crafted path can't pull arbitrary files
/// into the bundle. Returns the folder so the UI can reveal it in the system
/// file manager for drag-and-drop onto the GitHub issue.
#[tauri::command(async)]
fn diagnostics_prepare_report(
    app: AppHandle,
    markdown: String,
    attachments: Vec<String>,
    include_logs: bool,
) -> CommandResult<Value> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let dir = app_data_dir(&app)?
        .join("reports")
        .join(format!("report-{stamp}"));
    fs::create_dir_all(&dir).map_err(|error| format!("create report dir: {error}"))?;
    fs::write(dir.join("report.md"), markdown)
        .map_err(|error| format!("write report.md: {error}"))?;

    let staging = inspiration_staging_dir(&app)?;
    for attachment in &attachments {
        let Some(name) = Path::new(attachment)
            .file_name()
            .and_then(|name| name.to_str())
        else {
            continue;
        };
        if !is_safe_asset_file_name(name) {
            continue;
        }
        if let Ok(bytes) = fs::read(staging.join(name)) {
            let _ = fs::write(dir.join(name), bytes);
        }
    }

    if include_logs {
        let log_dir = app
            .path()
            .app_log_dir()
            .map_err(|error| format!("resolve log dir: {error}"))?;
        let logs_dir = dir.join("logs");
        fs::create_dir_all(&logs_dir).map_err(|error| format!("create logs dir: {error}"))?;
        for file in diagnostics_log_files(&log_dir) {
            let Some(name) = file.file_name() else {
                continue;
            };
            if let Ok(bytes) = fs::read(&file) {
                let _ = fs::write(logs_dir.join(name), bytes);
            }
        }
    }

    Ok(json!({ "dir": dir.to_string_lossy() }))
}

const TRAY_ELAPSED_ID: &str = "tray_elapsed";
const TRAY_START_ID: &str = "start_live_recording";
const TRAY_PAUSE_ID: &str = "pause_live_recording";
const TRAY_STOP_ID: &str = "stop_live_recording";
const TRAY_SHOW_MAIN_ID: &str = "show_main";
const TRAY_SHOW_SUBTITLES_ID: &str = "show_subtitles";
const TRAY_QUIT_ID: &str = "quit";

fn format_elapsed(total: u64) -> String {
    let m = total / 60;
    let s = total % 60;
    format!("{:02}:{:02}", m, s)
}

/// Build the tray menu reflecting the given recording state. The menu
/// mirrors the native "Dynamic Island" feel: a disabled header shows
/// elapsed time / status, followed by recording transport controls whose
/// enabled state tracks whether a session is active.
fn build_tray_menu(
    app: &AppHandle,
    st: TrayUiState,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let elapsed_text = if st.recording {
        let elapsed = format_elapsed(st.elapsed_secs);
        if st.paused {
            format!("⏸  已暂停  {elapsed}")
        } else {
            format!("🔴  录音中  {elapsed}")
        }
    } else {
        "Lynse".to_string()
    };
    let elapsed = MenuItemBuilder::with_id(TRAY_ELAPSED_ID, elapsed_text)
        .enabled(false)
        .build(app)?;
    let start = MenuItemBuilder::with_id(TRAY_START_ID, "▶  开启录音")
        .enabled(!st.recording)
        .build(app)?;
    let pause_label = if st.paused { "▶  继续录音" } else { "⏸  暂停录音" };
    let pause = MenuItemBuilder::with_id(TRAY_PAUSE_ID, pause_label)
        .enabled(st.recording)
        .build(app)?;
    let stop = MenuItemBuilder::with_id(TRAY_STOP_ID, "⏹  停止并保存")
        .enabled(st.recording)
        .build(app)?;
    let show_main = MenuItemBuilder::with_id(TRAY_SHOW_MAIN_ID, "▣  显示主窗口").build(app)?;
    let show_subtitles =
        MenuItemBuilder::with_id(TRAY_SHOW_SUBTITLES_ID, "▤  显示实时字幕").build(app)?;
    let quit = MenuItemBuilder::with_id(TRAY_QUIT_ID, "⏻  退出 Lynse").build(app)?;
    MenuBuilder::new(app)
        .item(&elapsed)
        .item(&start)
        .separator()
        .item(&pause)
        .item(&stop)
        .separator()
        .item(&show_main)
        .item(&show_subtitles)
        .separator()
        .item(&quit)
        .build()
}

/// Rebuild the tray menu from the current `AppState.tray_ui`. Called when
/// the recording state changes (also cheap enough to call on every
/// `update_tray` tick, which keeps the in-menu elapsed time fresh).
fn rebuild_tray_menu(app: &AppHandle) -> CommandResult<()> {
    let Some(tray) = app.tray_by_id("main-tray") else { return Ok(()); };
    let st = *app
        .state::<AppState>()
        .tray_ui
        .lock()
        .map_err(|_| "tray_ui lock poisoned")?;
    let menu = build_tray_menu(app, st).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Bring the main window back on screen however it was stashed: hidden via
/// `minimizeToTray`, minimized to the Dock, or hidden together with the whole
/// app via Cmd-H — a bare `window.show()` is invisible while the
/// NSApplication itself is hidden, and never deminiaturizes a Dock-minimized
/// window.
pub(crate) fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
    // The island only exists for when the main window is out of sight, so
    // restoring the main window always retires it. Tray "显示主窗口", the
    // island's expand button and the Dock reopen all funnel through here.
    live_translation::set_recording_island_visible(app, false);
}

/// Logical size of the standalone About window (icon, version, legal links).
const ABOUT_WINDOW_WIDTH: f64 = 320.0;
const ABOUT_WINDOW_HEIGHT: f64 = 460.0;

/// Logical size of the standalone feature-request window hosting the FeedLog
/// widget. The widget's panel is 400pt wide and up to `100vh - 120pt` tall,
/// so the window leaves room for the launcher bubble plus the header.
const FEEDBACK_WINDOW_WIDTH: f64 = 440.0;
const FEEDBACK_WINDOW_HEIGHT: f64 = 760.0;

/// Center `window` over the main window (falling back to the screen center),
/// so the About popup reads as attached to the app instead of free-floating.
fn center_window_over_main(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) {
    let fallback = window.center();
    let Some(main) = app.get_webview_window("main") else {
        let _ = fallback;
        return;
    };
    let (Ok(main_position), Ok(main_size)) = (main.outer_position(), main.outer_size()) else {
        let _ = fallback;
        return;
    };
    let Ok(scale) = main.scale_factor() else { return };
    // Physical pixels → logical units, then top-left for our centered window.
    let x = (main_position.x as f64 + main_size.width as f64 / 2.0) / scale - width / 2.0;
    let y = (main_position.y as f64 + main_size.height as f64 / 2.0) / scale - height / 2.0;
    let _ = window.set_position(LogicalPosition::new(x, y));
}

/// Open (or focus) the standalone About window — a small fixed-size window
/// with the app icon, version and legal links that used to sit at the bottom
/// of the settings dialog. `title` is the localized window title picked by
/// the frontend, which knows the active locale.
#[tauri::command]
fn open_about_window(app: AppHandle, title: Option<String>) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window("about") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    // Created hidden and positioned before the reveal, so the popup never
    // flashes at the screen origin before settling over the main window.
    // The reveal itself waits for the page-load-finished event on Windows:
    // a hidden-created WebView2 window shown before its page is ready can
    // stay invisible for good (about/feedback were reported never popping
    // up on Windows). macOS keeps the proven immediate reveal.
    let window = WebviewWindowBuilder::new(
        &app,
        "about",
        WebviewUrl::App("index.html?window=about".into()),
    )
    .title(title.unwrap_or_else(|| "Lynse".to_string()))
    .inner_size(ABOUT_WINDOW_WIDTH, ABOUT_WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .visible(false)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .build()
    .map_err(|error| format!("failed to create about window: {error}"))?;
    center_window_over_main(&app, &window, ABOUT_WINDOW_WIDTH, ABOUT_WINDOW_HEIGHT);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

/// Open (or focus) the standalone feature-request window — a small fixed-size
/// window hosting the FeedLog feedback widget (`?window=feedback` route),
/// mirroring the About window setup. `title` is the localized window title
/// picked by the frontend, which knows the active locale.
#[tauri::command]
fn open_feedback_window(app: AppHandle, title: Option<String>) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window("feedback") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    // Created hidden and positioned before the reveal, so the popup never
    // flashes at the screen origin before settling over the main window.
    // Same Windows page-load-gated reveal as the About window above.
    let window = WebviewWindowBuilder::new(
        &app,
        "feedback",
        WebviewUrl::App("index.html?window=feedback".into()),
    )
    .title(title.unwrap_or_else(|| "Lynse".to_string()))
    .inner_size(FEEDBACK_WINDOW_WIDTH, FEEDBACK_WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .visible(false)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .build()
    .map_err(|error| format!("failed to create feedback window: {error}"))?;
    center_window_over_main(&app, &window, FEEDBACK_WINDOW_WIDTH, FEEDBACK_WINDOW_HEIGHT);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

/// Creates the menu-bar / notification-area tray icon and its menu so the
/// app (and the live-translation floating window) can be minimized to and
/// restored from the system status bar.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    // Use the app's own icon: a bare mic glyph in the menu bar is ambiguous
    // (reads as a recording indicator / unrelated app).
    let Some(icon) = app.default_window_icon().cloned() else {
        log::warn!("No default window icon available for the tray");
        return Ok(());
    };

    let menu = build_tray_menu(app, TrayUiState::default())?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Lynse")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "start_live_recording" => {
                // Relay to the main window's always-mounted tray agent
                // (`RecordingTrayAgent`): starting a recording needs the
                // permission checks + audio-source config that live in the
                // webview layer, and the agent exists no matter which page is
                // open or whether the window is hidden. The session starts as
                // a plain recording; live transcription is opt-in via the
                // island's transcript drawer.
                if let Err(error) = app.emit("live-translation-tray-action", "start") {
                    log::error!("Failed to request live recording start: {error}");
                }
            }
            "pause_live_recording" => {
                if let Err(error) = app.emit("live-translation-tray-action", "pause") {
                    log::error!("Failed to request live recording pause: {error}");
                }
            }
            "stop_live_recording" => {
                if let Err(error) = app.emit("live-translation-tray-action", "stop") {
                    log::error!("Failed to request live recording stop: {error}");
                }
            }
            "show_main" => {
                show_main_window(app);
            }
            "show_subtitles" => {
                let visible = app
                    .get_webview_window("live-subtitles")
                    .map(|window| window.is_visible().unwrap_or(false))
                    .unwrap_or(false);
                if let Err(error) =
                    live_translation::live_translation_show_subtitles(app.clone(), !visible)
                {
                    log::error!("Failed to toggle live subtitles: {error}");
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

pub fn run() {
    // Persist panics to the log file: the default hook only writes to stderr,
    // which is invisible for packaged (non-terminal) launches.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|location| {
                format!("{}:{}:{}", location.file(), location.line(), location.column())
            })
            .unwrap_or_else(|| "unknown".to_string());
        let payload = info.payload();
        let message = if let Some(text) = payload.downcast_ref::<&str>() {
            (*text).to_string()
        } else if let Some(text) = payload.downcast_ref::<String>() {
            text.clone()
        } else {
            "non-string panic payload".to_string()
        };
        log::error!("panic at {location}: {message}");
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            model_download_in_progress: Mutex::new(false),
            webdav_sync_in_progress: Mutex::new(false),
            tray_ui: Mutex::new(TrayUiState::default()),
        })
        .manage(LiveTranslationManager::default())
        .manage(meeting_detector::MeetingDetectorHandle::default())
        .manage(feishu::FeishuHandle::default())
        .register_asynchronous_uri_scheme_protocol("local-media", |context, request, responder| {
            // WKURLSchemeHandler fires this on the MAIN thread; a long
            // meeting's WAV is 100+ MB, so the file read must leave the main
            // thread or the whole UI stalls while the editor / player loads.
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(media_response_body(&app, request));
            });
        })
        .setup(|app| {
            // File logging needs the OS log dir, which only resolves with the
            // app handle — so the plugin registers here rather than on the
            // builder chain, and anything logged before this point reaches
            // stdout only. Daily files beyond the retention window are pruned
            // first, so the crash history stays bounded (see logging.rs).
            match app.path().app_log_dir() {
                Ok(log_dir) => {
                    logging::prune_old_logs(&log_dir);
                    if let Err(error) = app.handle().plugin(logging::build_plugin(&log_dir)) {
                        eprintln!("Failed to initialize file logging: {error}");
                    }
                }
                Err(error) => eprintln!("Failed to resolve log dir: {error}"),
            }
            app.manage(recording_card::RecordingCardManager::new(app.handle().clone()));
            if let Err(error) = migrate_electron_data(&app.handle()) {
                log::error!("Failed to migrate Electron local data: {error}");
            }
            // Fold user content into the vault folder for installs that
            // enabled it before unified content storage shipped.
            if let Err(error) = content_migration::migrate_on_launch(&app.handle()) {
                log::error!("Failed to relocate user content into the vault folder: {error}");
            }
            // Inspiration staging only holds in-flight paste/pick previews;
            // anything left over belongs to a crashed session.
            let staging = app.path().app_data_dir().map(|path| path.join("inspirations").join("staging"));
            if let Ok(staging) = staging {
                if staging.exists() {
                    let _ = fs::remove_dir_all(&staging);
                }
            }
            if let Err(error) = fail_interrupted_records(&app.handle()) {
                log::error!("Failed to recover interrupted local transcriptions: {error}");
            }
            if let Err(error) = setup_tray(&app.handle()) {
                log::error!("Failed to setup system tray: {error}");
            }
            recording_card::spawn_reconnect_watcher(app.handle().clone());
            // Auto-record on detected meetings: polls OS audio sessions for
            // whitelisted meeting apps; runs whether or not the main window
            // is visible, and no-ops until the webview enables it.
            meeting_detector::spawn(app.handle().clone());
            // Feishu bot long connection: reconnects only when the user left
            // it enabled with valid-looking credentials.
            feishu::spawn(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window_effects::apply_window_effects(&window) {
                    log::error!("Failed to apply native window effects: {error}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window must not destroy it: the process stays
            // alive in the tray, and a destroyed window can never be reopened
            // from the tray menu or the Dock. Hide instead — the standard
            // macOS tray-app pattern.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    // Hidden to the tray mid-session: the island becomes the
                    // on-screen control surface (capture keeps running in the
                    // sidecar regardless).
                    let app = window.app_handle();
                    if app.state::<LiveTranslationManager>().has_active_session() {
                        live_translation::set_recording_island_visible(app, true);
                    }
                    return;
                }
            }
            // The island mirrors the "main window out of sight" state: a
            // Dock-minimize (no CloseRequested fires) must surface it, and any
            // refocus of the main window must retire it.
            if let tauri::WindowEvent::Focused(focused) = event {
                if window.label() == "main" {
                    let app = window.app_handle().clone();
                    if *focused {
                        live_translation::set_recording_island_visible(&app, false);
                    } else {
                        // The genie/minimize animation settles after focus
                        // drops; re-check once it does so that merely switching
                        // to another app (window still visible) never pops the
                        // island.
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(200));
                            let Some(main) = app.get_webview_window("main") else {
                                return;
                            };
                            if main.is_minimized().unwrap_or(false)
                                && app.state::<LiveTranslationManager>().has_active_session()
                            {
                                live_translation::set_recording_island_visible(&app, true);
                            }
                        });
                    }
                    return;
                }
            }
            // Resizes (and the fullscreen enter/exit behind them) can reset the
            // traffic lights to the system layout; re-assert the tighter stride.
            if !matches!(event, tauri::WindowEvent::Resized { .. }) || window.label() != "main" {
                return;
            }
            if let Some(webview) = window.get_webview_window("main") {
                window_effects::apply_traffic_light_spacing(&webview);
            }
        })
        .invoke_handler(tauri::generate_handler![
            local_transcription_list, local_transcription_get, local_transcription_delete, local_transcription_audio_url,
            local_transcription_track_audio_url,
            todo_list, todo_save, todo_delete, todo_add_to_calendar,
            inspiration_list, inspiration_save, inspiration_delete, inspiration_transcribe, inspiration_audio_url,
            inspiration_image_url, inspiration_stage_image, inspiration_stage_image_from_path,
            inspiration_stage_image_from_clipboard, inspiration_capture_from_iphone,
            inspiration_voice::inspiration_voice_start, inspiration_voice::inspiration_voice_stop,
            inspiration_voice::inspiration_voice_cancel, inspiration_voice::inspiration_voice_state,
            local_stt_model_status, local_stt_download_model, local_stt_delete_model,
            local_transcription_transcribe, local_transcription_retry, local_transcription_list_hotword_packages,
            local_transcription_save_hotword_package, local_transcription_delete_hotword_package,
            local_transcription_list_voiceprints, local_transcription_create_voiceprint,
            local_transcription_update_voiceprint, local_transcription_delete_voiceprint,
            local_stt_config_get, local_stt_config_save,
            vault::vault_config_get, vault::vault_config_save, vault::vault_default_path,
            vault::vault_write_note, vault::vault_write_notes, vault::vault_read_note,
            vault::vault_remove_note,
            storage::storage_usage, storage::storage_reveal, storage::storage_clear,
            webdav::webdav_config_get, webdav::webdav_config_save, webdav::webdav_set_password,
            webdav::webdav_test_connection, webdav::webdav_sync_now, webdav::webdav_put_notes,
            workbuddy::workbuddy_openapi,
            feishu::feishu_config_get, feishu::feishu_config_save, feishu::feishu_config_reset,
            bots::bot_config_get, bots::bot_config_save, bots::bot_reset, bots::bot_start,
            bots::bot_stop, bots::bot_state,
            feishu::feishu_bot_start,
            feishu::feishu_bot_stop, feishu::feishu_state, feishu::feishu_test_connection,
            feishu::feishu_list_chats, feishu::feishu_send_text, feishu::feishu_reply_text,
            feishu::feishu_reply_markdown, feishu::feishu_update_markdown_card,
            feishu::feishu_stream_start, feishu::feishu_stream_push, feishu::feishu_stream_finish,
            feishu::feishu_send_summary_card,
            feishu::feishu_register_begin, feishu::feishu_register_poll,
            feishu::feishu_register_cancel,
            secure_set_secret, secure_get_secret, secure_delete_secret,
            get_app_info,
            open_about_window,
            open_feedback_window,
            open_logs_folder,
            diagnostics_read_logs, diagnostics_prepare_report,
            live_translation::live_translation_permissions,
            live_translation::live_translation_request_permission,
            live_translation::live_translation_audio_devices,
            live_translation::live_translation_state,
            live_translation::live_translation_start,
            live_translation::live_translation_pause,
            live_translation::live_translation_resume,
            live_translation::live_translation_stop,
            live_translation::live_translation_finalize_local,
            live_translation::live_translation_discard,
            live_translation::live_translation_reprocess,
            live_translation::live_translation_recoveries,
            live_translation::live_translation_recover,
            live_translation::live_translation_show_subtitles,
            live_translation::live_translation_show_main,
            live_translation::live_translation_hide_main,
            live_translation::live_translation_hide_island,
            live_translation::live_translation_expand_island,
            live_translation::live_translation_update_tray,
            live_translation::live_translation_set_mode,
            meeting_detector::meeting_detector_set_config,
            meeting_detector::meeting_detector_get_state,
            recording_card::recording_card_state,
            recording_card::recording_card_scan_start,
            recording_card::recording_card_scan_stop,
            recording_card::recording_card_set_manufacturer_code,
            recording_card::recording_card_set_live_feed,
            recording_card::recording_card_connect,
            recording_card::recording_card_disconnect,
            recording_card::recording_card_query,
            recording_card::recording_card_record,
            recording_card::recording_card_list_files,
            recording_card::recording_card_download,
            recording_card::recording_card_cancel_download,
            recording_card::recording_card_delete_file,
            recording_card::recording_card_transcribe_source,
            window_effects::window_effects_mode,
            audio_editor::audio_editor_status,
            audio_editor::audio_editor_ensure_runtime,
            audio_editor::audio_editor_trim,
            audio_editor::audio_editor_merge,
            audio_editor::audio_editor_remove_silence,
            audio_editor::audio_editor_enhance_voice,
            audio_editor::audio_editor_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lynse Tauri application")
        .run(|app, event| match event {
            // Clicking the Dock icon (macOS reopen) brings the main window
            // back, matching standard macOS behaviour for tray apps. macOS
            // itself only re-activates the process; hidden/minimized windows
            // stay out of sight without this handler.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_partial_ranges() {
        assert_eq!(parse_range(Some("bytes=10-19"), 100), (10, 19, true));
        assert_eq!(parse_range(Some("bytes=10-"), 100), (10, 99, true));
        assert_eq!(parse_range(None, 100), (0, 99, false));
    }

    #[test]
    fn parses_noisy_funasr_json() {
        let parsed = parse_funasr_json("funasr version: 1.3\n{\"text\":\"ok\"}\n").unwrap();
        assert_eq!(parsed["text"], "ok");
    }

    #[test]
    fn local_media_urls_keep_the_record_id_in_the_path() {
        let id = "local:example id";
        let url = format!("local-media://localhost/{}", utf8_percent_encode(id, NON_ALPHANUMERIC));
        assert_eq!(url, "local-media://localhost/local%3Aexample%20id");
    }

    #[test]
    fn validates_calendar_event_times() {
        let (start, end) = calendar_event_times("2026-07-13T10:00:00+08:00", "2026-07-13T11:00:00+08:00").unwrap();
        assert!(end > start);
        assert!(calendar_event_times("2026-07-13T11:00:00+08:00", "2026-07-13T10:00:00+08:00").is_err());
    }

    /// Create a uniquely-named temp directory for a test and return it. The
    /// caller is responsible for cleanup.
    fn test_temp_dir(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lynse-stt-test-{name}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sha256_of_file_matches_known_hash() {
        let dir = test_temp_dir("sha");
        let file = dir.join("hello.txt");
        std::fs::write(&file, b"hello").unwrap();
        let hash = sha256_of_file(&file).unwrap();
        // SHA-256("hello")
        assert_eq!(hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_download_hash_mismatch_leaves_no_installed_artifact() {
        let dir = test_temp_dir("hashfail");
        // Simulate a finished download sitting in the `.part` file.
        let part = dir.join("model.bin.part");
        std::fs::write(&part, b"corrupted bytes").unwrap();
        let target = dir.join("model.bin");
        // Expected hash deliberately does not match the file's real hash.
        let expected = "0000000000000000000000000000000000000000000000000000000000000000";
        let result = verify_and_install(&part, &target, expected);
        assert!(result.is_err(), "hash mismatch must fail the install");
        assert!(!target.exists(), "no installed target after hash failure");
        assert!(!part.exists(), "partial file must be cleaned up after hash failure");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_and_install_succeeds_when_hash_matches() {
        let dir = test_temp_dir("hashok");
        let part = dir.join("model.bin.part");
        std::fs::write(&part, b"real model").unwrap();
        let target = dir.join("model.bin");
        let expected = sha256_of_file(&part).unwrap();
        verify_and_install(&part, &target, &expected).unwrap();
        assert!(target.exists(), "target must exist after successful install");
        assert!(!part.exists(), "partial file replaced by target");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_one_model_does_not_affect_others() {
        let root = test_temp_dir("delete");
        // Two independent model directories (e.g. whisper small vs large).
        let model_a = root.join("whisper").join("small-q5_1");
        let model_b = root.join("whisper").join("large-v3-turbo-q5_0");
        std::fs::create_dir_all(&model_a).unwrap();
        std::fs::create_dir_all(&model_b).unwrap();
        std::fs::write(model_a.join("ggml-small-q5_1.bin"), b"x").unwrap();
        let b_artifact = model_b.join("ggml-large-v3-turbo-q5_0.bin");
        std::fs::write(&b_artifact, b"y").unwrap();
        remove_model_dir(&model_a).unwrap();
        assert!(!model_a.exists(), "deleted model A directory is gone");
        assert!(model_b.exists(), "model B directory survives deletion of A");
        assert!(b_artifact.exists(), "model B artifact remains intact");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn runtime_archive_name_matches_platform() {
        let name = runtime_archive_name();
        assert!(name.starts_with("lynse-stt-runtime-"), "archive has the lynse-stt-runtime prefix");
        assert!(name.contains(stt::runtime_platform_dir()), "archive embeds the platform dir");
        assert!(name.ends_with(".tar.gz"), "archive is a gzip tarball");
    }

    #[test]
    fn runtime_download_candidates_order_mirror_then_github_then_proxies() {
        let candidates = runtime_download_candidates("v0.1.15");
        let archive = runtime_archive_name();
        let mut expected: Vec<String> = Vec::new();
        if let Some(base) = RUNTIME_MIRROR_BASE.filter(|base| !base.is_empty()) {
            expected.push(format!("{base}/v0.1.15/{archive}"));
        }
        expected.push(format!("https://github.com/{RUNTIME_REPO}/releases/download/v0.1.15/{archive}"));
        expected.push(format!("https://ghproxy.net/https://github.com/{RUNTIME_REPO}/releases/download/v0.1.15/{archive}"));
        expected.push(format!("https://mirror.ghproxy.com/https://github.com/{RUNTIME_REPO}/releases/download/v0.1.15/{archive}"));
        assert_eq!(candidates, expected);
    }
}
