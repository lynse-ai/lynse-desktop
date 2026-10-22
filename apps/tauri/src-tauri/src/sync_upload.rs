// Recording cloud-sync transport.
//
// The sync chain hands out Aliyun STS credentials plus an object key, and the
// client is expected to PUT the bytes straight to OSS. That PUT used to run in
// the webview, which put two requirements on infrastructure the desktop app
// does not control: the bucket's CORS rule had to allowlist the webview origin
// (`tauri://localhost`, or `http://127.0.0.1:5174` in dev) together with the
// `authorization` and `x-oss-security-token` request headers, and WebKit had to
// let the signature's `Date` header through — it is a forbidden header name in
// browsers and gets dropped silently. Either way the renderer saw only
// `xhr.onerror`, an opaque "network error" with nothing in the app log.
//
// Signing and sending here removes both, and leaves the target plus the
// server's response body in the log.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::{get_store_value, CommandResult};

const OSS_DATE_FORMAT: &str = "%a, %d %b %Y %H:%M:%S GMT";

/// What the renderer may ask to be uploaded: a recorded file addressed by its
/// local record id, pushed to the target the backend just signed credentials
/// for. The audio path is resolved from the store, so a compromised renderer
/// cannot point this command at an arbitrary file on disk.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedOssPut {
    pub record_id: String,
    pub bucket: String,
    pub endpoint: String,
    pub object_key: String,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub security_token: String,
    pub content_type: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedObject {
    pub size_bytes: u64,
}

/// Byte size of a record's audio, for the `fileSize` the placeholder is
/// created with — the client-direct chain never loads the bytes into the
/// renderer, so nothing else on that side knows them.
#[tauri::command]
pub fn sync_upload_audio_size(app: AppHandle, record_id: String) -> CommandResult<u64> {
    let path = recorded_audio_path(&app, &record_id)?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    Ok(metadata.len())
}

#[tauri::command]
pub async fn sync_upload_put_signed_file(
    app: AppHandle,
    put: SignedOssPut,
) -> CommandResult<UploadedObject> {
    let path = recorded_audio_path(&app, &put.record_id)?;
    let before = fs::metadata(&path).map_err(|error| error.to_string())?;
    let waveform = crate::audio_contract::waveform::cached(&path).ok();
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let after = fs::metadata(&path).map_err(|error| error.to_string())?;
    let waveform = waveform.filter(|_| before.len() == after.len()
        && before.modified().ok().is_some()
        && before.modified().ok() == after.modified().ok());
    let size_bytes = bytes.len() as u64;
    let url = oss_upload_url(&put.bucket, &put.endpoint, &put.object_key)?;
    let date = chrono::Utc::now().format(OSS_DATE_FORMAT).to_string();
    let signature = oss_v1_signature(
        &put.access_key_secret,
        &put.content_type,
        &date,
        &put.security_token,
        &put.bucket,
        &put.object_key,
    )?;

    let response = reqwest::Client::new()
        .put(url.clone())
        .header(reqwest::header::DATE, &date)
        .header(reqwest::header::CONTENT_TYPE, &put.content_type)
        .header("x-oss-security-token", &put.security_token)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("OSS {}:{}", put.access_key_id, signature),
        )
        .body(bytes)
        .send()
        .await
        .map_err(|error| {
            log::error!("[sync_upload] OSS PUT {url} failed before responding: {error}");
            format!("OSS 上传网络错误：{error}")
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        log::error!(
            "[sync_upload] OSS PUT {url} -> {status}: {}",
            truncate(&body, 800)
        );
        return Err(format!(
            "OSS 上传失败 (HTTP {}): {}",
            status.as_u16(),
            truncate(&body, 800)
        ));
    }
    log::info!("[sync_upload] OSS PUT {url} -> {status} ({size_bytes} bytes)");
    if let Some(waveform) = waveform {
        // Bind this snapshot to the uploaded object's versioned path. A later
        // local edit or a new cloud object must never reuse the old peaks.
        let mut patch = serde_json::Map::new();
        let uploaded = crate::audio_contract::waveform::UploadedWaveform {
            path: url.path().to_owned(), waveform,
        };
        if let Ok(value) = serde_json::to_value(uploaded) {
            patch.insert("uploadedWaveform".into(), value);
            if let Err(error) = crate::update_store_value(&app, "local-transcriptions", &put.record_id, patch) {
                log::warn!("Could not retain uploaded waveform: {error}");
            }
        }
    }
    Ok(UploadedObject { size_bytes })
}

/// The record's audio file, as the `local-media` handler serves it.
fn recorded_audio_path(app: &AppHandle, record_id: &str) -> CommandResult<PathBuf> {
    let record = get_store_value(app, "local-transcriptions", record_id)?
        .ok_or("本地记录不存在")?;
    let source = record
        .get("sourcePath")
        .and_then(Value::as_str)
        .ok_or("本地记录缺少音频路径")?;
    let path = PathBuf::from(source);
    if !path.is_file() {
        return Err("本地音频文件不存在或已被清理".to_owned());
    }
    Ok(path)
}

/// `https://{bucket}.{endpoint}/{objectKey}` — virtual-hosted style. The
/// backend documents `endpoint` as bare (no scheme, no bucket prefix) and owns
/// the whole `objectKey`, so the only thing assembled here is the host.
fn oss_upload_url(bucket: &str, endpoint: &str, object_key: &str) -> CommandResult<url::Url> {
    let mut url = url::Url::parse(&format!("https://{bucket}.{endpoint}/"))
        .map_err(|error| format!("OSS 上传地址无效（{bucket} / {endpoint}）：{error}"))?;
    url.path_segments_mut()
        .map_err(|_| "OSS 上传地址无效".to_owned())?
        .extend(object_key.split('/').filter(|segment| !segment.is_empty()));
    Ok(url)
}

/// OSS signature version 1: base64(HMAC-SHA1(secret, VERB \n Content-MD5 \n
/// Content-Type \n Date \n canonicalized x-oss-* headers \n /bucket/key)).
fn oss_v1_signature(
    access_key_secret: &str,
    content_type: &str,
    date: &str,
    security_token: &str,
    bucket: &str,
    object_key: &str,
) -> CommandResult<String> {
    let string_to_sign = format!(
        "PUT\n\n{content_type}\n{date}\nx-oss-security-token:{security_token}\n/{bucket}/{object_key}"
    );
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(access_key_secret.as_bytes())
        .map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_virtual_hosted_url_from_the_documented_fields() {
        let url = oss_upload_url(
            "dting-bucket",
            "oss-cn-hangzhou.aliyuncs.com",
            "recording/2084515262367154177/ab12cd34ef56.wav",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://dting-bucket.oss-cn-hangzhou.aliyuncs.com/recording/2084515262367154177/ab12cd34ef56.wav"
        );
    }

    #[test]
    fn signs_with_the_documented_string_to_sign() {
        // Cross-checked against Python: hmac.new(secret, original, sha1).digest()
        // base64-encoded over "PUT\n\naudio/wav\n<date>\nx-oss-security-token:<token>\n/<bucket>/<key>".
        let signature = oss_v1_signature(
            "secret-key",
            "audio/wav",
            "Mon, 27 Sep 2026 09:12:33 GMT",
            "sts-token",
            "dting-bucket",
            "recording/2084515262367154177/ab12cd34ef56.wav",
        )
        .unwrap();
        assert_eq!(signature, "c5aKtQpK4EjqTTYm8GO2UYoh8UA=");
    }
}
