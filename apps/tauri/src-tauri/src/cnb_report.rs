//! Problem-report submission: the CloudBase `cnb-report` function files the
//! issue on CNB server-side.
//!
//! The CNB token never leaves the function. The gateway in front of the
//! function caps request bodies at ~64 KB, so a multi-MB screenshot cannot
//! ride in the report POST: the client first asks the function for a
//! presigned CNB asset slot, PUTs the screenshot bytes straight to that URL
//! (no credentials involved), then submits the report referencing the
//! uploaded asset.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{command, AppHandle};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_SCREENSHOT_BYTES: usize = 12 * 1024 * 1024;
// Headroom under the ~64 KB gateway body cap.
const MAX_BODY_BYTES: usize = 48 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CnbIssueRequest {
    /// CloudBase `cnb-report` function that files reports (build-time config).
    pub endpoint: String,
    pub title: String,
    pub body: String,
    /// Optional staged screenshot path (must live inside the app staging dir).
    #[serde(default)]
    pub screenshot_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CnbIssueResult {
    pub number: i64,
}

/// Only https endpoints on the CloudBase access-service hosts (the env's
/// default domain or the custom dl.lynse.cn mapping), no credentials in the
/// URL — keeps this command from becoming a generic GET/POST proxy.
fn validate_endpoint(endpoint: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "invalid report endpoint".to_owned())?;
    let host = url.host_str().unwrap_or_default();
    let allowed = host.ends_with(".service.tcloudbase.com") || host == "dl.lynse.cn";
    if url.scheme() != "https"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        // A bare-host URL parses with path "/"; the function always sits
        // under a route.
        || url.path() == "/"
    {
        return Err("untrusted report endpoint".into());
    }
    Ok(url)
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())
}

