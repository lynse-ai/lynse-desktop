//! WorkBuddy OpenAPI relay.
//!
//! The renderer's direct `fetch` calls to www.workbuddy.cn are blocked by
//! CORS: the WorkBuddy API serves no `access-control-*` headers for the
//! `tauri://localhost` origin (verified 2026-09-21 — the preflight OPTIONS is
//! a plain 404), so every cross-origin call from the WebView fails as
//! "Load failed". This module forwards the request through reqwest instead,
//! which is outside the browser's CORS regime.
//!
//! Token lifecycle (fetch / refresh / single retry on 401) stays in the
//! renderer — `packages/core/auth/workbuddy.ts` injects this relay via
//! `setWorkBuddyHttpRelay` at bridge-install time; here we are a plain HTTP
//! pipe with no WorkBuddy credentials of our own.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use std::{collections::HashMap, sync::Arc};
use tauri::{command, ipc::Channel, State, WebviewWindow};
use tokio::sync::Mutex;

const OPENAPI_BASE: &str = "https://www.workbuddy.cn/openapi/v2";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBuddyRelayRequest {
    /// Path under the OpenAPI base, with a leading slash — e.g.
    /// "/localassistant/message" (query string included).
    pub path: String,
    /// HTTP method name ("GET" | "POST" | "PUT" | "DELETE").
    pub method: String,
    /// Serialized JSON body, forwarded verbatim.
    #[serde(default)]
    pub body: Option<String>,
    /// Bearer access token owned by the renderer.
    pub access_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBuddyRelayResponse {
    pub status: u16,
    /// Raw response body text (JSON in practice); the renderer parses it.
    pub body: String,
}

/// Relay one WorkBuddy OpenAPI call. Returns the upstream status and body
/// verbatim — including 401s, which the renderer answers with its refresh
/// flow — so the caller keeps full protocol control.
#[command]
pub async fn workbuddy_openapi(
    req: WorkBuddyRelayRequest,
) -> Result<WorkBuddyRelayResponse, String> {
    // The path is appended to a fixed base: accept only "/..."-shaped paths
    // with no scheme or host embedded, so a stray absolute URL cannot turn
    // this relay into an open proxy.
    if !req.path.starts_with('/') || req.path.contains("://") {
        return Err(format!("invalid WorkBuddy OpenAPI path: {}", req.path));
    }
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| format!("invalid HTTP method: {}", req.method))?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .request(method, format!("{OPENAPI_BASE}{}", req.path))
        .bearer_auth(&req.access_token);
    if let Some(body) = req.body.as_deref() {
        request = request
            .header("Content-Type", "application/json")
            .body(body.to_string());
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok(WorkBuddyRelayResponse { status, body })
}

fn cloud_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid WorkBuddy URL")?;
    let host = url.host_str().unwrap_or_default();
    let allowed = host == "www.workbuddy.cn"
        || host.ends_with(".workbuddy.cn")
        || host.ends_with(".agentos-run.net")
        || host.ends_with(".sandbox.cloudstudio.club");
    if url.scheme() != "https"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("untrusted WorkBuddy cloud URL".into());
    }
    Ok(url)
}

#[derive(Clone)]
struct CloudConnection {
    client: reqwest::Client,
    url: reqwest::Url,
    token: String,
    connection_id: String,
    owner: String,
    abort: tokio::task::AbortHandle,
}

#[derive(Default, Clone)]
pub struct WorkBuddyAcpState(Arc<Mutex<HashMap<String, CloudConnection>>>);

