//! Problem-report submission: direct to CNB with credentials from CloudBase.
//!
//! The CloudBase `cnb-report` function owns the CNB access token (nothing
//! CNB-related ships in the client build) and hands out `{repo, token}` on a
//! GET. The report itself cannot proxy through that gateway — its request
//! body cap measured at ~64 KB — so the multi-MB screenshot and the issue
//! creation go straight to api.cnb.cool from here, with short-lived-ish
//! credentials fetched fresh per submission.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{command, AppHandle};

const CNB_API_BASE: &str = "https://api.cnb.cool";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_SCREENSHOT_BYTES: usize = 12 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CnbIssueRequest {
    /// CloudBase `cnb-report` function URL handing out the channel
    /// credentials (build-time config).
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

#[derive(Debug, Deserialize)]
struct ReportTicket {
    repo: String,
    token: String,
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

/// The repo slug arrives from the ticket response and is spliced into CNB
/// URLs, so confine it to `org/repo` shape before building anything.
fn validate_repo(repo: &str) -> Result<(), String> {
    let mut parts = repo.split('/');
    let (Some(group), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(format!("invalid repo slug: {repo}"));
    };
    let ok = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && !part.starts_with('.')
            && !part.ends_with(".git")
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if ok(group) && ok(name) {
        Ok(())
    } else {
        Err(format!("invalid repo slug: {repo}"))
    }
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())
}

async fn fetch_ticket(client: &reqwest::Client, endpoint: reqwest::Url) -> Result<ReportTicket, String> {
    let response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("report channel unreachable: {error}"))?;
    let status = response.status();
    let ticket: ReportTicket = response
        .json()
        .await
        .map_err(|error| format!("report channel response unreadable ({status}): {error}"))?;
    if !status.is_success() || ticket.repo.is_empty() || ticket.token.is_empty() {
        return Err(format!(
            "report channel not configured ({status})"
        ));
    }
    validate_repo(&ticket.repo)?;
    Ok(ticket)
}

async fn cnb_json(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    token: &str,
    body: Value,
) -> Result<Value, String> {
    let response = client
        .request(method, url)
        .bearer_auth(token)
        // CNB content-negotiates hard: a missing Accept header is a 406.
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("CNB request failed: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("CNB response unreadable: {error}"))?;
    if !status.is_success() {
        let hint: String = text.chars().take(300).collect();
        return Err(format!("CNB API {status}: {hint}"));
    }
    serde_json::from_str(&text).map_err(|error| format!("CNB response malformed: {error}"))
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

/// Upload the staged screenshot as an issue image asset and return its
/// markdown-ready URL: create an asset group with one image slot, then PUT
/// the bytes to the presigned URL (no Authorization header rides along).
/// The response's `asset_link` is an `<img>` snippet with a repo-relative
/// src that serves an HTML page to anonymous visitors — the repo-scoped
/// `download_url` is the one that actually serves image bytes, so that is
/// what goes into the body.
async fn upload_issue_image(
    client: &reqwest::Client,
    repo: &str,
    token: &str,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let group = cnb_json(
        client,
        reqwest::Method::POST,
        format!("{CNB_API_BASE}/{repo}/-/issues/asset-groups"),
        token,
        json!({
            "image_assets": [{
                "name": "screenshot.jpg",
                "size": bytes.len(),
                "content_type": "image/jpeg",
            }]
        }),
    )
    .await?;
    let upload = group
        .get("image_upload_urls")
        .and_then(|urls| urls.get(0))
        .cloned()
        .ok_or("CNB asset group returned no upload URL")?;
    let upload_url = upload
        .get("upload_url")
        .and_then(Value::as_str)
        .ok_or("CNB upload URL missing")?
        .to_string();
    let download_url = upload
        .get("download_url")
        .and_then(Value::as_str)
        .ok_or("CNB download URL missing")?
        .to_string();

    // Presigned target: the Authorization header must not ride along.
    client
        .put(&upload_url)
        .header("Content-Type", "image/jpeg")
        .body(bytes)
        .send()
        .await
        .map_err(|error| format!("screenshot upload failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("screenshot upload rejected: {error}"))?;
    Ok(download_url)
}

/// File the report on CNB directly: fetch the channel credentials from the
/// CloudBase function, upload the staged screenshot as an issue image asset,
/// then create the issue. A screenshot failure degrades to a note in the
/// body — the text report still lands.
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
    let ticket = fetch_ticket(&client, endpoint).await?;

    // Keep the screenshot failure non-fatal: submit the text with a note.
    let mut body = body.to_owned();
    if let Some(path) = req.screenshot_path.as_deref() {
        match read_staged_screenshot(&app, path) {
            Ok(bytes) => match upload_issue_image(&client, &ticket.repo, &ticket.token, bytes).await
            {
                Ok(url) => body.push_str(&format!("\n\n![screenshot]({url})\n")),
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

    let issue = cnb_json(
        &client,
        reqwest::Method::POST,
        format!("{CNB_API_BASE}/{}/-/issues", ticket.repo),
        &ticket.token,
        json!({ "title": title, "body": body.trim_end() }),
    )
    .await?;
    let number = parse_issue_number(&issue)?;
    Ok(CnbIssueResult { number })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_slugs_accept_org_repo_and_reject_traversal() {
        assert!(validate_repo("lynse.ai/lynse-desktop").is_ok());
        assert!(validate_repo("my-org_1.x/repo.name-2").is_ok());
        for slug in [
            "",
            "just-a-group",
            "a/b/c",
            ".hidden/repo",
            "org/./repo",
            "org/../repo",
            "org/repo/",
            "org/repo.git",
            "org/repo?x=1",
        ] {
            assert!(validate_repo(slug).is_err(), "accepted {slug}");
        }
    }

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
}
