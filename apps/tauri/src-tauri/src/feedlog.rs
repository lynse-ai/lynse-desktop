//! Thin native-HTTP transport for the self-hosted FeedLog suggestion board.
//!
//! The webview cannot call FeedLog directly: the anonymous guest sign-in
//! enforces better-auth's same-host origin check, and `/api/posts` carries no
//! CORS headers, so an in-page `fetch` from the `tauri://` origin is blocked
//! on both counts. Requests ride through this command instead — the same
//! escape hatch the CNB report channel uses (`cnb_report.rs`).

use serde_json::{json, Value};
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// FeedLog lives on our own zone; pin the transport to it so a compromised
/// renderer cannot abuse this command as a generic HTTP proxy. A bare-host
/// URL parses with path "/".
fn validate_base_url(base_url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(base_url).map_err(|_| "invalid feedlog base url".to_owned())?;
    let host = url.host_str().unwrap_or_default();
    let allowed = host == "lynse.ai" || host.ends_with(".lynse.ai");
    if url.scheme() != "https" || !allowed || url.path() != "/" || url.query().is_some() {
        return Err("untrusted feedlog base url".into());
    }
    Ok(url)
}

/// GET/POST JSON against the FeedLog API. Returns `{status, body}` rather
/// than failing on HTTP errors — the caller interprets 401 (expired guest
/// session) and 403 (guest posting disabled) itself.
#[tauri::command]
pub async fn feedlog_api_request(
    base_url: String,
    method: String,
    path: String,
    body: Option<Value>,
    bearer: Option<String>,
) -> Result<Value, String> {
    if !path.starts_with("/api/") || path.contains("..") {
        return Err("invalid feedlog path".into());
    }
    let method = method.to_uppercase();
    if method != "GET" && method != "POST" {
        return Err("unsupported feedlog method".into());
    }
    let base = validate_base_url(&base_url)?;
    let url = base.join(&path).map_err(|_| "invalid feedlog path".to_owned())?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = if method == "POST" {
        client.post(url)
    } else {
        client.get(url)
    };
    if let Some(token) = bearer {
        request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(payload) = body {
        request = request.json(&payload);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    Ok(json!({ "status": status, "body": parsed }))
}
