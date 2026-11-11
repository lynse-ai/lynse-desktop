use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle};
use tokio::io::AsyncWriteExt;

use crate::{app_data_dir, silent_command, stt, CommandResult};

const PREFIX: &str = "cloud-audio:";
const EXTENSIONS: &[&str] = &[
    "mp3", "wav", "m4a", "mp4", "flac", "aac", "ogg", "opus", "webm", "mov", "caf", "aiff", "amr",
];
static DOWNLOAD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudAudioKey {
    scope: String,
    file_id: String,
    revision: String,
    extension: Option<String>,
}

impl CloudAudioKey {
    fn digest(&self) -> String {
        let mut digest = Sha256::new();
        for value in [&self.scope, &self.file_id, &self.revision] {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value);
        }
        format!("{:x}", digest.finalize())
    }
}

pub(crate) fn is_cached_id(id: &str) -> bool {
    id.starts_with(PREFIX)
}

pub(crate) fn path_for_id(app: &AppHandle, id: &str) -> CommandResult<PathBuf> {
    let filename = id.strip_prefix(PREFIX).ok_or("Invalid cached audio ID")?;
    let (digest, ext) = filename.split_once('.').ok_or("Invalid cached audio ID")?;
    if digest.len() != 64
        || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !EXTENSIONS.contains(&ext)
    {
        return Err("Invalid cached audio ID".into());
    }
    Ok(app_data_dir(app)?.join("cloud-audio").join(filename))
}

