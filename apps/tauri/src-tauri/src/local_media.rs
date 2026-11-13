//! Resolves renderer media IDs and serves files through the local-media scheme.
use crate::{
    audio_contract, cloud_audio, get_store_value, inspiration_dir, inspiration_private,
    is_safe_asset_file_name, read_array, CommandResult,
};
use percent_encoding::percent_decode_str;
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    ops::Range,
    path::{Path, PathBuf},
};
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

fn resolve_local_media_path(app: &AppHandle, id: String) -> CommandResult<PathBuf> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
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
    let path = if cloud_audio::is_cached_id(&id) && asset_file.is_none() {
        cloud_audio::path_for_id(app, &id)?
    } else if let Some(file) = id.strip_prefix("staging:") {
        if !is_safe_asset_file_name(file) {
            return Err("Unsafe local media asset name".to_owned());
        }
        data_dir.join("inspirations").join("staging").join(file)
    } else if let Some(inspiration_uuid) = id.strip_prefix("inspiration:") {
        let record =
            get_store_value(app, "local-inspirations", &id)?.ok_or("Unknown inspiration")?;
        if inspiration_private::protected(&record) {
            return Err("protected_media_requires_capability".into());
        }
        let audio = record["audio"]["file"].as_str();
        let file = asset_file
            .as_deref()
            .or(audio)
            .ok_or("Missing audio file")?;
        let image = record["images"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["file"].as_str() == Some(file)));
        if !is_safe_asset_file_name(file) || (Some(file) != audio && !image) {
            return Err("Unknown inspiration attachment".into());
        }
        inspiration_dir(app, inspiration_uuid)?.join(file)
    } else {
        let index = data_dir.join("local-transcriptions").join("index.json");
        let record = read_array(&index)?
            .into_iter()
            .find(|value| value.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .ok_or("Unknown local media id")?;
        let source = PathBuf::from(
            record
                .get("sourcePath")
                .and_then(Value::as_str)
                .ok_or("Missing source path")?,
        );
        // `<id>/<file>` on a recording picks a concrete audio track from
        // the session directory (本机/远端 per-track listening). Only
        // files listed in the record's track manifest are servable.
        match asset_file.as_deref() {
            Some(file) => {
                let allowed = record
                    .get("trackManifest")
                    .and_then(|manifest| manifest.get("tracks"))
                    .and_then(Value::as_array)
                    .map(|tracks| {
                        tracks
                            .iter()
                            .any(|track| track.get("file").and_then(Value::as_str) == Some(file))
                    })
                    .unwrap_or(false);
                if !allowed {
                    return Err("Unknown recording track".to_owned());
                }
                source
                    .parent()
                    .map(|dir| dir.join(file))
                    .ok_or("Missing session directory")?
            }
            None => source,
        }
    };
    Ok(path)
}

