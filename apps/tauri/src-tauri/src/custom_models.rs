//! Shared BYO-model plumbing for desktop features that run on the user's own
//! model (knowledge organization, local recording summaries, and future
//! ones). A profile names an OpenAI-compatible endpoint: its routing fields
//! (preset, base URL, model name) live in the renderer's settings, while the
//! API key lives only in the OS keychain under an account derived from the
//! profile id. Features never touch the platform credential, and requests
//! built here go straight from the desktop to the endpoint — nothing is
//! proxied through Lynse servers.

use crate::CommandResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

const ACCOUNT_PREFIX: &str = "custom-model-key-";
const MAX_PROFILE_ID_CHARS: usize = 64;

fn key_account(profile_id: &str) -> CommandResult<String> {
    let id = profile_id.trim();
    if id.is_empty()
        || id.chars().count() > MAX_PROFILE_ID_CHARS
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid custom model profile".into());
    }
    Ok(format!("{ACCOUNT_PREFIX}{id}"))
}

/// The profile's vaulted key, if any. The management UI writes keys per
/// profile; features only ever read them at request time.
pub(crate) async fn key(app: &AppHandle, profile_id: &str) -> CommandResult<Option<String>> {
    let account = key_account(profile_id)?;
    let app = app.clone();
    crate::run_secret_io(move || crate::secret_get(&app, &account)).await
}

/// Save (or with an empty key, remove) one profile's API key. The renderer
/// never stores keys outside the keychain.
#[tauri::command]
pub async fn custom_model_set_key(
    app: AppHandle,
    profile_id: String,
    api_key: Option<String>,
) -> CommandResult<()> {
    let account = key_account(&profile_id)?;
    let key = api_key.unwrap_or_default().trim().to_owned();
    crate::run_secret_io(move || {
        if key.is_empty() {
            crate::secret_delete(&app, &account)
        } else {
            crate::secret_set(&app, &account, &key)
        }
    })
    .await
}

#[tauri::command]
pub async fn custom_model_has_key(app: AppHandle, profile_id: String) -> CommandResult<bool> {
    Ok(key(&app, &profile_id)
        .await?
        .is_some_and(|key| !key.trim().is_empty()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionMessage {
    role: String,
    content: String,
}

/// One chat completion against the profile's own endpoint. The renderer
/// resolves a profile into base URL + model (presets are interpolated at
/// creation time so this works offline); the key is attached from the vault.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    #[serde(flatten)]
    endpoint: ModelEndpoint,
    messages: Vec<CompletionMessage>,
    max_tokens: Option<u32>,
    temperature: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEndpoint {
    profile_id: String,
    base_url: String,
    model: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionError {
    MissingKey,
    Keychain,
    InvalidEndpoint,
    InvalidModel,
    Timeout,
    Network,
    AccessDenied,
    Quota,
    NotFound,
    RateLimited,
    ProviderUnavailable,
    RequestRejected,
    InvalidResponse,
    EmptyResponse,
}

impl CompletionError {
    fn from_request(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else if error.is_decode() {
            Self::InvalidResponse
        } else {
            Self::Network
        }
    }

    fn from_status(status: u16) -> Self {
        match status {
            401 | 403 => Self::AccessDenied,
            402 => Self::Quota,
            404 => Self::NotFound,
            408 | 504 => Self::Timeout,
            429 => Self::RateLimited,
            500..=599 => Self::ProviderUnavailable,
            _ => Self::RequestRejected,
        }
    }
}

#[tauri::command]
pub async fn custom_model_complete(
    app: AppHandle,
    request: CompletionRequest,
) -> Result<String, CompletionError> {
    complete(&app, request, Duration::from_secs(300)).await
}

#[tauri::command]
pub async fn custom_model_test_connection(
    app: AppHandle,
    endpoint: ModelEndpoint,
) -> Result<(), CompletionError> {
    let request = CompletionRequest {
        endpoint,
        messages: vec![CompletionMessage {
            role: "user".into(),
            content: "Reply with OK.".into(),
        }],
        max_tokens: Some(256),
        temperature: None,
    };
    complete(&app, request, Duration::from_secs(30))
        .await
        .map(|_| ())
}

async fn complete(
    app: &AppHandle,
    request: CompletionRequest,
    timeout: Duration,
) -> Result<String, CompletionError> {
    let key = key(app, &request.endpoint.profile_id)
        .await
        .map_err(|_| CompletionError::Keychain)?
        .filter(|key| !key.trim().is_empty())
        .ok_or(CompletionError::MissingKey)?;
    let mut endpoint = url::Url::parse(request.endpoint.base_url.trim())
        .map_err(|_| CompletionError::InvalidEndpoint)?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(CompletionError::InvalidEndpoint);
    }
    let path = format!("{}/chat/completions", endpoint.path().trim_end_matches('/'));
    endpoint.set_path(&path);
    let model = request.endpoint.model.trim();
    if model.is_empty() {
        return Err(CompletionError::InvalidModel);
    }
    let mut body = json!({
        "model": model,
        "messages": request.messages.iter().map(|message| {
            json!({"role": message.role, "content": message.content})
        }).collect::<Vec<_>>(),
        "stream": false,
    });
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(CompletionError::from_request)?;
    let response = client
        .post(endpoint)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(CompletionError::from_request)?;
    read_completion(response).await
}

async fn read_completion(response: reqwest::Response) -> Result<String, CompletionError> {
    if !response.status().is_success() {
        return Err(CompletionError::from_status(response.status().as_u16()));
    }
    let value: Value = response
        .json()
        .await
        .map_err(CompletionError::from_request)?;
    if !value["choices"].is_array() {
        return Err(CompletionError::InvalidResponse);
    }
    let content = value["choices"][0]["message"]["content"]
        .as_str()
        .filter(|content| !content.trim().is_empty())
        .ok_or(CompletionError::EmptyResponse)?;
    Ok(content.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_accounts_are_scoped_and_validated() {
        assert_eq!(
            key_account("deepseek-main").unwrap(),
            "custom-model-key-deepseek-main"
        );
        assert!(key_account("").is_err());
        assert!(key_account("../escape").is_err());
        assert!(key_account(&"a".repeat(65)).is_err());
        assert!(key_account(&"a".repeat(64)).is_ok());
    }

    #[tokio::test]
    async fn classifies_http_errors_before_decoding_provider_responses() {
        let cases = [
            (
                401,
                "<html>Unauthorized</html>",
                Err(CompletionError::AccessDenied),
            ),
            (404, "", Err(CompletionError::NotFound)),
            (429, "Too many requests", Err(CompletionError::RateLimited)),
            (
                200,
                "<html>Service page</html>",
                Err(CompletionError::InvalidResponse),
            ),
            (
                200,
                r#"{"choices":[{"message":{"content":" "}}]}"#,
                Err(CompletionError::EmptyResponse),
            ),
            (
                200,
                r#"{"choices":[{"message":{"content":"OK"}}]}"#,
                Ok("OK".to_owned()),
            ),
        ];
        for (status, body, expected) in cases {
            let response = tauri::http::Response::builder()
                .status(status)
                .body(body)
                .unwrap();
            assert_eq!(read_completion(response.into()).await, expected);
        }
    }
}
