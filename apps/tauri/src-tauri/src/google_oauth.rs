//! Google native sign-in (RFC 8252 loopback) — listener + token relay.
//!
//! Google refuses OAuth inside embedded WebViews, so the desktop intl flow
//! sends the user's SYSTEM browser to accounts.google.com and takes the
//! authorization code back over loopback (installed-app pattern, public
//! client, PKCE only — no secret):
//!
//!   desktop                     system browser                Google
//!     ├─ bind 127.0.0.1:<ephemeral>
//!     ├─ open authorize URL ─────────>│ consent
//!     │                               ├─ 302 http://127.0.0.1:<port>/?code=…&state=…
//!     │<──────────────────────────────┘ (listener answers with a
//!     │                                  "return to the app" page)
//!     ├─ `google-oauth-callback` event → renderer
//!     ├─ google_oauth_exchange (code+PKCE verifier → Google ID token)
//!     ├─ google_oauth_firebase_signin (Google ID token → FIREBASE ID token
//!     │   via Identity Toolkit accounts:signInWithIdp — the same Google
//!     │   provider the web popup uses, so /api/auth/login stays unchanged)
//!
//! Both server-side exchanges run here through reqwest (outside the
//! WebView's CORS regime, same rationale as the WorkBuddy relay), and the
//! renderer only ever sees the two ID tokens it actually needs.

use crate::CommandResult;
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{CONNECTION, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;

pub(crate) const CALLBACK_EVENT: &str = "google-oauth-callback";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const FIREBASE_SIGNIN_URL: &str = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp";
const HTTP_TIMEOUT_SECS: u64 = 30;

/// The page served to the browser tab after Google redirects to loopback —
/// the tab cannot be closed by JS, so it explains itself instead.
const LANDING_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Lynse</title>\
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#1a1a1a;background:#fafafa}\
.box{text-align:center;padding:2rem}h1{font-size:1.05rem;margin:0 0 .5rem}p{font-size:.85rem;color:#666;margin:0}</style></head><body>\
<div class=\"box\"><h1>登录完成 — Sign-in complete</h1><p>请回到 Lynse 应用继续。You can close this tab and return to the Lynse app.</p></div>\
</body></html>";

/// One active listener; a new `google_oauth_start` replaces the previous one.
static LISTENER: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

/// Minimal percent-encoding for x-www-form-urlencoded values (RFC 3986
/// unreserved characters pass through, everything else becomes %XX).
fn form_urlencode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char)
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

fn stop_locked() {
    if let Ok(mut guard) = LISTENER.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
            log::info!("[google-oauth] listener stopped");
        }
    }
}

/// Bind `127.0.0.1:<ephemeral>` and serve ONE redirect — Google's 302 carrying
/// `code`/`error` + `state` — then shut down (the code is single-use anyway).
#[tauri::command]
pub(crate) async fn google_oauth_start(app: AppHandle) -> CommandResult<u16> {
    stop_locked();
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("google oauth listener bind failed: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();

    let app_for_task = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let received_outcome = Arc::new(AtomicBool::new(false));
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let app = app_for_task.clone();
            let outcome = received_outcome.clone();
            // Sequential handling is fine: each connection closes immediately
            // (`Connection: close`). Only exit once an actual code/error
            // callback arrives so browser preconnects or /favicon.ico probes
            // cannot kill the listener prematurely.
            let service = service_fn(move |request| {
                handle_redirect(app.clone(), outcome.clone(), request)
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
            if received_outcome.load(Ordering::Acquire) {
                break;
            }
        }
    });
    if let Ok(mut guard) = LISTENER.lock() {
        *guard = Some(handle);
    }
    log::info!("[google-oauth] listening on 127.0.0.1:{port}");
    Ok(port)
}

/// Cancel the listener (user cancelled the sign-in, login page teardown).
#[tauri::command]
pub(crate) fn google_oauth_stop() -> CommandResult<()> {
    stop_locked();
    Ok(())
}

fn is_callback_query(query: &str) -> bool {
    query.contains("code=") || query.contains("error=")
}