/// POST a JSON payload to the report function and parse the JSON response,
/// surfacing the function's error body on failure.
async fn post_json(
    client: &reqwest::Client,
    url: reqwest::Url,
    body: &impl serde::Serialize,
) -> Result<Value, String> {
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|error| format!("report channel unreachable: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("report channel response unreadable ({status}): {error}"))?;
    if !status.is_success() {
        let hint: String = text.chars().take(300).collect();
        return Err(format!("report channel rejected the request ({status}): {hint}"));
    }
    serde_json::from_str(&text).map_err(|error| format!("report channel response malformed: {error}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadSlotRequest<'a> {
    action: &'a str,
    size: usize,
    content_type: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSlot {
    upload_url: String,
    download_url: String,
}

/// Reserve a CNB asset slot via the function, then PUT the bytes to the
/// presigned URL (the Authorization header must not ride along) and return
/// the repo-scoped URL that serves the image.
async fn upload_screenshot(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
    bytes: &[u8],
) -> Result<String, String> {
    let slot: UploadSlot = serde_json::from_value(
        post_json(
            client,
            endpoint.clone(),
            &UploadSlotRequest {
                action: "upload",
                size: bytes.len(),
                content_type: "image/jpeg",
            },
        )
        .await?,
    )
    .map_err(|error| format!("report channel response malformed: {error}"))?;

    client
        .put(&slot.upload_url)
        .header("Content-Type", "image/jpeg")
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|error| format!("screenshot upload failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("screenshot upload rejected: {error}"))?;
    Ok(slot.download_url)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmitIssueRequest<'a> {
    title: &'a str,
    body: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    screenshot_url: Option<&'a str>,
}

/// Read the staged screenshot back, refusing anything outside the staging
/// folder — the renderer only ever passes paths the capture command returned,
/// but the check keeps this flow from becoming an arbitrary-file reader.
fn read_staged_screenshot(app: &AppHandle, path: &str) -> Result<Vec<u8>, String> {
    let staging = crate::inspiration_staging_dir(app)?;
    let candidate = std::path::PathBuf::from(path);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "screenshot file is gone".to_owned())?;
    let staging_root = staging.canonicalize().unwrap_or(staging);
    if !canonical.starts_with(&staging_root) {
        return Err("screenshot path is outside the staging folder".into());
    }
    let bytes = std::fs::read(&canonical).map_err(|error| format!("screenshot unreadable: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err("screenshot size out of range".into());
    }
    Ok(bytes)
}

/// CNB returns the issue number as a string ("42").
fn parse_issue_number(issue: &Value) -> Result<i64, String> {
    match issue.get("number") {
        Some(Value::Number(number)) => number
            .as_i64()
            .ok_or_else(|| "CNB issue number out of range".into()),
        Some(Value::String(number)) => number
            .parse::<i64>()
            .map_err(|_| "CNB issue number malformed".into()),
        _ => Err("CNB issue response missing number".into()),
    }
}

/// Submit the report through the CloudBase function, which files the issue on
/// CNB with its own credentials. A screenshot failure degrades to a note in
/// the body — the text report still lands.
#[command]
pub async fn report_submit_cnb_issue(
    app: AppHandle,
    req: CnbIssueRequest,
) -> Result<CnbIssueResult, String> {
    let endpoint = validate_endpoint(&req.endpoint)?;
    let title = req.title.trim();
    let body = req.body.trim();
    if title.is_empty() || body.is_empty() || body.len() > MAX_BODY_BYTES {
        return Err("report title and body are required".into());
    }

    let client = api_client()?;

    // Keep the screenshot failure non-fatal: submit the text with a note.
    let mut body = body.to_owned();
    let mut screenshot_url: Option<String> = None;
    if let Some(path) = req.screenshot_path.as_deref() {
        match read_staged_screenshot(&app, path) {
            Ok(bytes) => match upload_screenshot(&client, &endpoint, &bytes).await {
                Ok(url) => screenshot_url = Some(url),
                Err(error) => {
                    log::warn!("[cnb-report] screenshot upload failed, submitting text only: {error}");
                    body.push_str(&format!(
                        "\n\n> 截图上传失败 / screenshot upload failed: {error}\n"
                    ));
                }
            },
            Err(error) => {
                log::warn!("[cnb-report] screenshot unreadable, submitting text only: {error}");
                body.push_str(&format!(
                    "\n\n> 截图读取失败 / screenshot unavailable: {error}\n"
                ));
            }
        }
    }

    let issue = post_json(
        &client,
        endpoint,
        &SubmitIssueRequest {
            title,
            body: body.trim_end(),
            screenshot_url: screenshot_url.as_deref(),
        },
    )
    .await?;
    let number = parse_issue_number(&issue)?;
    Ok(CnbIssueResult { number })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_accept_cloudbase_hosts_and_reject_others() {
        assert!(validate_endpoint("https://lynse-d8g49o1i956741f9e.service.tcloudbase.com/cnb-report").is_ok());
        assert!(validate_endpoint("https://dl.lynse.cn/cnb-report").is_ok());
        for endpoint in [
            "",
            "http://lynse-d8g49o1i956741f9e.service.tcloudbase.com/cnb-report",
            "https://evil.test/cnb-report",
            "https://service.tcloudbase.com.evil.test/cnb-report",
            "https://user:pw@lynse-d8g49o1i956741f9e.service.tcloudbase.com/cnb-report",
            "https://lynse-d8g49o1i956741f9e.service.tcloudbase.com",
        ] {
            assert!(validate_endpoint(endpoint).is_err(), "accepted {endpoint}");
        }
    }

    #[test]
    fn issue_numbers_parse_from_int_and_string() {
        let parse = |value: &str| parse_issue_number(&serde_json::from_str(value).unwrap()).unwrap();
        assert_eq!(parse(r#"{"number": 42}"#), 42);
        assert_eq!(parse(r#"{"number": "42"}"#), 42);
        assert!(parse_issue_number(&serde_json::from_str("{}").unwrap()).is_err());
        assert!(parse_issue_number(&serde_json::from_str(r#"{"number": "x"}"#).unwrap()).is_err());
    }

    /// The function treats an absent `screenshotUrl` as text-only and a null
    /// one as invalid — the submit payload must omit the key entirely.
    #[test]
    fn submit_request_omits_absent_screenshot_url() {
        let value = serde_json::to_value(&SubmitIssueRequest {
            title: "t",
            body: "b",
            screenshot_url: None,
        })
        .unwrap();
        assert!(value.get("screenshotUrl").is_none());
        let value = serde_json::to_value(&SubmitIssueRequest {
            title: "t",
            body: "b",
            screenshot_url: Some("https://cnb.cool/x"),
        })
        .unwrap();
        assert_eq!(value["screenshotUrl"], "https://cnb.cool/x");
    }
}
