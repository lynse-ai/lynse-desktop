//! Tencent Cloud real-time speech recognition (实时语音识别) websocket protocol.
//!
//! Lynse speaks the documented raw protocol instead of pulling in the vendor
//! SDK. Unlike the other providers, Tencent authenticates through the URL
//! itself: the query string is signed with HMAC-SHA1 over the secret key, and
//! the signature covers a `voice_id` plus a validity window. That makes the
//! URL single-use — every websocket (re)connect must mint a fresh `voice_id`
//! and re-sign — so the connection loop calls [`build_signed_url`] before each
//! attempt instead of reusing one URL for the session.
//!
//! Audio is 16 kHz 16-bit mono PCM streamed as binary frames; results arrive
//! as text frames whose `result.slice_type` marks sentence start (0), interim
//! (1) and final (2). The server closes the stream on long silence or when
//! its max utterance duration is reached (`final: 1`); the caller treats that
//! as any other drop and reconnects.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use url::Url;

/// Vendor-recommended pacing: 40 ms of 16 kHz 16-bit mono PCM per frame.
pub const CHUNK_BYTES: usize = 1_280;

/// Default websocket base; the Tencent app id is appended as the path suffix.
pub const DEFAULT_ENDPOINT: &str = "wss://asr.cloud.tencent.com/asr/v2";

/// Credentials handed over by the frontend per connection.
#[derive(Clone, Debug)]
pub struct TencentCredentials {
    pub secret_id: String,
    pub secret_key: String,
    /// Recognition engine, e.g. `16k_zh` / `16k_en` / `16k_ja` / `16k_zh-PY`.
    pub engine_type: String,
}