impl WorkBuddyAcpState {
    pub async fn close_owner(&self, owner: &str) {
        self.0.lock().await.retain(|_, connection| {
            if connection.owner == owner {
                connection.abort.abort();
                false
            } else {
                true
            }
        });
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CloudStreamEvent {
    Chunk { bytes: Vec<u8> },
    Closed,
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOpenResponse {
    status: u16,
    handle: Option<String>,
    connection_id: Option<String>,
}

/// Return response headers immediately while streaming bytes over IPC.
#[command]
pub async fn workbuddy_acp_open(
    window: WebviewWindow,
    state: State<'_, WorkBuddyAcpState>,
    url: String,
    token: String,
    on_event: Channel<CloudStreamEvent>,
) -> Result<CloudOpenResponse, String> {
    let url = cloud_url(&url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "WorkBuddy HTTP client unavailable")?;
    // A long-lived stream must not inherit the REST relay's 60s timeout.
    let response = tokio::time::timeout(
        Duration::from_secs(20),
        client
            .get(url.clone())
            .bearer_auth(&token)
            .header("Accept", "text/event-stream")
            .send(),
    )
    .await
    .map_err(|_| "WorkBuddy connection timed out")?
    .map_err(|_| "WorkBuddy connection failed")?;
    let status = response.status().as_u16();
    log::info!("[workbuddy-acp-http] method=GET status={status}");
    if !(200..300).contains(&status) {
        return Ok(CloudOpenResponse {
            status,
            handle: None,
            connection_id: None,
        });
    }
    let connection_id = response
        .headers()
        .get("acp-connection-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or("WorkBuddy ACP connection ID missing")?
        .to_string();
    let handle = uuid::Uuid::new_v4().to_string();
    let registry = state.0.clone();
    let stream_handle = handle.clone();
    let mut entries = state.0.lock().await;
    let task = tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if on_event
                        .send(CloudStreamEvent::Chunk {
                            bytes: bytes.to_vec(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    let _ = on_event.send(CloudStreamEvent::Error {
                        message: "WorkBuddy connection interrupted".into(),
                    });
                    break;
                }
            }
        }
        registry.lock().await.remove(&stream_handle);
        let _ = on_event.send(CloudStreamEvent::Closed);
    });
    entries.insert(
        handle.clone(),
        CloudConnection {
            client,
            url,
            token,
            connection_id: connection_id.clone(),
            owner: window.label().to_string(),
            abort: task.abort_handle(),
        },
    );
    Ok(CloudOpenResponse {
        status,
        handle: Some(handle),
        connection_id: Some(connection_id),
    })
}

fn acp_post_request(
    client: &reqwest::Client,
    url: &reqwest::Url,
    token: &str,
    connection_id: &str,
    body: String,
) -> reqwest::RequestBuilder {
    client
        .post(url.clone())
        .timeout(REQUEST_TIMEOUT)
        .bearer_auth(token)
        .header("Acp-Connection-Id", connection_id)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(body)
}

#[command]
pub async fn workbuddy_acp_post(
    window: WebviewWindow,
    state: State<'_, WorkBuddyAcpState>,
    handle: String,
    body: String,
) -> Result<WorkBuddyRelayResponse, String> {
    if body.len() > 2_000_000 {
        return Err("WorkBuddy RPC request too large".into());
    }
    let message: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "invalid WorkBuddy RPC request")?;
    if message.get("jsonrpc").and_then(|value| value.as_str()) != Some("2.0") {
        return Err("invalid WorkBuddy RPC version".into());
    }
    let connection = state
        .0
        .lock()
        .await
        .get(&handle)
        .cloned()
        .ok_or("WorkBuddy connection closed")?;
    if connection.owner != window.label() {
        return Err("WorkBuddy connection owner mismatch".into());
    }
    let response = acp_post_request(
        &connection.client,
        &connection.url,
        &connection.token,
        &connection.connection_id,
        body,
    )
    .send()
    .await
    .map_err(|_| "WorkBuddy RPC submission failed")?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|_| "WorkBuddy RPC response unreadable")?;
    log::info!("[workbuddy-acp-http] method=POST status={status}");
    if status == 406 {
        log::warn!(
            "[workbuddy-acp-http] negotiation-rejected requires_json={} requires_sse={}",
            body.contains("application/json"),
            body.contains("text/event-stream"),
        );
    }
    Ok(WorkBuddyRelayResponse { status, body })
}

#[command]
pub async fn workbuddy_acp_close(
    window: WebviewWindow,
    state: State<'_, WorkBuddyAcpState>,
    handle: String,
) -> Result<(), String> {
    let mut entries = state.0.lock().await;
    if let Some(connection) = entries.get(&handle) {
        if connection.owner != window.label() {
            return Err("WorkBuddy connection owner mismatch".into());
        }
    }
    if let Some(connection) = entries.remove(&handle) {
        connection.abort.abort();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudResourceResponse {
    status: u16,
    body: Option<String>,
    bytes: Option<Vec<u8>>,
    mime_type: Option<String>,
}

#[command]
pub async fn workbuddy_cloud_resource(
    url: String,
    token: String,
    binary: bool,
) -> Result<CloudResourceResponse, String> {
    let url = cloud_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "WorkBuddy HTTP client unavailable")?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "WorkBuddy resource request failed")?;
    let status = response.status().as_u16();
    let mime_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "WorkBuddy resource interrupted")?;
        if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err("WorkBuddy resource exceeds 32 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = if binary {
        None
    } else {
        Some(String::from_utf8(bytes.clone()).map_err(|_| "WorkBuddy resource is not UTF-8")?)
    };
    Ok(CloudResourceResponse {
        status,
        body,
        bytes: binary.then_some(bytes),
        mime_type,
    })
}

