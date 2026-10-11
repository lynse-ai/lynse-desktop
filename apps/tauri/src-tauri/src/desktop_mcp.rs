//! Opt-in loopback MCP transport. Data operations remain in the existing renderer adapters.
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    header,
    server::conn::http1,
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    fs,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{net::TcpListener, sync::oneshot, task::JoinSet};
use uuid::Uuid;

const PROTOCOL: &str = "2025-06-18";
const MAX_REQUEST_BYTES: usize = 65_536;
const MAX_PENDING: usize = 16;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 27125,
            token: new_token(),
        }
    }
}
fn new_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[derive(Default)]
struct Inner {
    config: Config,
    loaded: bool,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    pending: HashMap<String, oneshot::Sender<Value>>,
}
#[derive(Clone, Default)]
pub struct DesktopMcpState {
    inner: Arc<Mutex<Inner>>,
    change: Arc<tokio::sync::Mutex<()>>,
}

impl DesktopMcpState {
    fn load(&self, app: &AppHandle) -> Result<Config, String> {
        let mut inner = self.inner.lock().map_err(|_| "MCP state unavailable")?;
        if !inner.loaded {
            let path = super::app_data_dir(app)?.join("desktop-mcp.json");
            if path.exists() {
                inner.config = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|_| "MCP settings are unreadable; preserved for recovery")?;
                if inner.config.port == 0 || inner.config.token.len() != 64 {
                    return Err("Invalid MCP settings".into());
                }
            }
            inner.loaded = true;
        }
        Ok(inner.config.clone())
    }

    pub async fn configure(
        &self,
        app: AppHandle,
        enabled: bool,
        port: u16,
        rotate: bool,
    ) -> Result<Config, String> {
        if port == 0 {
            return Err("MCP port must be between 1 and 65535".into());
        }
        let _change = self.change.lock().await;
        let mut config = self.load(&app)?;
        let keep_running =
            enabled && config.port == port && self.inner.lock().unwrap().task.is_some();
        let listener = if enabled && !keep_running {
            Some(
                TcpListener::bind(("127.0.0.1", port))
                    .await
                    .map_err(|_| "MCP port is already in use")?,
            )
        } else {
            None
        };
        config.enabled = enabled;
        config.port = port;
        if rotate {
            config.token = new_token();
        }
        let path = super::app_data_dir(&app)?.join("desktop-mcp.json");
        // This file holds only the local MCP credential, never the Lynse login token.
        let staging = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options.open(&staging).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&config).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(staging, path).map_err(|e| e.to_string())?;
        let mut inner = self.inner.lock().map_err(|_| "MCP state unavailable")?;
        if !keep_running {
            if let Some(task) = inner.task.take() {
                task.abort();
            }
        }
        inner.pending.clear();
        inner.config = config.clone();
        if let Some(listener) = listener {
            let state = self.clone();
            inner.task = Some(tauri::async_runtime::spawn(async move {
                let mut connections = JoinSet::new();
                loop {
                    tokio::select! {
                        connection = listener.accept() => {
                            let Ok((stream, _)) = connection else { break };
                            if connections.len() >= MAX_PENDING { continue; }
                            let app = app.clone();
                            let state = state.clone();
                            connections.spawn(async move {
                                let service = service_fn(move |request| {
                                    let app = app.clone();
                                    dispatch(state.clone(), request, move |payload| {
                                        app.emit_to("main", "lynse-mcp-request", payload).map_err(|e| e.to_string())
                                    })
                                });
                                let _ = tokio::time::timeout(Duration::from_secs(60), http1::Builder::new()
                                    .serve_connection(TokioIo::new(stream), service)).await;
                            });
                        }
                        _ = connections.join_next(), if !connections.is_empty() => {}
                    }
                }
                // Dropping JoinSet cancels open connections when the server is disabled.
            }));
        }
        Ok(config)
    }
}

type HttpResponse = Response<Full<Bytes>>;
fn response(status: StatusCode, value: Value) -> HttpResponse {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::from(value.to_string())))
        .unwrap()
}
fn authenticated(headers: &hyper::HeaderMap, config: &Config) -> bool {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
    let expected = format!("127.0.0.1:{}", config.port);
    let alternate = format!("localhost:{}", config.port);
    config.enabled
        && matches!(host, Some(h) if h == expected || h == alternate)
        && !headers.contains_key(header::ORIGIN)
        && headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            == Some(format!("Bearer {}", config.token).as_str())
}
fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
}
fn tool_error(message: &str) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true})
}