fn is_downloaded(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

#[tauri::command]
pub(crate) fn cloud_audio_get(app: AppHandle, key: CloudAudioKey) -> CommandResult<Option<String>> {
    let dir = app_data_dir(&app)?.join("cloud-audio");
    Ok(find_download(&dir, &key.digest()))
}

fn find_download(dir: &Path, digest: &str) -> Option<String> {
    EXTENSIONS.iter().find_map(|ext| {
        let filename = format!("{digest}.{ext}");
        is_downloaded(&dir.join(&filename)).then(|| format!("{PREFIX}{filename}"))
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudAudioProgress {
    received_bytes: u64,
    total_bytes: Option<u64>,
}

#[tauri::command]
pub(crate) async fn cloud_audio_download(
    app: AppHandle,
    key: CloudAudioKey,
    url: String,
    on_progress: Channel<CloudAudioProgress>,
) -> CommandResult<String> {
    let dir = app_data_dir(&app)?.join("cloud-audio");
    let digest = key.digest();
    let _download = DOWNLOAD.lock().await;
    if let Some(id) = find_download(&dir, &digest) {
        return Ok(id);
    }
    let ext = key
        .extension
        .as_deref()
        .filter(|ext| EXTENSIONS.contains(ext))
        .unwrap_or("m4a");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| error.without_url().to_string())?;
    let path = download_to(
        &client,
        &url,
        &dir.join(format!("{digest}.{ext}")),
        |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid cached audio filename")?;
    Ok(format!("{PREFIX}{filename}"))
}

struct PartialDownload(PathBuf);

impl Drop for PartialDownload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn download_to(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    mut progress: impl FnMut(CloudAudioProgress),
) -> CommandResult<PathBuf> {
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid audio URL")?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid audio URL".into());
    }
    let object_extension = Path::new(url.path())
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|ext| EXTENSIONS.contains(&ext.as_str()));
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.without_url().to_string())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("The audio server did not return a complete file".into());
    }
    // The display title may have no suffix. Use the object name and response
    // type so local-media serves the right codec for that original file.
    let hinted_ext = object_extension
        .as_deref()
        .or_else(|| path.extension()?.to_str())
        .unwrap_or("m4a");
    let content_exts = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|mime| mime_guess::get_mime_extensions_str(mime.split(';').next()?.trim()));
    let ext = match content_exts {
        Some(exts) if !exts.contains(&hinted_ext) => exts
            .iter()
            .copied()
            .find(|ext| EXTENSIONS.contains(ext))
            .unwrap_or(hinted_ext),
        _ => hinted_ext,
    };
    let path = path.with_extension(ext);
    let total_bytes = response.content_length().filter(|bytes| *bytes > 0);
    let dir = path.parent().ok_or("Invalid audio cache path")?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|error| error.to_string())?;
    let staging = PartialDownload(dir.join(format!("{}.part", uuid::Uuid::new_v4())));
    let mut file = tokio::fs::File::create(&staging.0)
        .await
        .map_err(|error| error.to_string())?;
    let mut received_bytes = 0;
    let mut last_update = Instant::now();
    progress(CloudAudioProgress {
        received_bytes,
        total_bytes,
    });
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| error.without_url().to_string())?
    {
        file.write_all(&chunk)
            .await
            .map_err(|error| error.to_string())?;
        received_bytes += chunk.len() as u64;
        if last_update.elapsed() >= Duration::from_millis(100) {
            progress(CloudAudioProgress {
                received_bytes,
                total_bytes,
            });
            last_update = Instant::now();
        }
    }
    if received_bytes == 0 || total_bytes.is_some_and(|total| received_bytes != total) {
        return Err("The audio download was incomplete".into());
    }
    file.sync_all().await.map_err(|error| error.to_string())?;
    drop(file);
    tokio::fs::rename(&staging.0, &path)
        .await
        .map_err(|error| error.to_string())?;
    progress(CloudAudioProgress {
        received_bytes,
        total_bytes,
    });
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudAudioAnalysis {
    pub duration_sec: f64,
    pub peaks: Vec<f32>,
    silence_segments: Vec<SilenceSegment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SilenceSegment {
    start_sec: f64,
    end_sec: f64,
}

/// Decode the actual cached audio at speech resolution without buffering an
/// entire meeting in the webview. Each 100 ms peak uses two 50 ms PCM windows.
pub(crate) fn analyze(app: &AppHandle, path: &Path) -> CommandResult<CloudAudioAnalysis> {
    let ffmpeg = stt::sidecar_path(app, "ffmpeg")?;
    // CREATE_NO_WINDOW on Windows — a bare spawn flashes a console over the
    // app while the audio is analyzed (issue #25).
    let mut child = silent_command(ffmpeg)
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(path)
        .args([
            "-map", "0:a:0", "-ac", "2", "-ar", "8000", "-f", "s16le", "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().expect("ffmpeg stdout is piped");
    let analysis = analyze_pcm(BufReader::new(stdout));
    let exit = child.wait().map_err(|error| error.to_string())?;
    if !exit.success() {
        return Err("Could not decode the downloaded audio".into());
    }
    analysis
}

fn analyze_pcm(mut input: impl Read) -> CommandResult<CloudAudioAnalysis> {
    const SAMPLES_PER_SEC: f64 = 16_000.0;
    const WINDOW_BYTES: usize = 1600;
    const MAX_BARS: usize = 72_000;
    let threshold = 10.0_f64.powf(-35.0 / 20.0);
    let mut block = Vec::with_capacity(WINDOW_BYTES);
    let mut samples_read = 0;
    let mut peaks: Vec<f32> = Vec::new();
    let mut silence_segments = Vec::new();
    let mut silent_start = None;
    let mut first_half = true;
    loop {
        block.clear();
        if input
            .by_ref()
            .take(WINDOW_BYTES as u64)
            .read_to_end(&mut block)
            .map_err(|error| error.to_string())?
            == 0
        {
            break;
        }
        let mut energy = 0.0;
        let mut peak = 0.0_f32;
        let samples = block.len() / 2;
        for sample in block.chunks_exact(2) {
            let amplitude = f32::from(i16::from_le_bytes([sample[0], sample[1]])) / 32768.0;
            energy += f64::from(amplitude * amplitude);
            peak = peak.max(amplitude.abs());
        }
        if first_half {
            peaks.push(peak);
        } else if let Some(last) = peaks.last_mut() {
            *last = last.max(peak);
        }
        first_half = !first_half;
        let seconds = samples_read as f64 / SAMPLES_PER_SEC;
        if energy < threshold * threshold * samples as f64 {
            silent_start.get_or_insert(seconds);
        } else {
            add_silence(&mut silence_segments, silent_start.take(), seconds);
        }
        samples_read += samples;
    }
    if samples_read == 0 {
        return Err("The downloaded file contains no audio samples".into());
    }
    let duration_sec = samples_read as f64 / SAMPLES_PER_SEC;
    add_silence(&mut silence_segments, silent_start, duration_sec);
    let peaks = summarize_peaks(&peaks, MAX_BARS);
    Ok(CloudAudioAnalysis {
        duration_sec,
        peaks,
        silence_segments,
    })
}

fn add_silence(segments: &mut Vec<SilenceSegment>, start_sec: Option<f64>, end_sec: f64) {
    if let Some(start_sec) = start_sec.filter(|start_sec| end_sec - start_sec >= 0.6) {
        segments.push(SilenceSegment { start_sec, end_sec });
    }
}

pub(crate) fn summarize_peaks(peaks: &[f32], bars: usize) -> Vec<f32> {
    if peaks.len() <= bars {
        return peaks.to_vec();
    }
    (0..bars)
        .map(|index| {
            let start = index * peaks.len() / bars;
            let end = (index + 1) * peaks.len() / bars;
            peaks[start..end].iter().copied().fold(0.0, f32::max)
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn cloud_audio_analyze(
    app: AppHandle,
    id: String,
) -> CommandResult<CloudAudioAnalysis> {
    let path = path_for_id(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || analyze(&app, &path))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    async fn serve_audio(
        body: &'static [u8],
        size: usize,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}/audio", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(5), async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut reader = tokio::io::BufReader::new(stream);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap() != 0 && line != "\r\n" {
                    line.clear();
                }
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"
                );
                reader.get_mut().write_all(header.as_bytes()).await.unwrap();
                for chunk in body.chunks(4) {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    reader.get_mut().write_all(chunk).await.unwrap();
                }
            })
            .await
            .unwrap();
        });
        (url, server)
    }

    #[tokio::test]
    async fn transfer_reports_bytes_and_publishes_only_the_complete_file() {
        let dir = std::env::temp_dir().join(format!("lynse-cloud-audio-{}", uuid::Uuid::new_v4()));
        let path = dir.join("original.m4a");
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let (url, server) = serve_audio(b"part", 8).await;
        assert!(download_to(&client, &url, &path, |_| {}).await.is_err());
        server.await.unwrap();
        assert!(!is_downloaded(&path));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);

        let (url, server) = serve_audio(b"complete", 8).await;
        let mut updates = Vec::new();
        download_to(&client, &url, &path, |progress| {
            if progress.received_bytes < 8 {
                assert!(!path.exists());
            }
            assert_eq!(progress.total_bytes, Some(8));
            updates.push(progress.received_bytes);
        })
        .await
        .unwrap();
        server.await.unwrap();
        assert!(updates.contains(&4));
        assert_eq!(updates.last(), Some(&8));
        assert_eq!(std::fs::read(&path).unwrap(), b"complete");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn waveform_uses_the_entire_audio_and_keeps_silence() {
        let mut pcm = vec![0; 16_000 * 2];
        pcm.extend((0..8_000).flat_map(|_| 16_384_i16.to_le_bytes()));
        let analysis = analyze_pcm(pcm.as_slice()).unwrap();
        assert_eq!(analysis.duration_sec, 1.5);
        assert_eq!(&analysis.peaks[..10], &[0.0; 10]);
        assert_eq!(&analysis.peaks[10..], &[0.5; 5]);
        assert_eq!(analysis.silence_segments.len(), 1);
        assert_eq!(analysis.silence_segments[0].end_sec, 1.0);
    }
}
