use crate::{
    app_data_dir, secure_delete_secret, secure_get_secret, secure_set_secret, CommandResult,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;
use uuid::Uuid;

const CALLBACK_ADDRESS: &str = "127.0.0.1:43927";
const CALLBACK_PATH: &str = "/auth/feishu/callback";
const CALLBACK_URL: &str = "http://127.0.0.1:43927/auth/feishu/callback";
const AUTHORIZE_URL: &str = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL: &str = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const USER_INFO_URL: &str = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const ACCESS_TOKEN_KEY: &str = "lynse_feishu_user_access_token";
const OAUTH_TIMEOUT_SECONDS: u64 = 180;

const COMPILED_APP_ID: Option<&str> = option_env!("LYNSE_FEISHU_APP_ID");
const COMPILED_APP_SECRET: Option<&str> = option_env!("LYNSE_FEISHU_APP_SECRET");

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuAccount {
    pub open_id: String,
    pub union_id: String,
    pub user_id: Option<String>,
    pub name: String,
    pub en_name: Option<String>,
    pub avatar_url: Option<String>,
    pub email: Option<String>,
    pub enterprise_email: Option<String>,
    pub tenant_key: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFeishuAuth {
    account: Option<FeishuAccount>,
    access_token_expires_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuAuthState {
    configured: bool,
    redirect_uri: &'static str,
    authorized: bool,
    account: Option<FeishuAccount>,
    access_token_expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    code: i64,
    access_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
    msg: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserInfoResponse {
    #[serde(default)]
    code: i64,
    data: Option<FeishuAccount>,
    msg: Option<String>,
}

enum CallbackOutcome {
    Code(String),
    Denied,
}

fn configured_value(runtime_name: &str, compiled: Option<&str>) -> Option<String> {
    env::var(runtime_name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            compiled
                .map(str::to_owned)
                .filter(|value| !value.trim().is_empty())
        })
}

fn app_credentials() -> CommandResult<(String, String)> {
    let app_id = configured_value("LYNSE_FEISHU_APP_ID", COMPILED_APP_ID)
        .ok_or("This Lynse build does not have LYNSE_FEISHU_APP_ID configured")?;
    let app_secret = configured_value("LYNSE_FEISHU_APP_SECRET", COMPILED_APP_SECRET)
        .ok_or("This Lynse build does not have LYNSE_FEISHU_APP_SECRET configured")?;
    Ok((app_id, app_secret))
}

fn auth_store_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?
        .join("local-feishu-auth")
        .join("account.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(path)
}

fn load_auth(app: &AppHandle) -> CommandResult<StoredFeishuAuth> {
    let path = auth_store_path(app)?;
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(StoredFeishuAuth::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn save_auth(app: &AppHandle, auth: &StoredFeishuAuth) -> CommandResult<()> {
    let path = auth_store_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(auth).map_err(|error| error.to_string())?;
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn random_url_safe_value() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn build_authorization_url(app_id: &str, state: &str, challenge: &str) -> CommandResult<String> {
    let mut url = Url::parse(AUTHORIZE_URL).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", app_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", CALLBACK_URL)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "consent");
    Ok(url.into())
}

fn parse_callback_target(target: &str, expected_state: &str) -> CommandResult<CallbackOutcome> {
    let url = Url::parse(&format!("http://localhost{target}"))
        .map_err(|_| "Invalid OAuth callback URL")?;
    if url.path() != CALLBACK_PATH {
        return Err("Unexpected OAuth callback path".to_owned());
    }

    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .ok_or("OAuth callback is missing state")?;
    if state != expected_state {
        return Err("OAuth state validation failed".to_owned());
    }

    if url
        .query_pairs()
        .any(|(key, value)| key == "error" && value == "access_denied")
    {
        return Ok(CallbackOutcome::Denied);
    }

    let code = url
        .query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
        .ok_or("OAuth callback is missing code")?;
    Ok(CallbackOutcome::Code(code))
}

async fn write_browser_response(
    stream: &mut tokio::net::TcpStream,
    title: &str,
    message: &str,
) -> CommandResult<()> {
    let body = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>body{{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f8fa;color:#1f2329}}main{{max-width:420px;padding:32px;text-align:center;background:white;border:1px solid #dee0e3;border-radius:12px}}h1{{font-size:20px}}p{{color:#646a73;line-height:1.6}}</style></head><body><main><h1>{title}</h1><p>{message}</p></main></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream.shutdown().await.map_err(|error| error.to_string())
}

async fn wait_for_callback(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> CommandResult<String> {
    let (mut stream, _) = tokio::time::timeout(
        Duration::from_secs(OAUTH_TIMEOUT_SECONDS),
        listener.accept(),
    )
    .await
    .map_err(|_| "Timed out waiting for Feishu authorization")?
    .map_err(|error| error.to_string())?;

    let mut buffer = vec![0_u8; 16 * 1024];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer))
        .await
        .map_err(|_| "Timed out reading Feishu OAuth callback")?
        .map_err(|error| error.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or("Invalid OAuth callback request")?;

    match parse_callback_target(target, expected_state) {
        Ok(CallbackOutcome::Code(code)) => {
            write_browser_response(
                &mut stream,
                "飞书授权已完成",
                "你可以关闭此页面并返回 Lynse。",
            )
            .await?;
            Ok(code)
        }
        Ok(CallbackOutcome::Denied) => {
            write_browser_response(
                &mut stream,
                "已取消飞书授权",
                "你可以关闭此页面并返回 Lynse。",
            )
            .await?;
            Err("Feishu authorization was cancelled".to_owned())
        }
        Err(error) => {
            write_browser_response(
                &mut stream,
                "飞书授权失败",
                "回调校验失败，请返回 Lynse 后重试。",
            )
            .await?;
            Err(error)
        }
    }
}

fn provider_error(value: &Value, fallback: &str) -> String {
    value
        .get("error_description")
        .or_else(|| value.get("msg"))
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

async fn exchange_code(
    client: &reqwest::Client,
    app_id: &str,
    app_secret: &str,
    code: &str,
    verifier: &str,
) -> CommandResult<(String, i64)> {
    let response = client
        .post(TOKEN_URL)
        .json(&json!({
            "grant_type": "authorization_code",
            "client_id": app_id,
            "client_secret": app_secret,
            "code": code,
            "redirect_uri": CALLBACK_URL,
            "code_verifier": verifier,
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Feishu token endpoint: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read Feishu token response: {error}"))?;
    let raw: Value = serde_json::from_str(&body)
        .map_err(|_| format!("Feishu token endpoint returned HTTP {status}"))?;
    let token: TokenResponse =
        serde_json::from_value(raw.clone()).map_err(|error| error.to_string())?;
    if !status.is_success() || token.code != 0 {
        return Err(provider_error(
            &raw,
            "Feishu rejected the authorization code",
        ));
    }
    let access_token = token
        .access_token
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            token
                .error_description
                .or(token.msg)
                .or(token.error)
                .unwrap_or_else(|| "Feishu did not return a user access token".to_owned())
        })?;
    Ok((access_token, token.expires_in.unwrap_or(0)))
}

async fn fetch_current_user(
    client: &reqwest::Client,
    access_token: &str,
) -> CommandResult<FeishuAccount> {
    let response = client
        .get(USER_INFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("Could not reach Feishu user endpoint: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read Feishu user response: {error}"))?;
    let user_info: UserInfoResponse = serde_json::from_str(&body)
        .map_err(|_| format!("Feishu user endpoint returned HTTP {status}"))?;
    if !status.is_success() || user_info.code != 0 {
        return Err(user_info
            .msg
            .unwrap_or_else(|| "Feishu rejected the user information request".to_owned()));
    }
    let account = user_info
        .data
        .ok_or("Feishu did not return the current user")?;
    if account.open_id.is_empty() || account.name.is_empty() {
        return Err("Feishu returned incomplete current-user information".to_owned());
    }
    Ok(account)
}

#[tauri::command]
pub(crate) fn feishu_auth_state(app: AppHandle) -> CommandResult<FeishuAuthState> {
    let stored = load_auth(&app)?;
    let token_exists = secure_get_secret(ACCESS_TOKEN_KEY.to_owned())?.is_some();
    let not_expired = stored
        .access_token_expires_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|expires_at| expires_at.with_timezone(&Utc) > Utc::now());
    Ok(FeishuAuthState {
        configured: app_credentials().is_ok(),
        redirect_uri: CALLBACK_URL,
        authorized: stored.account.is_some() && token_exists && not_expired,
        account: stored.account,
        access_token_expires_at: stored.access_token_expires_at,
    })
}

#[tauri::command]
pub(crate) async fn feishu_auth_authorize(app: AppHandle) -> CommandResult<FeishuAuthState> {
    let (app_id, app_secret) = app_credentials()?;
    let listener = tokio::net::TcpListener::bind(CALLBACK_ADDRESS)
        .await
        .map_err(|error| {
            format!("Could not start local OAuth callback on {CALLBACK_ADDRESS}: {error}")
        })?;
    let state = random_url_safe_value();
    let verifier = random_url_safe_value();
    let authorization_url = build_authorization_url(&app_id, &state, &pkce_challenge(&verifier))?;

    app.opener()
        .open_url(authorization_url, None::<&str>)
        .map_err(|error| format!("Could not open Feishu authorization: {error}"))?;
    let code = wait_for_callback(listener, &state).await?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let (access_token, expires_in) =
        exchange_code(&client, &app_id, &app_secret, &code, &verifier).await?;
    let account = fetch_current_user(&client, &access_token).await?;
    let expires_at = (Utc::now() + ChronoDuration::seconds(expires_in.max(0))).to_rfc3339();

    secure_set_secret(ACCESS_TOKEN_KEY.to_owned(), access_token)?;
    save_auth(
        &app,
        &StoredFeishuAuth {
            account: Some(account),
            access_token_expires_at: Some(expires_at),
        },
    )?;
    feishu_auth_state(app)
}

#[tauri::command]
pub(crate) fn feishu_auth_disconnect(app: AppHandle) -> CommandResult<FeishuAuthState> {
    secure_delete_secret(ACCESS_TOKEN_KEY.to_owned())?;
    save_auth(&app, &StoredFeishuAuth::default())?;
    feishu_auth_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_url_uses_local_callback_and_pkce() {
        let url =
            Url::parse(&build_authorization_url("cli_test", "state-1", "challenge-1").unwrap())
                .unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            query.get("client_id").map(|value| value.as_ref()),
            Some("cli_test")
        );
        assert_eq!(
            query.get("redirect_uri").map(|value| value.as_ref()),
            Some(CALLBACK_URL)
        );
        assert_eq!(
            query.get("state").map(|value| value.as_ref()),
            Some("state-1")
        );
        assert_eq!(
            query.get("code_challenge").map(|value| value.as_ref()),
            Some("challenge-1")
        );
        assert_eq!(
            query
                .get("code_challenge_method")
                .map(|value| value.as_ref()),
            Some("S256")
        );
    }

    #[test]
    fn callback_parser_accepts_matching_state() {
        let result = parse_callback_target(
            "/auth/feishu/callback?code=auth-code&state=expected",
            "expected",
        )
        .unwrap();
        assert!(matches!(result, CallbackOutcome::Code(code) if code == "auth-code"));
    }

    #[test]
    fn callback_parser_rejects_wrong_state() {
        let result = parse_callback_target(
            "/auth/feishu/callback?code=auth-code&state=other",
            "expected",
        );
        assert!(result.is_err());
    }
}