async fn dispatch<F>(
    state: DesktopMcpState,
    request: Request<Incoming>,
    emit: F,
) -> Result<HttpResponse, Infallible>
where
    F: FnOnce(Value) -> Result<(), String> + Send,
{
    let config = state.inner.lock().unwrap().config.clone();
    if !authenticated(request.headers(), &config) {
        return Ok(response(
            StatusCode::UNAUTHORIZED,
            json!({"error":"MCP authentication required"}),
        ));
    }
    if request.uri().path() != "/mcp" {
        return Ok(response(
            StatusCode::NOT_FOUND,
            json!({"error":"Not found"}),
        ));
    }
    if request.method() != Method::POST {
        return Ok(response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"error":"Use POST; this MCP has no notification stream"}),
        ));
    }
    if !request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.split(';').next().unwrap_or("").trim() == "application/json")
    {
        return Ok(response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"error":"Use application/json"}),
        ));
    }
    let bytes = match Limited::new(request.into_body(), MAX_REQUEST_BYTES)
        .collect()
        .await
    {
        Ok(body) => body.to_bytes(),
        Err(_) => {
            return Ok(response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error":"Request body too large"}),
            ))
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            return Ok(response(
                StatusCode::BAD_REQUEST,
                rpc_error(Value::Null, -32700, "Parse error"),
            ))
        }
    };
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !value.get("method").is_some_and(Value::is_string)
    {
        return Ok(response(
            StatusCode::BAD_REQUEST,
            rpc_error(id, -32600, "Invalid request"),
        ));
    }
    let method = value["method"].as_str().unwrap();
    if !value.as_object().unwrap().contains_key("id") {
        return Ok(Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Full::new(Bytes::new()))
            .unwrap());
    }
    let result = match method {
        "initialize" => {
            json!({"protocolVersion":PROTOCOL,"capabilities":{"tools":{}},"serverInfo":{"name":"lynse-desktop","version":env!("CARGO_PKG_VERSION")},"instructions":"Read local and signed-in cloud Lynse data. Tools are read-only. The desktop app must remain running. Local notes excluded from AI context are not shared."})
        }
        "ping" => json!({}),
        "tools/list" => serde_json::from_str(include_str!("mcp-tools.json")).unwrap(),
        "tools/call" => {
            let name = value["params"]["name"].as_str().unwrap_or("");
            let definitions: Value = serde_json::from_str(include_str!("mcp-tools.json")).unwrap();
            if !definitions["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == name)
            {
                return Ok(response(
                    StatusCode::OK,
                    rpc_error(id, -32602, "Unknown tool"),
                ));
            }
            let request_id = Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();
            {
                let mut inner = state.inner.lock().unwrap();
                if !inner.config.enabled || inner.config.token != config.token {
                    return Ok(response(
                        StatusCode::UNAUTHORIZED,
                        json!({"error":"MCP disabled or token changed"}),
                    ));
                }
                if inner.pending.len() >= MAX_PENDING {
                    return Ok(response(
                        StatusCode::TOO_MANY_REQUESTS,
                        json!({"error":"Too many pending requests"}),
                    ));
                }
                inner.pending.insert(request_id.clone(), tx);
            }
            let emitted = emit(
                json!({"requestId":request_id,"name":name,"arguments":value["params"].get("arguments").cloned().unwrap_or(json!({}))}),
            );
            let result = if emitted.is_ok() {
                match tokio::time::timeout(Duration::from_secs(30), rx).await {
                    Ok(Ok(result)) => result,
                    _ => tool_error("Lynse is unavailable. Open the desktop app and retry."),
                }
            } else {
                tool_error("Lynse is unavailable. Open the desktop app and retry.")
            };
            state.inner.lock().unwrap().pending.remove(&request_id);
            result
        }
        _ => {
            return Ok(response(
                StatusCode::OK,
                rpc_error(id, -32601, "Method not found"),
            ))
        }
    };
    Ok(response(
        StatusCode::OK,
        json!({"jsonrpc":"2.0","id":id,"result":result}),
    ))
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("MCP settings belong to the main window".into())
    }
}
#[tauri::command]
pub fn desktop_mcp_get(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopMcpState>,
) -> Result<Config, String> {
    main_window(&window)?;
    state.load(&app)
}
#[tauri::command]
pub async fn desktop_mcp_configure(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopMcpState>,
    enabled: bool,
    port: u16,
    rotate: bool,
) -> Result<Config, String> {
    main_window(&window)?;
    state.configure(app, enabled, port, rotate).await
}
#[tauri::command]
pub fn desktop_mcp_complete(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopMcpState>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    main_window(&window)?;
    let mut inner = state.inner.lock().map_err(|_| "MCP state unavailable")?;
    if inner.config.enabled {
        if let Some(tx) = inner.pending.remove(&request_id) {
            let safe = if result.to_string().len() <= 2_000_000 {
                result
            } else {
                tool_error("Result too large; narrow your query.")
            };
            let _ = tx.send(safe);
        }
    }
    Ok(())
}

