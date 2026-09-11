//! One-click Feishu/Lark agent-app registration.
//!
//! Implements the OAuth 2.0 Device Authorization Grant (RFC 8628) against the
//! account servers, mirroring the official node-sdk `registerApp`
//! (`scene/registration`): `begin` returns a short-lived confirmation URL the
//! user opens or scans in Feishu/Lark, and `poll` runs until the platform
//! hands back the App ID + App Secret. The created app ships with the bot
//! capability, messaging scopes, and WebSocket event delivery pre-configured,
//! so the saved credentials are immediately usable by [`super::ws`].
//!
//! The secret is written straight to the OS keychain and never leaves Rust;
//! the tauri commands wrapping this module live in [`super`].

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use url::Url;

use super::{
    load_config, save_config_file, start_bot, FeishuConfig, FeishuHandle, APP_SECRET_ACCOUNT,
};
use crate::secret_set;

const DEFAULT_AUTH_DOMAIN: &str = "https://accounts.feishu.cn";
const LARK_AUTH_DOMAIN: &str = "https://accounts.larksuite.com";
const REGISTRATION_ENDPOINT: &str = "/oauth/v1/app/registration";
/// Tracking tag appended to the confirmation URL (the node-sdk sends `node-sdk`).
const SOURCE: &str = "lynse-desktop";
/// Each `slow_down` pushes the poll interval out by this many seconds.
const SLOW_DOWN_STEP_SECS: u64 = 5;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Live device-grant session between `begin` and the terminal `poll`.
pub(crate) struct RegistrationSession {
    http: reqwest::Client,
    device_code: String,
    /// Authorization server the next poll hits; switches once to the Lark
    /// domain when the scanning user belongs to a Lark tenant.
    base_url: String,
    interval_secs: u64,
}

/// The confirmation URL plus timing hints for the settings UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuRegistrationStart {
    pub url: String,
    pub expires_in_secs: u64,
    pub interval_secs: u64,
}

/// One poll's outcome. Kept out of `Err` on purpose: denied / expired are
/// expected flow states the UI localizes, not transport failures.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuRegistrationPoll {
    /// "pending" | "success" | "denied" | "expired" | "failed"
    pub status: String,
    pub interval_secs: u64,
    pub error: Option<String>,
    /// Saved config on success (`hasSecret` true, `enabled` true).
    pub config: Option<FeishuConfig>,
}

// ── Account-server response shapes ──────────────────────────────────────────

#[derive(Deserialize)]
struct BeginResponse {
    device_code: String,
    verification_uri_complete: String,
    #[serde(default = "default_interval")]
    interval: u64,
    #[serde(default = "default_expires_in")]
    expires_in: u64,
}

fn default_interval() -> u64 {
    5
}

fn default_expires_in() -> u64 {
    600
}

#[derive(Deserialize)]
struct PollResponse {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    user_info: Option<UserInfo>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "error_description")]
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct UserInfo {
    #[serde(default)]
    tenant_brand: Option<String>,
}

/// RFC 8628 servers answer pending / slow-down with HTTP 400 + a JSON body,
/// so parse the body regardless of status.
async fn parse_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    context: &str,
) -> Result<T, String> {
    let body = response
        .text()
        .await
        .map_err(|error| format!("Feishu registration {context} response unreadable: {error}"))?;
    serde_json::from_str(&body)
        .map_err(|error| format!("Feishu registration {context} response is not JSON: {error}"))
}

/// `application/x-www-form-urlencoded` body, same encoding the node-sdk's
/// `URLSearchParams` produces.
fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut out = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        out.append_pair(name, value);
    }
    out.finish()
}

async fn poll_once(
    http: &reqwest::Client,
    base_url: &str,
    device_code: &str,
) -> Result<PollResponse, String> {
    let response = http
        .post(format!("{base_url}{REGISTRATION_ENDPOINT}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body(&[("action", "poll"), ("device_code", device_code)]))
        .send()
        .await
        .map_err(|error| format!("Feishu registration poll failed: {error}"))?;
    parse_json(response, "poll").await
}

// ── Flow steps (wrapped by the tauri commands in `super`) ───────────────────

/// Start a registration: create the device-grant session and return the
/// confirmation URL for the frontend to render as a QR code / browser link.
pub(crate) async fn begin(
    app: &AppHandle,
    name: Option<String>,
    desc: Option<String>,
) -> Result<FeishuRegistrationStart, String> {
    let http = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = http
        .post(format!("{DEFAULT_AUTH_DOMAIN}{REGISTRATION_ENDPOINT}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body(&[
            ("action", "begin"),
            ("archetype", "PersonalAgent"),
            ("auth_method", "client_secret"),
            ("request_user_info", "open_id"),
        ]))
        .send()
        .await
        .map_err(|error| format!("Feishu registration begin failed: {error}"))?;
    let begin: BeginResponse = parse_json(response, "begin").await?;

    // Pre-fill the app name / description on the confirmation page and tag
    // the traffic source, mirroring the node-sdk's URL surgery.
    let mut url = Url::parse(&begin.verification_uri_complete)
        .map_err(|error| format!("Feishu registration URL is invalid: {error}"))?;
    url.query_pairs_mut()
        .append_pair("from", "sdk")
        .append_pair("source", SOURCE)
        .append_pair("tp", "sdk");
    if let Some(name) = name.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("name", name);
    }
    if let Some(desc) = desc.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("desc", desc);
    }

    let interval_secs = begin.interval.max(1);
    let handle = app.state::<FeishuHandle>();
    if let Ok(mut guard) = handle.registration.lock() {
        *guard = Some(RegistrationSession {
            http,
            device_code: begin.device_code,
            base_url: DEFAULT_AUTH_DOMAIN.to_owned(),
            interval_secs,
        });
    }
    Ok(FeishuRegistrationStart {
        url: url.to_string(),
        expires_in_secs: begin.expires_in.max(60),
        interval_secs,
    })
}