/// Bytes already fetched with a task ticket, saved to a user-picked path.
#[command]
pub async fn workbuddy_cloud_save_bytes(bytes: Vec<u8>, path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(path);
    if !target.is_absolute() || target.file_name().is_none() || bytes.len() > 32 * 1024 * 1024 {
        return Err("invalid WorkBuddy artifact destination or size".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(target, bytes)
            .map_err(|_| "WorkBuddy artifact could not be saved".to_string())
    })
    .await
    .map_err(|_| "WorkBuddy artifact save interrupted".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_post_negotiates_json_and_sse_with_the_owned_connection() {
        let client = reqwest::Client::new();
        let url = cloud_url("https://65225-abc.e2b.sh2.sandbox.cloudstudio.club/acp").unwrap();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let request = acp_post_request(&client, &url, "task-ticket", "connection-1", body.into())
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url(), &url);
        assert_eq!(request.headers()["accept"], "application/json, text/event-stream");
        assert_eq!(request.headers()["content-type"], "application/json");
        assert_eq!(request.headers()["authorization"], "Bearer task-ticket");
        assert_eq!(request.headers()["acp-connection-id"], "connection-1");
        assert_eq!(request.body().unwrap().as_bytes().unwrap(), body.as_bytes());
    }

    #[test]
    fn cloud_urls_reject_external_hosts_and_credentials() {
        assert!(cloud_url("https://acp.workbuddy.cn/sessions/123").is_ok());
        assert!(cloud_url("https://65225-abc.ap-guangzhou.agentos-run.net/acp").is_ok());
        assert!(cloud_url("https://65225-abc.e2b.sh2.sandbox.cloudstudio.club/acp").is_ok());
        assert!(cloud_url("https://65225-def.e2b.bj7.sandbox.cloudstudio.club:443/api/session/artifacts").is_ok());
        for url in [
            "http://acp.workbuddy.cn/acp",
            "https://workbuddy.cn.evil.test/acp",
            "https://evilworkbuddy.cn/acp",
            "https://user@acp.workbuddy.cn/acp",
            "https://127.0.0.1/acp",
            "https://acp.workbuddy.cn:9443/acp",
            "http://65225-abc.e2b.sh2.sandbox.cloudstudio.club/acp",
            "https://sandbox.cloudstudio.club.evil.test/acp",
            "https://evilsandbox.cloudstudio.club/acp",
            "https://preview.cloudstudio.club/acp",
            "https://user@65225-abc.e2b.sh2.sandbox.cloudstudio.club/acp",
            "https://65225-abc.e2b.sh2.sandbox.cloudstudio.club:9443/acp",
        ] {
            assert!(cloud_url(url).is_err(), "accepted {url}");
        }
    }

    /// Real-network smoke: the relay must reach www.workbuddy.cn and return
    /// the upstream 401 envelope (not a transport/CORS failure) even with a
    /// bogus bearer token.
    #[tokio::test]
    async fn relay_reaches_workbuddy_and_surfaces_401() {
        let res = workbuddy_openapi(WorkBuddyRelayRequest {
            path: "/localassistant".into(),
            method: "GET".into(),
            body: None,
            access_token: "bogus-token-for-smoke".into(),
        })
        .await
        .expect("relay call should not error");
        assert_eq!(res.status, 401, "body: {}", res.body);
        assert!(res.body.contains("invalid_token"), "body: {}", res.body);
    }

    /// Absolute URLs must be rejected — the relay is not an open proxy.
    #[tokio::test]
    async fn relay_rejects_absolute_paths() {
        let err = workbuddy_openapi(WorkBuddyRelayRequest {
            path: "https://evil.example.com/x".into(),
            method: "GET".into(),
            body: None,
            access_token: "x".into(),
        })
        .await;
        assert!(err.is_err());
    }
}