pub fn bootstrap(app: &AppHandle) {
    let state = app.state::<DesktopMcpState>().inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(config) = state.load(&app) {
            if config.enabled
                && state
                    .configure(app, true, config.port, false)
                    .await
                    .is_err()
            {
                // Preserve the saved preference; the settings page can retry a occupied port.
                state.inner.lock().unwrap().config.enabled = false;
                log::warn!("Local MCP could not start; check its port in settings");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authentication_requires_loopback_host_token_and_no_browser_origin() {
        let config = Config {
            enabled: true,
            ..Config::default()
        };
        let mut h = hyper::HeaderMap::new();
        h.insert(
            header::HOST,
            format!("127.0.0.1:{}", config.port).parse().unwrap(),
        );
        assert!(!authenticated(&h, &config));
        h.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", config.token).parse().unwrap(),
        );
        assert!(authenticated(&h, &config));
        h.insert(header::ORIGIN, "https://example.test".parse().unwrap());
        assert!(!authenticated(&h, &config));
        h.remove(header::ORIGIN);
        h.insert(header::HOST, "attacker.test:27125".parse().unwrap());
        assert!(!authenticated(&h, &config));
        h.insert(header::HOST, "localhost:27125".parse().unwrap());
        assert!(!authenticated(
            &h,
            &Config {
                enabled: false,
                ..config
            }
        ));
    }

    #[tokio::test]
    async fn http_transport_supports_mcp_handshake_calls_and_revocation() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let config = Config {
            enabled: true,
            port: listener.local_addr().unwrap().port(),
            ..Config::default()
        };
        let state = DesktopMcpState::default();
        state.inner.lock().unwrap().config = config.clone();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let state = server_state.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        let emitter_state = state.clone();
                        dispatch(state.clone(), request, move |payload| {
                            let mut inner = emitter_state.inner.lock().unwrap();
                            if payload["arguments"]["revoke"] == true {
                                inner.config.token = new_token();
                                inner.pending.clear();
                            } else if let Some(tx) =
                                inner.pending.remove(payload["requestId"].as_str().unwrap())
                            {
                                let _ = tx.send(json!({"content":[{"type":"text","text":"test data"}],"isError":false}));
                            }
                            Ok(())
                        })
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("http://127.0.0.1:{}/mcp", config.port);
        let call = |method: &str, params: Value| {
            client
                .post(&url)
                .bearer_auth(&config.token)
                .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        };
        assert_eq!(
            client
                .post(&url)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let init: Value = call("initialize", json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"test","version":"1"}})).send().await.unwrap().json().await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL);
        let notification = client
            .post(&url)
            .bearer_auth(&config.token)
            .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .send()
            .await
            .unwrap();
        assert_eq!(notification.status(), StatusCode::ACCEPTED);
        assert!(notification.bytes().await.unwrap().is_empty());
        let tools: Value = call("tools/list", json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 10);
        assert!(tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["annotations"]["readOnlyHint"] == true));
        let result: Value = call(
            "tools/call",
            json!({"name":"list_local_meetings","arguments":{}}),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(result["result"]["content"][0]["text"], "test data");
        assert_eq!(
            call("ping", json!({}))
                .header("Origin", "https://attacker.test")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let unknown: Value = call(
            "tools/call",
            json!({"name":"delete_meeting","arguments":{}}),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(unknown["error"]["code"], -32602);
        assert_eq!(
            client
                .post(&url)
                .bearer_auth(&config.token)
                .header("Content-Type", "application/json")
                .body("x".repeat(MAX_REQUEST_BYTES + 1))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let revoked: Value = call(
            "tools/call",
            json!({"name":"list_local_meetings","arguments":{"revoke":true}}),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(revoked["result"]["isError"], true);
        assert_eq!(
            call("ping", json!({})).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(state.inner.lock().unwrap().pending.is_empty());
        server.abort();
    }
}