async fn handle_redirect(
    app: AppHandle,
    received_outcome: Arc<AtomicBool>,
    request: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    // Google redirects to the redirect_uri root with the outcome in the
    // query; anything else hitting this socket (favicon et cetera) gets the
    // landing page without emitting a bogus callback.
    let url = request.uri().to_string();
    let query = request.uri().query().unwrap_or_default();
    if is_callback_query(query) {
        received_outcome.store(true, Ordering::Release);
        log::info!("[google-oauth] redirect received");
        let _ = app.emit(CALLBACK_EVENT, format!("http://127.0.0.1{url}"));
    }
    // `Connection: close` ends the connection after this response, so the
    // one-shot listener future resolves and the accept loop can stop.
    let mut response = Response::new(Full::new(Bytes::from_static(LANDING_HTML.as_bytes())));
    *response.status_mut() = StatusCode::OK;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, "text/html; charset=utf-8".parse().unwrap());
    response
        .headers_mut()
        .insert(CONNECTION, "close".parse().unwrap());
    Ok(response)
}

#[derive(Debug, Deserialize)]
pub(crate) struct CodeExchange {
    pub code: String,
    pub verifier: String,
    pub redirect_uri: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct IdTokenResult {
    pub id_token: String,
}

/// Exchange the loopback code for the Google ID token (PKCE, no secret —
/// installed-app clients never carry one). The renderer receives the
/// `id_token` only.
#[tauri::command]
pub(crate) async fn google_oauth_exchange(input: CodeExchange) -> CommandResult<IdTokenResult> {
    if input.code.is_empty() || input.verifier.is_empty() || input.client_id.is_empty() {
        return Err("google oauth exchange: empty parameters".into());
    }
    if !input.redirect_uri.starts_with("http://127.0.0.1:") {
        return Err("google oauth exchange: redirect_uri must be loopback".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|error| error.to_string())?;
    // x-www-form-urlencoded body built by hand (the form helper needs an
    // extra reqwest feature); every value here is percent-encoded so tokens
    // with unusual characters survive.
    let mut params = vec![
        ("client_id", input.client_id.as_str()),
        ("code", input.code.as_str()),
        ("code_verifier", input.verifier.as_str()),
        ("redirect_uri", input.redirect_uri.as_str()),
        ("grant_type", "authorization_code"),
    ];
    if let Some(secret) = input.client_secret.as_deref().filter(|s| !s.is_empty()) {
        params.push(("client_secret", secret));
    }
    let body = params
        .into_iter()
        .map(|(key, value)| format!("{key}={}", form_urlencode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let response = client
        .post(TOKEN_URL)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|error| {
            log::error!("[google-oauth] code exchange request failed: {error}");
            format!("google token request failed: {error}")
        })?;
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("google token response parse failed: {error}"))?;
    let id_token = payload
        .get("id_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            let err = payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            let desc = payload
                .get("error_description")
                .and_then(Value::as_str)
                .unwrap_or("");
            if desc.is_empty() {
                log::error!("[google-oauth] code exchange rejected: {err}");
                format!("google token exchange failed: {err}")
            } else {
                log::error!("[google-oauth] code exchange rejected: {err} ({desc})");
                format!("google token exchange failed: {err}: {desc}")
            }
        })?;
    log::info!("[google-oauth] code exchanged for Google ID token");
    Ok(IdTokenResult {
        id_token: id_token.to_string(),
    })
}

/// Mint a FIREBASE ID token from a Google ID token via Identity Toolkit's
/// `accounts:signInWithIdp` (the REST shape of the web SDK's Google
/// credential sign-in). The renderer receives the Firebase `idToken` only.
#[tauri::command]
pub(crate) async fn google_oauth_firebase_signin(
    google_id_token: String,
    api_key: String,
) -> CommandResult<IdTokenResult> {
    if google_id_token.is_empty() || api_key.is_empty() {
        return Err("firebase signin: empty parameters".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|error| error.to_string())?;
    let post_body = format!("id_token={}&providerId=google.com", google_id_token);
    let response = client
        .post(format!("{FIREBASE_SIGNIN_URL}?key={api_key}"))
        .json(&serde_json::json!({
            "postBody": post_body,
            "requestUri": "http://localhost",
            "returnIdpCredential": true,
            "returnSecureToken": true,
        }))
        .send()
        .await
        .map_err(|error| {
            log::error!("[google-oauth] firebase signin request failed: {error}");
            format!("firebase signin request failed: {error}")
        })?;
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("firebase signin response parse failed: {error}"))?;
    let id_token = payload
        .get("idToken")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            let detail = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            log::error!("[google-oauth] firebase signin rejected: {detail}");
            format!("firebase signin failed: {detail}")
        })?;
    log::info!("[google-oauth] Firebase ID token minted");
    Ok(IdTokenResult {
        id_token: id_token.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn listener_relays_one_redirect_and_serves_landing() {
        // Bind through the same code path the command uses (minus the
        // AppHandle, captured instead of emitted).
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let relayed = std::sync::Arc::new(Mutex::new(None::<String>));
        let sink = relayed.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let service = service_fn(move |request: Request<Incoming>| {
                let sink = sink.clone();
                async move {
                    let url = request.uri().to_string();
                    *sink.lock().unwrap() = Some(format!("http://127.0.0.1{url}"));
                    let mut response =
                        Response::new(Full::new(Bytes::from_static(LANDING_HTML.as_bytes())));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, "text/html; charset=utf-8".parse().unwrap());
                    Ok::<_, std::convert::Infallible>(response)
                }
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .get(format!(
                "http://127.0.0.1:{port}/?state=st1&code=abc&scope=openid"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get(CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        let body = response.text().await.unwrap();
        assert!(body.contains("Sign-in complete"));
        assert_eq!(
            relayed.lock().unwrap().as_deref(),
            Some(
                format!("http://127.0.0.1/?state=st1&code=abc&scope=openid").as_str()
            )
        );
        server.abort();
    }

    #[tokio::test]
    async fn listener_ignores_non_callback_requests_until_code_arrives() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let relayed = std::sync::Arc::new(Mutex::new(None::<String>));
        let sink = relayed.clone();
        let server = tokio::spawn(async move {
            let received_outcome = Arc::new(AtomicBool::new(false));
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let sink = sink.clone();
                let outcome = received_outcome.clone();
                let service = service_fn(move |request: Request<Incoming>| {
                    let sink = sink.clone();
                    let outcome = outcome.clone();
                    async move {
                        let url = request.uri().to_string();
                        let query = request.uri().query().unwrap_or_default();
                        if is_callback_query(query) {
                            outcome.store(true, Ordering::Release);
                            *sink.lock().unwrap() = Some(format!("http://127.0.0.1{url}"));
                        }
                        let mut response =
                            Response::new(Full::new(Bytes::from_static(LANDING_HTML.as_bytes())));
                        response
                            .headers_mut()
                            .insert(CONTENT_TYPE, "text/html; charset=utf-8".parse().unwrap());
                        response
                            .headers_mut()
                            .insert(CONNECTION, "close".parse().unwrap());
                        Ok::<_, std::convert::Infallible>(response)
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
                if received_outcome.load(Ordering::Acquire) {
                    break;
                }
            }
        });

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let favicon_resp = client
            .get(format!("http://127.0.0.1:{port}/favicon.ico"))
            .send()
            .await
            .unwrap();
        assert_eq!(favicon_resp.status(), StatusCode::OK);
        assert!(relayed.lock().unwrap().is_none());

        let code_resp = client
            .get(format!("http://127.0.0.1:{port}/?state=st2&code=xyz"))
            .send()
            .await
            .unwrap();
        assert_eq!(code_resp.status(), StatusCode::OK);
        assert_eq!(
            relayed.lock().unwrap().as_deref(),
            Some("http://127.0.0.1/?state=st2&code=xyz")
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn exchange_rejects_non_loopback_redirect() {
        let result = google_oauth_exchange(CodeExchange {
            code: "c".into(),
            verifier: "v".into(),
            redirect_uri: "https://evil.example/cb".into(),
            client_id: "id".into(),
            client_secret: None,
        })
        .await;
        assert!(result.is_err());
    }
}
