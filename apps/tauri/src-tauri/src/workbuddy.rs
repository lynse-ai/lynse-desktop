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

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::command;

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
pub async fn workbuddy_openapi(req: WorkBuddyRelayRequest) -> Result<WorkBuddyRelayResponse, String> {
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
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .request(method, format!("{OPENAPI_BASE}{}", req.path))
        .bearer_auth(&req.access_token);
    if let Some(body) = req.body.as_deref() {
        request = request.header("Content-Type", "application/json").body(body.to_string());
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok(WorkBuddyRelayResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

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
