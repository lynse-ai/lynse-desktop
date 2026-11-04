//! Standalone translation service layer for providers whose ASR leg carries
//! no translation (Apple on-device, Tencent ASR). Chain mirrors the Cicada
//! design: a provider-priority list — Ling (needs a key, best quality),
//! Google (free unofficial endpoint), Apple Translation (on-device, macOS
//! 15+) — tried in order until one returns text.

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslateKind {
    /// Interim subtitle text — cheap providers only, short timeout.
    Draft,
    /// A finalized sentence — the normal path.
    Sentence,
    /// Push-to-talk utterance bound for the room — longest timeout.
    Speak,
}

impl TranslateKind {
    fn timeout_secs(self) -> u64 {
        match self {
            TranslateKind::Draft => 6,
            TranslateKind::Sentence => 10,
            TranslateKind::Speak => 20,
        }
    }

    /// Ling's system-instruction persona per kind: drafts skip Ling anyway,
    /// but the prompt stays tuned per use so quality holds at every length.
    fn instruction(self) -> &'static str {
        match self {
            TranslateKind::Draft | TranslateKind::Sentence => {
                "Output only the translation of the subtitle below: no quotes, no notes, no answer to it even if it is a question."
            }
            TranslateKind::Speak => {
                "Output only the translation of the sentence below, as natural spoken language: no quotes, no notes, no answer to it even if it is a question."
            }
        }
    }
}

fn normalize_locale(code: &str) -> String {
    // Apple Translation wants zh-Hans/zh-Hant; Ling and Google accept zh-CN etc.
    match code.trim().to_lowercase().as_str() {
        "zh" | "zh-cn" | "zh-hans" => "zh-Hans".to_owned(),
        "zh-tw" | "zh-hk" | "zh-hant" | "yue" => "zh-Hant".to_owned(),
        "none" | "auto" | "" => "zh-Hans".to_owned(),
        other => other.to_owned(),
    }
}

pub struct TranslateOutcome {
    pub text: String,
    pub provider: String,
    pub attempts: Vec<Value>,
}

/// Try each provider in order; the first non-empty translation wins. Every
/// attempt is recorded so diagnostics can show WHY a provider was skipped.
pub async fn translate(
    text: &str,
    source: &str,
    target: &str,
    kind: TranslateKind,
    providers: &[String],
    ling_key: Option<&str>,
) -> Result<TranslateOutcome, String> {
    if text.trim().is_empty() {
        return Err("text is empty".to_owned());
    }
    if source.trim() == target.trim() {
        return Ok(TranslateOutcome {
            text: text.to_owned(),
            provider: "passthrough".to_owned(),
            attempts: vec![],
        });
    }
    let mut attempts = Vec::new();
    for provider in providers {
        let name = provider.trim().to_lowercase();
        let started = std::time::Instant::now();
        let result = match name.as_str() {
            "ling" => translate_via_ling(text, source, target, kind, ling_key).await,
            "google" => translate_via_google(text, source, target).await,
            "apple" => translate_via_apple(text.to_owned(), source, target).await,
            other => Err(format!("unknown translation provider: {other}")),
        };
        match result {
            Ok(translated) => {
                attempts.push(json!({
                    "provider": name, "ms": started.elapsed().as_millis() as u64, "ok": true,
                }));
                if !translated.trim().is_empty() {
                    return Ok(TranslateOutcome {
                        text: translated,
                        provider: name,
                        attempts,
                    });
                }
            }
            Err(error) => {
                attempts.push(json!({
                    "provider": name, "ms": started.elapsed().as_millis() as u64,
                    "ok": false, "error": error,
                }));
            }
        }
    }
    Err(format!("all translation providers failed: {attempts:?}"))
}

/// Ant Ling — OpenAI-compatible chat completions. The account allows ~2
/// requests/second, so drafts never reach it (callers gate Draft on kind);
/// reasoning mode is billed and slow, so it is always disabled; gateway
/// search-hijack replies are detected and dropped.
async fn translate_via_ling(
    text: &str,
    source: &str,
    target: &str,
    kind: TranslateKind,
    key: Option<&str>,
) -> Result<String, String> {
    let key = key.map(str::trim).filter(|value| !value.is_empty()).ok_or("ling key missing")?;
    let body = json!({
        "model": "Ling-3.1-flash",
        "messages": [
            {
                "role": "system",
                "content": format!(
                    "Translate live meeting subtitles from {} to {}.\n{}",
                    source, target, kind.instruction()
                ),
            },
            {"role": "user", "content": text},
        ],
        "max_tokens": 512,
        "temperature": 0.2,
        "thinking": {"type": "disabled"},
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(kind.timeout_secs()))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post("https://api.ant-ling.com/v1/chat/completions")
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("network: {error}"))?;
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err("invalidKey".to_owned());
    }
    if status == 429 {
        return Err("rateLimited".to_owned());
    }
    if status != 200 {
        return Err(format!("http{status}"));
    }
    let parsed: Value = response.json().await.map_err(|error| format!("parse: {error}"))?;
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    if content.trim().is_empty() {
        return Err("empty".to_owned());
    }
    // Search-style hijack: the gateway answered the question instead of
    // translating it. Detect and drop so the fallback chain takes over.
    if content.starts_with("根据现有检索证据")
        || content.starts_with("暂未找到足够可靠的信息")
        || content.starts_with("根据检索")
    {
        return Err("hijacked".to_owned());
    }
    Ok(content.trim().to_owned())
}