/// One device-grant poll. Terminal outcomes (`denied` / `expired` / `failed`)
/// clear the session; `success` also persists the credentials and starts the
/// bot, so the one-click flow ends with the bot online.
pub(crate) async fn poll(app: &AppHandle) -> Result<FeishuRegistrationPoll, String> {
    let session_parts = {
        let handle = app.state::<FeishuHandle>();
        let guard = handle
            .registration
            .lock()
            .map_err(|_| "registration lock is poisoned".to_owned())?;
        guard.as_ref().map(|session| {
            (
                session.http.clone(),
                session.device_code.clone(),
                session.base_url.clone(),
                session.interval_secs,
            )
        })
    };
    let Some((http, device_code, base_url, mut interval_secs)) = session_parts else {
        return Ok(FeishuRegistrationPoll {
            status: "failed".to_owned(),
            interval_secs: 0,
            error: Some("no active registration".to_owned()),
            config: None,
        });
    };

    let mut response = poll_once(&http, &base_url, &device_code).await?;

    // A Lark-tenant user scanned: the account server reports the brand and
    // polling must continue against the Lark domain (node-sdk's
    // `domain_switched`), re-polling immediately.
    let is_lark_user = response
        .user_info
        .as_ref()
        .and_then(|info| info.tenant_brand.as_deref())
        .is_some_and(|brand| brand.eq_ignore_ascii_case("lark"));
    if is_lark_user && base_url != LARK_AUTH_DOMAIN {
        if let Ok(mut guard) = app.state::<FeishuHandle>().registration.lock() {
            if let Some(session) = guard.as_mut() {
                session.base_url = LARK_AUTH_DOMAIN.to_owned();
            }
        }
        response = poll_once(&http, LARK_AUTH_DOMAIN, &device_code).await?;
    }

    if let (Some(app_id), Some(app_secret)) = (response.client_id, response.client_secret) {
        let config = finish_registration(app, &app_id, &app_secret)?;
        return Ok(FeishuRegistrationPoll {
            status: "success".to_owned(),
            interval_secs,
            error: None,
            config: Some(config),
        });
    }

    match response.error.as_deref() {
        None | Some("authorization_pending") => Ok(FeishuRegistrationPoll {
            status: "pending".to_owned(),
            interval_secs,
            error: None,
            config: None,
        }),
        Some("slow_down") => {
            interval_secs += SLOW_DOWN_STEP_SECS;
            if let Ok(mut guard) = app.state::<FeishuHandle>().registration.lock() {
                if let Some(session) = guard.as_mut() {
                    session.interval_secs = interval_secs;
                }
            }
            Ok(FeishuRegistrationPoll {
                status: "pending".to_owned(),
                interval_secs,
                error: None,
                config: None,
            })
        }
        Some("access_denied") => {
            clear_registration(app);
            Ok(FeishuRegistrationPoll {
                status: "denied".to_owned(),
                interval_secs,
                error: response.error_description,
                config: None,
            })
        }
        Some("expired_token") => {
            clear_registration(app);
            Ok(FeishuRegistrationPoll {
                status: "expired".to_owned(),
                interval_secs,
                error: response.error_description,
                config: None,
            })
        }
        Some(error) => {
            clear_registration(app);
            Ok(FeishuRegistrationPoll {
                status: "failed".to_owned(),
                interval_secs,
                error: Some(match response.error_description {
                    Some(description) => format!("{error}: {description}"),
                    None => error.to_owned(),
                }),
                config: None,
            })
        }
    }
}

/// Drop the active registration (user closed the dialog).
pub(crate) fn cancel(app: &AppHandle) {
    clear_registration(app);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Persist the freshly minted credentials (secret → keychain), enable the
/// bot, and start the WS session — the one-click flow's end state.
fn finish_registration(
    app: &AppHandle,
    app_id: &str,
    app_secret: &str,
) -> Result<FeishuConfig, String> {
    secret_set(app, APP_SECRET_ACCOUNT, app_secret.trim())?;
    let mut config = load_config(app)?;
    config.app_id = app_id.trim().to_owned();
    config.enabled = true;
    save_config_file(app, &config)?;
    let stored = load_config(app)?;
    start_bot(app);
    Ok(stored)
}

fn clear_registration(app: &AppHandle) {
    if let Ok(mut guard) = app.state::<FeishuHandle>().registration.lock() {
        *guard = None;
    }
}
