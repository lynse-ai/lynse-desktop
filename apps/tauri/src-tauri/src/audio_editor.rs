// Audio editing for local note recordings: trim, merge, silence removal and
// voice enhancement. All processing runs through the shared on-demand FFmpeg
// runtime (the same binary set the offline STT engines use), so no new
// binaries ship with the app. Each export lands in
// `app_data/audio-edits/<uuid>.m4a` and is registered as a local
// transcription record, which makes it show up in the notes list, playable
// via `local-media://`, and available for offline transcription.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::{ensure_runtime_available, local_store_path, now, read_array, stt, CommandResult};

/// Only one ffmpeg job may run at a time from the editor page.
static JOB_ID: AtomicU32 = AtomicU32::new(0);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
static CHILD_PID: Mutex<Option<u32>> = Mutex::new(None);

fn ffmpeg_path(app: &AppHandle) -> CommandResult<PathBuf> {
    stt::sidecar_path(app, "ffmpeg")
}

fn edits_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("audio-edits");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn emit_progress(app: &AppHandle, job_id: u32, phase: &str, detail: Option<&str>) {
    let _ = app.emit(
        "audio-editor-progress",
        json!({ "jobId": job_id, "phase": phase, "detail": detail }),
    );
}

/// Run ffmpeg, polling so a cancel request can kill the child promptly.
/// Returns Err("cancelled") when the user aborted.
fn run_ffmpeg(app: &AppHandle, job_id: u32, args: &[String]) -> CommandResult<()> {
    let ffmpeg = ffmpeg_path(app)?;
    let mut child = Command::new(&ffmpeg)
        .args(args)
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?;
    if let Ok(mut slot) = CHILD_PID.lock() {
        *slot = Some(child.id());
    }
    let result = loop {
        // Drain stderr so a chatty filter graph never fills the pipe buffer.
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break if status.success() { Ok(()) } else { Err("FFmpeg 处理音频失败".to_owned()) };
        }
        if CANCELLED.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            break Err("cancelled".to_owned());
        }
        emit_progress(app, job_id, "processing", None);
        std::thread::sleep(Duration::from_millis(200));
    };
    if let Ok(mut slot) = CHILD_PID.lock() {
        *slot = None;
    }
    result
}

/// Begin a job; errors when another one is still running.
fn begin_job() -> CommandResult<u32> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("已有音频处理任务在进行中".to_owned());
    }
    CANCELLED.store(false, Ordering::SeqCst);
    Ok(JOB_ID.fetch_add(1, Ordering::SeqCst) + 1)
}

fn end_job() {
    RUNNING.store(false, Ordering::SeqCst);
}

/// Register the exported file as a local transcription record so it appears
/// in the notes list and can be transcribed from there. The record starts
/// "completed" with an empty transcript — the notes page offers transcription.
fn register_export(app: &AppHandle, output: &Path, duration_ms: Option<u64>) -> CommandResult<Value> {
    let id = format!("local:{}", uuid::Uuid::new_v4());
    let timestamp = now();
    let record = json!({
        "id": id,
        "title": output.file_name().and_then(|v| v.to_str()).unwrap_or("audio-edit.m4a"),
        "sourcePath": output.to_string_lossy(),
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "transcriptText": "",
        "status": "completed",
        "progressPhase": "completed",
        "engine": "funasr",
        "modelId": "funasr-paraformer",
        "segments": [],
        "durationMs": duration_ms,
    });
    let path = local_store_path(app, "local-transcriptions")?;
    let mut records = read_array(&path)?;
    records.push(record.clone());
    crate::write_array(&path, &records)?;
    Ok(record)
}