impl TencentCredentials {
    /// Build credentials from the connection descriptor's free-form `extra`
    /// map. `secret_id` and `secret_key` are required; `engine_type` falls
    /// back to Mandarin when absent (the frontend normally fills it).
    pub fn from_extra(extra: &HashMap<String, String>) -> Result<Self, String> {
        let secret_id = extra.get("secretId").map(String::as_str).unwrap_or("").trim().to_owned();
        let secret_key = extra.get("secretKey").map(String::as_str).unwrap_or("").trim().to_owned();
        if secret_id.is_empty() || secret_key.is_empty() {
            return Err("腾讯实时识别需要填写 SecretId 与 SecretKey".to_owned());
        }
        let engine_type = extra
            .get("engineType")
            .map(String::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        Ok(Self { secret_id, secret_key, engine_type })
    }
}

/// Percent-encode with the vendor demo's rule (Go `url.QueryEscape`): keep
/// unreserved characters, escape everything else. Applied to the base64
/// signature, whose `+ / =` would otherwise corrupt the query string.
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Build one signed websocket URL for a single recognition connection.
///
/// `base` carries the app id as its path suffix, mirroring the vendor shape
/// `wss://asr.cloud.tencent.com/asr/v2/{appid}`. The signature original is
/// `host + path + "?" + query` with the query keys sorted alphabetically —
/// [`BTreeMap`] provides the ordering.
pub fn build_signed_url(base: &str, credentials: &TencentCredentials) -> Result<String, String> {
    let url = Url::parse(base).map_err(|error| format!("腾讯实时识别地址无效：{error}"))?;
    if url.scheme() != "wss" && url.scheme() != "ws" {
        return Err("腾讯实时识别地址必须使用 wss://".to_owned());
    }
    let app_id = url.path().rsplit('/').next().unwrap_or("").trim().to_owned();
    if app_id.is_empty() {
        return Err("腾讯实时识别地址缺少 AppID（路径需形如 /asr/v2/{appid}）".to_owned());
    }
    let host = url.host_str().ok_or("腾讯实时识别地址缺少主机名")?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    // Signature validity window. Reconnects re-sign anyway, so a window well
    // inside the documented 24 h cap is plenty.
    let expired = timestamp + 6 * 60 * 60;

    let mut params = BTreeMap::new();
    params.insert("engine_type", credentials.engine_type.clone());
    params.insert("expired", expired.to_string());
    params.insert("secretid", credentials.secret_id.clone());
    params.insert("timestamp", timestamp.to_string());
    params.insert(
        "voice_id",
        uuid::Uuid::new_v4().simple().to_string(),
    );
    let query = params
        .iter()
        .map(|(key, value)| format!("{key}={}", percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");

    let original = format!("{host}{}?{query}", url.path());
    let signature = sign_original(&original, &credentials.secret_key);

    Ok(format!("{base}?{query}&signature={}", percent_encode(&signature)))
}

/// HMAC-SHA1 over the signing original, base64-encoded — the vendor's
/// documented signature scheme. Split out pure so the golden vector test can
/// pin the exact algorithm.
fn sign_original(original: &str, secret_key: &str) -> String {
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret_key.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(original.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// One result frame from the service. Only the fields Lynse consumes are
/// deserialized; unknown fields are ignored by serde.
#[derive(Clone, Debug, Deserialize)]
pub struct AsrResponse {
    /// 0 = success; anything else is a request error and the server closes.
    #[serde(default)]
    pub code: i32,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub message_id: String,
    /// `1` when the server considers the speech over and is about to close
    /// the stream.
    #[serde(default, rename = "final")]
    pub is_final: i32,
    #[serde(default)]
    pub result: Option<AsrResult>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AsrResult {
    /// 0 = sentence start, 1 = interim, 2 = sentence final.
    #[serde(default)]
    pub slice_type: i32,
    /// 0-based sentence index within this connection.
    #[serde(default)]
    pub index: i32,
    #[serde(default, rename = "voice_text_str")]
    pub voice_text: String,
    /// Milliseconds relative to the start of this connection's audio.
    #[serde(default)]
    pub start_time: i64,
    #[serde(default)]
    pub end_time: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> TencentCredentials {
        TencentCredentials {
            secret_id: "AKIDexample".to_owned(),
            secret_key: "secret-key".to_owned(),
            engine_type: "16k_zh".to_owned(),
        }
    }

    #[test]
    fn builds_url_with_sorted_params_and_signature() {
        let url = build_signed_url("wss://asr.cloud.tencent.com/asr/v2/125000000", &credentials())
            .expect("signed url");
        let (before_query, query) = url.split_once('?').expect("query string");
        assert_eq!(before_query, "wss://asr.cloud.tencent.com/asr/v2/125000000");

        let mut keys: Vec<&str> = query.split('&').map(|pair| pair.split('=').next().unwrap()).collect();
        keys.retain(|key| *key != "signature");
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(keys, sorted, "params must be alphabetical before the signature");
        assert_eq!(
            sorted,
            vec!["engine_type", "expired", "secretid", "timestamp", "voice_id"]
        );

        let signature = query
            .split('&')
            .find(|pair| pair.starts_with("signature="))
            .expect("signature param");
        let value = signature.trim_start_matches("signature=");
        assert!(!value.contains('+') && !value.contains('/') && !value.contains('='));
    }

    #[test]
    fn signs_with_hmac_sha1_base64_golden_vector() {
        // Cross-checked against Python: hmac.new(b"secret-key", original,
        // hashlib.sha1), base64-encoded.
        let original = "asr.cloud.tencent.com/asr/v2/125000000?engine_type=16k_zh\
&expired=1700000000&secretid=AKIDexample&timestamp=1699990000&voice_id=abc";
        assert_eq!(sign_original(original, "secret-key"), "28ty8js8BY1dYuhzsmlUKdD46fM=");
    }

    #[test]
    fn rejects_base_without_app_id() {
        assert!(build_signed_url("wss://asr.cloud.tencent.com/asr/v2/", &credentials()).is_err());
        assert!(build_signed_url("https://example.com/asr", &credentials()).is_err());
    }

    #[test]
    fn parses_result_frames() {
        let response: AsrResponse = serde_json::from_str(
            r#"{"code":0,"message":"success","voice_id":"v","message_id":"m-1",
                "result":{"slice_type":2,"index":0,"voice_text_str":"你好",
                          "start_time":100,"end_time":900}}"#,
        )
        .expect("parse");
        assert_eq!(response.code, 0);
        assert_eq!(response.is_final, 0);
        let result = response.result.expect("result");
        assert_eq!(result.slice_type, 2);
        assert_eq!(result.voice_text, "你好");
        assert_eq!(result.end_time, 900);
    }
}
