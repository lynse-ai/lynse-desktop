use chrono::Utc;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext};
use uuid::Uuid;

const FUNASR_MODEL_NAME: &str = "FunASR Paraformer + VAD + PUNC + CAM++";
const VOICEPRINT_MATCH_THRESHOLD: f64 = 0.31;

struct AppState {
    model_download_in_progress: Mutex<bool>,
}

type CommandResult<T> = Result<T, String>;

fn app_data_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn local_store_path(app: &AppHandle, directory: &str) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?.join(directory).join("index.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(path)
}

fn model_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?.join("local-asr-models").join("funasr");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn read_array(path: &Path) -> CommandResult<Vec<Value>> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(serde_json::from_str(&content).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_array(path: &Path, values: &[Value]) -> CommandResult<()> {
    let temporary = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(values).map_err(|error| error.to_string())?;
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn list_store(app: &AppHandle, directory: &str) -> CommandResult<Vec<Value>> {
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

fn get_store_value(app: &AppHandle, directory: &str, id: &str) -> CommandResult<Option<Value>> {
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

fn remove_store_value(app: &AppHandle, directory: &str, id: &str) -> CommandResult<()> {
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

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn script_path(app: &AppHandle) -> CommandResult<PathBuf> {
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

fn run_funasr(_app: &AppHandle, arguments: &[String], model_directory: &Path) -> CommandResult<String> {
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

fn parse_funasr_json(stdout: &str) -> CommandResult<Value> {
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

fn model_status(app: &AppHandle, downloading: bool) -> CommandResult<Value> {
    let directory = model_dir(app)?;
    Ok(json!({
        "status": if downloading { "downloading" } else if directory.join(".ready").exists() { "installed" } else { "not_installed" },
        "modelDir": directory,
        "modelName": FUNASR_MODEL_NAME
    }))
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

fn run_voiceprint_extraction(app: &AppHandle, audio_path: &str, candidates: &[Value], directory: &Path) -> CommandResult<HashMap<String, Vec<f64>>> {
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

fn create_queued_record(audio_path: &str, options: Option<&Value>) -> Value {
    let created_at = now();
    json!({
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
        "engine": "funasr",
        "segments": []
    })
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
        changed = true;
    }
    if changed {
        write_array(&path, &records)?;
    }
    Ok(())
}

fn transcribe_record(app: &AppHandle, record: Value) -> CommandResult<Value> {
    let directory = model_dir(app)?;
    if !directory.join(".ready").exists() { return Err("Local ASR model is not installed".to_owned()) }
    let id = record.get("id").and_then(Value::as_str).ok_or("Record id is required")?.to_owned();
    let started_at = now();
    let mut started = Map::new();
    started.insert("status".to_owned(), json!("transcribing"));
    started.insert("progressPhase".to_owned(), json!("transcribing"));
    started.insert("startedAt".to_owned(), json!(started_at));
    started.insert("updatedAt".to_owned(), json!(started_at));
    started.insert("error".to_owned(), Value::Null);
    update_store_value(app, "local-transcriptions", &id, started)?;

    let result: CommandResult<(String, Vec<Value>)> = (|| {
        let audio_path = record.get("sourcePath").and_then(Value::as_str).ok_or("Source path is required")?;
        let hotword_id = record.get("hotwordPackageId").and_then(Value::as_str);
        let terms = active_hotword_terms(app, hotword_id)?;
        let hotword = terms.iter().filter(|term| term.get("enabled").and_then(Value::as_bool) != Some(false))
            .filter_map(|term| term.get("term").and_then(Value::as_str)).collect::<Vec<_>>().join(" ");
        let mut args = vec![
            script_path(app)?.to_string_lossy().into_owned(), audio_path.to_owned(),
            "--model-dir".to_owned(), directory.to_string_lossy().into_owned()
        ];
        if let Some(expected) = record.get("expectedSpeakers").and_then(Value::as_i64).filter(|value| *value > 0) {
            args.extend(["--expected-speakers".to_owned(), expected.to_string()]);
        }
        if !hotword.is_empty() { args.extend(["--hotword".to_owned(), hotword]); }
        let normalized = normalize_funasr_output(parse_funasr_json(&run_funasr(app, &args, &directory)?)?);
        let transcript = apply_hotwords(value_text(normalized.get("text")), &terms);
        let mut segments = normalized.get("segments").and_then(Value::as_array).cloned().unwrap_or_default();
        for segment in &mut segments {
            if let Some(object) = segment.as_object_mut() {
                let text = value_text(object.get("text"));
                object.insert("text".to_owned(), json!(apply_hotwords(text, &terms)));
            }
        }
        apply_voiceprints(app, audio_path, &mut segments, &directory)?;
        Ok((transcript, segments))
    })();

    match result {
        Ok((transcript, segments)) => {
            let completed_at = now();
            let duration = chrono::DateTime::parse_from_rfc3339(&completed_at).ok()
                .zip(chrono::DateTime::parse_from_rfc3339(&started_at).ok())
                .map(|(end, start)| (end - start).num_milliseconds()).unwrap_or_default();
            let mut patch = Map::new();
            patch.insert("transcriptText".to_owned(), json!(transcript));
            patch.insert("segments".to_owned(), json!(segments));
            patch.insert("status".to_owned(), json!("completed"));
            patch.insert("progressPhase".to_owned(), json!("completed"));
            patch.insert("completedAt".to_owned(), json!(completed_at));
            patch.insert("updatedAt".to_owned(), json!(completed_at));
            patch.insert("durationMs".to_owned(), json!(duration));
            patch.insert("error".to_owned(), Value::Null);
            update_store_value(app, "local-transcriptions", &id, patch)?.ok_or("Local transcription record disappeared".to_owned())
        }
        Err(error) => {
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
fn local_transcription_get(app: AppHandle, id: String) -> CommandResult<Option<Value>> { get_store_value(&app, "local-transcriptions", &id) }

#[tauri::command]
fn local_transcription_delete(app: AppHandle, id: String) -> CommandResult<()> { remove_store_value(&app, "local-transcriptions", &id) }

#[tauri::command]
fn local_transcription_audio_url(app: AppHandle, id: String) -> CommandResult<Option<String>> {
    Ok(get_store_value(&app, "local-transcriptions", &id)?.map(|_| {
        format!("local-media://localhost/{}", utf8_percent_encode(&id, NON_ALPHANUMERIC))
    }))
}

#[tauri::command]
fn local_transcription_model_status(app: AppHandle, state: tauri::State<AppState>) -> CommandResult<Value> {
    let downloading = *state.model_download_in_progress.lock().map_err(|_| "Model download lock is poisoned")?;
    model_status(&app, downloading)
}

#[tauri::command]
fn local_transcription_download_model(app: AppHandle, state: tauri::State<AppState>) -> CommandResult<Value> {
    {
        let mut downloading = state.model_download_in_progress.lock().map_err(|_| "Model download lock is poisoned")?;
        if *downloading { return model_status(&app, true) }
        *downloading = true;
    }
    let result = (|| {
        let directory = model_dir(&app)?;
        let args = vec![script_path(&app)?.to_string_lossy().into_owned(), "--download-models".to_owned(), "--model-dir".to_owned(), directory.to_string_lossy().into_owned()];
        run_funasr(&app, &args, &directory)?;
        model_status(&app, false)
    })();
    if let Ok(mut downloading) = state.model_download_in_progress.lock() { *downloading = false; }
    result
}

#[tauri::command]
fn local_transcription_delete_model(app: AppHandle, state: tauri::State<AppState>) -> CommandResult<Value> {
    if *state.model_download_in_progress.lock().map_err(|_| "Model download lock is poisoned")? {
        return Err("Cannot delete while model is downloading".to_owned());
    }
    let directory = model_dir(&app)?;
    fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
    model_status(&app, false)
}

#[tauri::command]
fn local_transcription_transcribe(app: AppHandle, audio_path: String, options: Option<Value>) -> CommandResult<Value> {
    if !model_dir(&app)?.join(".ready").exists() {
        return Err("Local ASR model is not installed".to_owned());
    }
    let record = create_queued_record(&audio_path, options.as_ref());
    save_store_value(&app, "local-transcriptions", record.clone())?;
    transcribe_record(&app, record)
}

#[tauri::command]
fn local_transcription_retry(app: AppHandle, id: String) -> CommandResult<Value> {
    if !model_dir(&app)?.join(".ready").exists() {
        return Err("Local ASR model is not installed".to_owned());
    }
    let mut record = get_store_value(&app, "local-transcriptions", &id)?.ok_or("Local transcription not found")?;
    let object = record.as_object_mut().ok_or("Stored record must be an object")?;
    object.insert("transcriptText".to_owned(), json!(""));
    object.insert("segments".to_owned(), json!([]));
    object.insert("status".to_owned(), json!("queued"));
    object.insert("progressPhase".to_owned(), json!("queued"));
    object.insert("error".to_owned(), Value::Null);
    save_store_value(&app, "local-transcriptions", record.clone())?;
    transcribe_record(&app, record)
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

#[tauri::command]
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

fn media_response<R: Runtime>(context: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = request
        .uri()
        .path()
        .strip_prefix('/')
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned());
    let result = (|| -> CommandResult<(PathBuf, u64, u64, bool)> {
        let id = id.ok_or("Missing local media id")?;
        let index = context.app_handle().path().app_data_dir().map_err(|error| error.to_string())?
            .join("local-transcriptions").join("index.json");
        let record = read_array(&index)?.into_iter()
            .find(|value| value.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .ok_or("Unknown local media id")?;
        let path = PathBuf::from(record.get("sourcePath").and_then(Value::as_str).ok_or("Missing source path")?);
        let length = fs::metadata(&path).map_err(|error| error.to_string())?.len();
        let range = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
        let (start, end, partial) = parse_range(range, length);
        Ok((path, start, end, partial))
    })();
    let Ok((path, start, end, partial)) = result else {
        return Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    };
    let mut file = match File::open(&path) { Ok(file) => file, Err(_) => return Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap() };
    let length = end.saturating_sub(start).saturating_add(1);
    let mut body = vec![0; length as usize];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)).is_err() {
        return Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(Vec::new()).unwrap();
    }
    let total = fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(end + 1);
    let mut builder = Response::builder()
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { model_download_in_progress: Mutex::new(false) })
        .register_uri_scheme_protocol("local-media", media_response)
        .setup(|app| {
            if let Err(error) = migrate_electron_data(&app.handle()) {
                eprintln!("Failed to migrate Electron local data: {error}");
            }
            if let Err(error) = fail_interrupted_records(&app.handle()) {
                eprintln!("Failed to recover interrupted local transcriptions: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_transcription_list, local_transcription_get, local_transcription_delete, local_transcription_audio_url,
            local_transcription_model_status, local_transcription_download_model, local_transcription_delete_model,
            local_transcription_transcribe, local_transcription_retry, local_transcription_list_hotword_packages,
            local_transcription_save_hotword_package, local_transcription_delete_hotword_package,
            local_transcription_list_voiceprints, local_transcription_create_voiceprint,
            local_transcription_update_voiceprint, local_transcription_delete_voiceprint
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lynse Tauri application");
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
}