/// Probe duration in ms via ffprobe (best effort).
fn probe_duration_ms(app: &AppHandle, path: &str) -> Option<u64> {
    let ffprobe = stt::sidecar_path(app, "ffprobe").ok()?;
    let output = Command::new(&ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().parse::<f64>().ok().map(|s| (s * 1000.0) as u64)
}

/// Resolve a source reference into a playable path. Accepts either a plain
/// filesystem path or a `local:<uuid>` record id (the notes page passes ids).
fn resolve_source(app: &AppHandle, source: &str) -> CommandResult<PathBuf> {
    if let Some(id) = source.strip_prefix("local:") {
        let index = local_store_path(app, "local-transcriptions")?;
        let record = read_array(&index)?
            .into_iter()
            .find(|value| value.get("id").and_then(Value::as_str) == Some(&format!("local:{id}")))
            .ok_or("找不到指定的本地音频记录")?;
        return PathBuf::from(
            record
                .get("sourcePath")
                .and_then(Value::as_str)
                .ok_or("本地音频记录缺少源文件路径")?,
        )
        .canonicalize()
        .map_err(|error| error.to_string());
    }
    PathBuf::from(source).canonicalize().map_err(|error| error.to_string())
}

fn output_path(app: &AppHandle, out_name: Option<&str>, suffix: &str) -> CommandResult<PathBuf> {
    let base = out_name
        .map(|name| name.trim())
        .filter(|name| !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains(".."))
        .map(|name| name.trim_end_matches(".m4a").to_owned())
        .unwrap_or_else(|| format!("audio-edit-{suffix}"));
    Ok(edits_dir(app)?.join(format!("{}-{}.m4a", base, uuid::Uuid::new_v4().simple())))
}

#[tauri::command]
pub(crate) fn audio_editor_status(app: AppHandle) -> CommandResult<Value> {
    let available = ffmpeg_path(&app).is_ok();
    Ok(json!({ "ffmpegAvailable": available }))
}

/// Ensure the shared FFmpeg runtime is present, downloading it on first use.
/// Download progress is reported on the existing `stt-download-progress`
/// channel with provider "editor", which the editor page listens for.
#[tauri::command(async)]
pub(crate) async fn audio_editor_ensure_runtime(app: AppHandle) -> CommandResult<Value> {
    if ffmpeg_path(&app).is_ok() {
        return Ok(json!({ "ffmpegAvailable": true }));
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_runtime_available(&handle, "editor", "ffmpeg"))
        .await
        .map_err(|error| error.to_string())??;
    Ok(json!({ "ffmpegAvailable": ffmpeg_path(&app).is_ok() }))
}

#[tauri::command(async)]
pub(crate) async fn audio_editor_trim(
    app: AppHandle,
    source: String,
    start_sec: f64,
    end_sec: f64,
    out_name: Option<String>,
) -> CommandResult<Value> {
    run_job(app.clone(), move |app, job_id| {
        if end_sec <= start_sec {
            return Err("选区无效：结束时间必须晚于开始时间".to_owned());
        }
        let input = resolve_source(app, &source)?;
        let output = output_path(app, out_name.as_deref(), "clip")?;
        let args = vec![
            "-y".to_owned(),
            "-ss".to_owned(), start_sec.to_string(),
            "-to".to_owned(), end_sec.to_string(),
            "-i".to_owned(), input.to_string_lossy().into_owned(),
            "-c:a".to_owned(), "aac".to_owned(),
            "-b:a".to_owned(), "192k".to_owned(),
            output.to_string_lossy().into_owned(),
        ];
        run_ffmpeg(app, job_id, &args)?;
        Ok((output, probe_duration_ms(app, &input.to_string_lossy())))
    })
    .await
}

#[tauri::command(async)]
pub(crate) async fn audio_editor_merge(
    app: AppHandle,
    sources: Vec<String>,
    out_name: Option<String>,
) -> CommandResult<Value> {
    run_job(app.clone(), move |app, job_id| {
        if sources.len() < 2 {
            return Err("合并至少需要两个音频文件".to_owned());
        }
        let inputs: Vec<PathBuf> = sources.iter().map(|s| resolve_source(app, s)).collect::<CommandResult<_>>()?;
        let output = output_path(app, out_name.as_deref(), "merged")?;
        // Concat demuxer needs a UTF-8 list file; single-file lines with no
        // quoting pitfalls (paths are canonicalized absolute paths).
        let list = edits_dir(app)?.join(format!("concat-{}.txt", uuid::Uuid::new_v4().simple()));
        let content = inputs
            .iter()
            .map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''")))
            .collect::<String>();
        std::fs::write(&list, content).map_err(|error| error.to_string())?;
        let result: CommandResult<()> = (|| {
            let args = vec![
                "-y".to_owned(),
                "-f".to_owned(), "concat".to_owned(),
                "-safe".to_owned(), "0".to_owned(),
                "-i".to_owned(), list.to_string_lossy().into_owned(),
                "-c:a".to_owned(), "aac".to_owned(),
                "-b:a".to_owned(), "192k".to_owned(),
                "-ar".to_owned(), "44100".to_owned(),
                output.to_string_lossy().into_owned(),
            ];
            run_ffmpeg(app, job_id, &args)?;
            Ok(())
        })();
        let _ = std::fs::remove_file(&list);
        result?;
        let total_ms: u64 = inputs
            .iter()
            .filter_map(|p| probe_duration_ms(app, &p.to_string_lossy()))
            .sum();
        Ok((output, Some(total_ms)))
    })
    .await
}

#[tauri::command(async)]
pub(crate) async fn audio_editor_remove_silence(
    app: AppHandle,
    source: String,
    threshold_db: Option<f64>,
    min_silence_sec: Option<f64>,
    padding_sec: Option<f64>,
    out_name: Option<String>,
) -> CommandResult<Value> {
    run_job(app.clone(), move |app, job_id| {
        let input = resolve_source(app, &source)?;
        let output = output_path(app, out_name.as_deref(), "desilenced")?;
        let threshold = threshold_db.unwrap_or(-35.0);
        let min_silence = min_silence_sec.unwrap_or(0.6).max(0.1);
        let padding = padding_sec.unwrap_or(0.25).min(min_silence / 2.0).max(0.0);
        // `stop_periods=-1` removes every silent span; `stop_duration` keeps
        // short pauses intact and `stop_silence` retains a padding sliver so
        // word onsets are never clipped.
        let filter = format!(
            "silenceremove=stop_periods=-1:stop_duration={min_silence}:stop_threshold={threshold}dB:stop_silence={padding}"
        );
        let args = vec![
            "-y".to_owned(),
            "-i".to_owned(), input.to_string_lossy().into_owned(),
            "-af".to_owned(), filter,
            "-c:a".to_owned(), "aac".to_owned(),
            "-b:a".to_owned(), "192k".to_owned(),
            output.to_string_lossy().into_owned(),
        ];
        run_ffmpeg(app, job_id, &args)?;
        let duration_ms = probe_duration_ms(app, &output.to_string_lossy());
        Ok((output, duration_ms))
    })
    .await
}

#[tauri::command(async)]
pub(crate) async fn audio_editor_enhance_voice(
    app: AppHandle,
    source: String,
    out_name: Option<String>,
) -> CommandResult<Value> {
    run_job(app.clone(), move |app, job_id| {
        let input = resolve_source(app, &source)?;
        let output = output_path(app, out_name.as_deref(), "enhanced")?;
        // Speech chain: cut rumble below 80 Hz, FFT denoise, then two-pass
        // loudness normalization for a consistent, present vocal level.
        let filter = "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11";
        let args = vec![
            "-y".to_owned(),
            "-i".to_owned(), input.to_string_lossy().into_owned(),
            "-af".to_owned(), filter.to_owned(),
            "-ar".to_owned(), "44100".to_owned(),
            "-c:a".to_owned(), "aac".to_owned(),
            "-b:a".to_owned(), "192k".to_owned(),
            output.to_string_lossy().into_owned(),
        ];
        run_ffmpeg(app, job_id, &args)?;
        Ok((output, probe_duration_ms(app, &input.to_string_lossy())))
    })
    .await
}

#[tauri::command]
pub(crate) fn audio_editor_cancel() -> CommandResult<()> {
    if RUNNING.load(Ordering::SeqCst) {
        CANCELLED.store(true, Ordering::SeqCst);
        if let Ok(slot) = CHILD_PID.lock() {
            if let Some(pid) = *slot {
                #[cfg(target_os = "windows")]
                let status = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status();
                #[cfg(not(target_os = "windows"))]
                let status = Command::new("kill").arg(pid.to_string()).status();
                if let Ok(status) = status {
                    if !status.success() {
                        log::warn!("failed to kill ffmpeg pid {pid}");
                    }
                }
            }
        }
    }
    Ok(())
}

/// Shared wrapper: acquire the single job slot, run the ffmpeg work off the
/// main thread, then register the export as a notes-visible record. Maps the
/// internal "cancelled" sentinel to a user-facing error.
async fn run_job<F>(app: AppHandle, work: F) -> CommandResult<Value>
where
    F: FnOnce(&AppHandle, u32) -> CommandResult<(PathBuf, Option<u64>)> + Send + 'static,
{
    let job_id = begin_job()?;
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        emit_progress(&handle, job_id, "processing", None);
        let result = work(&handle, job_id)
            .and_then(|(output, duration_ms)| register_export(&handle, &output, duration_ms));
        match &result {
            Ok(_) => emit_progress(&handle, job_id, "done", None),
            Err(error) => emit_progress(&handle, job_id, "error", Some(error)),
        }
        result
    })
    .await
    .map_err(|error| error.to_string());
    end_job();
    match result {
        Err(e) => Err(e),
        Ok(Err(e)) if e == "cancelled" => Err("已取消".to_owned()),
        Ok(other) => other,
    }
}