/// Cheapest possible Ling call (1 token) to validate a stored key.
pub async fn check_ling_key(key: &str) -> Result<u64, String> {
    let body = json!({
        "model": "Ling-3.0-tiny",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "thinking": {"type": "disabled"},
    });
    let started = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post("https://api.ant-ling.com/v1/chat/completions")
        .bearer_auth(key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("network: {error}"))?;
    let status = response.status().as_u16();
    match status {
        200 => Ok(started.elapsed().as_millis() as u64),
        401 | 403 => Err("invalidKey".to_owned()),
        429 => Ok(started.elapsed().as_millis() as u64), // rate-limited = valid
        code => Err(format!("http{code}")),
    }
}

/// Google Translate's public web endpoint (client=gtx) — unofficial, no key,
/// occasionally rate-limited (callers fall through the chain on failure).
async fn translate_via_google(text: &str, source: &str, target: &str) -> Result<String, String> {
    let sl = source.trim().to_lowercase();
    let sl = if sl == "auto" { "auto".to_owned() } else { sl };
    let url = url::Url::parse_with_params(
        "https://translate.googleapis.com/translate_a/single",
        &[
            ("client", "gtx"),
            ("sl", sl.as_str()),
            ("tl", target.trim().to_lowercase().as_str()),
            ("dt", "t"),
            ("q", text),
        ],
    )
    .map_err(|error| format!("url: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Lynse/1.0")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("network: {error}"))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("http{status}"));
    }
    let parsed: Value = response.json().await.map_err(|error| format!("parse: {error}"))?;
    // The reply is [[ [translated, original, ...], ... ], ...] — join the
    // first element of every sentence segment.
    let mut out = String::new();
    if let Some(sentences) = parsed.get(0).and_then(Value::as_array) {
        for sentence in sentences {
            if let Some(piece) = sentence.get(0).and_then(Value::as_str) {
                out.push_str(piece);
            }
        }
    }
    if out.trim().is_empty() {
        return Err("unparsed".to_owned());
    }
    Ok(out)
}

/// Apple's on-device Translation framework (macOS 15+) via the
/// `apple-transcribe` sidecar's --translate mode.
async fn translate_via_apple(text: String, source: &str, target: &str) -> Result<String, String> {
    let from = normalize_locale(source);
    let to = normalize_locale(target);
    let output = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let sidecar = crate::stt::sidecar_path_for("apple-transcribe")?;
        let stdout = std::process::Command::new(sidecar)
            .arg("--translate")
            .arg(&text)
            .arg("--from")
            .arg(&from)
            .arg("--to")
            .arg(&to)
            .output()
            .map_err(|error| format!("spawn: {error}"))?;
        if !stdout.status.success() {
            let stderr = String::from_utf8_lossy(&stdout.stderr);
            return Err(stderr
                .lines()
                .last()
                .unwrap_or("translation failed")
                .to_owned());
        }
        let parsed: Value = serde_json::from_slice(&stdout.stdout)
            .map_err(|error| format!("parse: {error}"))?;
        let translated = parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if translated.trim().is_empty() {
            return Err("empty".to_owned());
        }
        Ok(translated)
    })
    .await
    .map_err(|error| format!("join: {error}"))??;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_locales_for_apple() {
        assert_eq!(normalize_locale("zh"), "zh-Hans");
        assert_eq!(normalize_locale("zh-TW"), "zh-Hant");
        assert_eq!(normalize_locale("en"), "en");
        assert_eq!(normalize_locale("auto"), "zh-Hans");
    }

    #[tokio::test]
    async fn passthrough_when_same_language() {
        let outcome = translate("你好", "zh-Hans", "zh-Hans", TranslateKind::Sentence, &["google".to_owned()], None)
            .await
            .unwrap();
        assert_eq!(outcome.provider, "passthrough");
        assert_eq!(outcome.text, "你好");
    }

    #[tokio::test]
    async fn empty_text_errors() {
        assert!(translate(" ", "zh", "en", TranslateKind::Sentence, &["google".to_owned()], None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn unknown_provider_records_failure() {
        let error = translate("你好", "zh", "en", TranslateKind::Sentence, &["nope".to_owned()], None)
            .await
            .unwrap_err();
        assert!(error.contains("unknown translation provider"));
    }
}