#[tauri::command]
pub(crate) async fn local_audio_waveform(
    app: AppHandle,
    src: String,
    record_id: Option<String>,
) -> CommandResult<audio_contract::waveform::Waveform> {
    let url = tauri::Url::parse(&src).map_err(|e| e.to_string())?;
    if !(url.scheme() == "local-media" && url.host_str() == Some("localhost"))
        && !(["http", "https"].contains(&url.scheme())
            && url.host_str() == Some("local-media.localhost"))
    {
        // The uploaded object path identifies the exact remote audio version.
        // A bare cloud id is insufficient after an edit or replacement.
        let record_id = record_id.ok_or("Only local media URLs are supported")?;
        let records = read_array(
            &app.path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("local-transcriptions")
                .join("index.json"),
        )?;
        let record = records
            .iter()
            .find(|record| {
                record.get("cloudFileId").and_then(Value::as_str) == Some(record_id.as_str())
            })
            .ok_or("No local waveform for this cloud recording")?;
        let cache = record
            .get("uploadedWaveform")
            .cloned()
            .ok_or("No waveform for this uploaded audio version")?;
        let uploaded = serde_json::from_value::<audio_contract::waveform::UploadedWaveform>(cache)
            .map_err(|e| e.to_string())?;
        return uploaded
            .for_path(url.path())
            .ok_or_else(|| "Cloud audio version changed".to_owned());
    }
    let id = percent_decode_str(url.path().trim_start_matches('/'))
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .into_owned();
    let is_cached_cloud = cloud_audio::is_cached_id(&id);
    let path = resolve_local_media_path(&app, id)?;
    tauri::async_runtime::spawn_blocking(move || {
        use audio_contract::waveform::{self, Waveform};
        if !is_cached_cloud {
            return waveform::cached(&path);
        }
        waveform::cached_with(&path, || {
            waveform::extract(&path).or_else(|_| {
                let analysis = cloud_audio::analyze(&app, &path)?;
                Ok(Waveform {
                    peaks: cloud_audio::summarize_peaks(&analysis.peaks, 256),
                    duration_ms: (analysis.duration_sec * 1000.0).round() as u64,
                })
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn respond(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = percent_decode_str(request.uri().path().trim_start_matches('/'))
        .decode_utf8()
        .ok();
    let Some(id) = id else {
        return empty_response(StatusCode::NOT_FOUND);
    };
    if id.starts_with("private-cap:") || id.starts_with("private-stage:") {
        return match inspiration_private::media_bytes(app, &id) {
            Ok((bytes, mime)) => response()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, "no-store")
                .header("Content-Security-Policy", "default-src 'none'")
                .body(bytes.to_vec())
                .unwrap(),
            Err(_) => response()
                .status(StatusCode::FORBIDDEN)
                .header(header::CACHE_CONTROL, "no-store")
                .body(Vec::new())
                .unwrap(),
        };
    }
    match resolve_local_media_path(app, id.into_owned()) {
        Ok(path) => file_response(&path, &request),
        Err(_) => empty_response(StatusCode::NOT_FOUND),
    }
}

fn response() -> tauri::http::response::Builder {
    Response::builder().header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    response().status(status).body(Vec::new()).unwrap()
}

fn file_response(path: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Ok(mut file) = File::open(path) else {
        return empty_response(StatusCode::NOT_FOUND);
    };
    let Ok(metadata) = file.metadata() else {
        return empty_response(StatusCode::NOT_FOUND);
    };
    if !metadata.is_file() {
        return empty_response(StatusCode::NOT_FOUND);
    }
    let length = metadata.len();
    let mut builder = response()
        .header(
            header::CONTENT_TYPE,
            mime_guess::from_path(path)
                .first_or_octet_stream()
                .essence_str(),
        )
        .header(header::ACCEPT_RANGES, "bytes");
    let span = match request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        Some(range) if range.starts_with("bytes=") && !range.contains(',') => {
            let Some(span) = parse_range(range, length) else {
                return builder
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                    .body(Vec::new())
                    .unwrap();
            };
            builder = builder.status(StatusCode::PARTIAL_CONTENT).header(
                header::CONTENT_RANGE,
                format!("bytes {}-{}/{length}", span.start, span.end - 1),
            );
            span
        }
        _ => 0..length,
    };
    let size = span.end - span.start;
    let mut body = Vec::new();
    if request.method() != Method::HEAD && size != 0 {
        // The custom scheme returns a byte buffer. Read only the requested
        // span, and grow with bytes read rather than zero-filling the file size.
        if file.seek(SeekFrom::Start(span.start)).is_err()
            || file.take(size).read_to_end(&mut body).is_err()
            || body.len() as u64 != size
        {
            return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
    builder
        .header(header::CONTENT_LENGTH, size)
        .body(body)
        .unwrap()
}

fn parse_range(value: &str, length: u64) -> Option<Range<u64>> {
    if length == 0 {
        return None;
    }
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let tail = end.parse::<u64>().ok().filter(|bytes| *bytes > 0)?;
        return Some(length.saturating_sub(tail)..length);
    }
    let start = start.parse::<u64>().ok().filter(|start| *start < length)?;
    let end = if end.is_empty() {
        length
    } else {
        end.parse::<u64>().ok()?.saturating_add(1).min(length)
    };
    (end > start).then_some(start..end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_closed_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=10-19", 100), Some(10..20));
        assert_eq!(parse_range("bytes=10-", 100), Some(10..100));
        assert_eq!(parse_range("bytes=-8", 100), Some(92..100));
        assert_eq!(parse_range("bytes=-200", 100), Some(0..100));
        assert_eq!(parse_range("bytes=99-150", 100), Some(99..100));
        for invalid in ["bytes=100-", "bytes=20-19", "bytes=-0", "bytes=no-4"] {
            assert_eq!(parse_range(invalid, 100), None);
        }
        assert_eq!(parse_range("bytes=0-", 0), None);
    }

    #[test]
    fn serves_tail_probe_and_head_with_matching_headers() {
        let path = std::env::temp_dir().join(format!("{}.m4a", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"0123456789").unwrap();
        let request = Request::builder()
            .header(header::RANGE, "bytes=-3")
            .body(Vec::new())
            .unwrap();
        let result = file_response(&path, &request);
        assert_eq!(result.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(result.headers()[header::CONTENT_RANGE], "bytes 7-9/10");
        assert_eq!(result.body(), b"789");
        let request = Request::builder()
            .method(Method::HEAD)
            .body(Vec::new())
            .unwrap();
        let result = file_response(&path, &request);
        assert_eq!(result.headers()[header::CONTENT_LENGTH], "10");
        assert!(result.body().is_empty());
        std::fs::write(&path, []).unwrap();
        let request = Request::new(Vec::new());
        let result = file_response(&path, &request);
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(result.headers()[header::CONTENT_LENGTH], "0");
        std::fs::remove_file(path).unwrap();
    }
}
