//! WeChat OAuth sign-in window.
//!
//! The backend's WECHAT_JUMP flow (`GET /api/auth/render`) hands back a WeChat
//! authorize URL; after the scan is confirmed WeChat redirects the browser to
//! the backend-configured `redirect_uri` with `?code=…&state=…`. The desktop
//! app can never be that redirect target, so instead of the system browser
//! the authorize page opens in a small embedded window and this module
//! intercepts the redirect navigation before it loads: the callback URL is
//! forwarded to the main window as a `wechat-auth-callback` event and the
//! window closes itself. The redirect_uri may move server-side without
//! notice, so the match is on the `code`/`state` query pair, never a host.

use crate::CommandResult;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const WINDOW_LABEL: &str = "wechat-auth";
const CALLBACK_EVENT: &str = "wechat-auth-callback";
const WINDOW_WIDTH: f64 = 480.0;
const WINDOW_HEIGHT: f64 = 620.0;

fn is_wechat_callback(url: &tauri::Url) -> bool {
    let has = |key: &str| url.query_pairs().any(|(k, _)| k == key);
    has("code") && has("state")
}

/// Desktop Safari UA. WeChat's oauth2/authorize page refuses to render in a
/// plain WKWebView ("请在微信客户端打开链接"); with a desktop-browser UA it
/// serves the PC QR page, and the scan redirects this window with code+state.
const DESKTOP_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

/// Open the WeChat authorize page in the embedded auth window. Any previous
/// window (e.g. parked on a WeChat error page) is replaced.
#[tauri::command]
pub(crate) fn wechat_auth_window(app: AppHandle, url: String) -> CommandResult<()> {
    log::info!("[wechat-auth] opening authorize window");
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.close();
    }
    let authorize_url: tauri::Url = url
        .parse()
        .map_err(|error| format!("invalid wechat authorize url: {error}"))?;
    let app_for_nav = app.clone();
    let window = WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        WebviewUrl::External(authorize_url),
    )
    .title("WeChat")
    .user_agent(DESKTOP_UA)
    .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
    .min_inner_size(360.0, 480.0)
    // Created hidden and revealed on page-load-finished (the About window
    // pattern): a runtime-created window shown before its webview is ready
    // never makes it onscreen on macOS.
    .visible(false)
    .on_page_load(|window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .on_navigation(move |nav| {
        if !is_wechat_callback(nav) {
            return true;
        }
        let _ = app_for_nav.emit(CALLBACK_EVENT, nav.to_string());
        // Close off-thread: closing from inside the navigation policy
        // callback deadlocks on macOS (WKWebView is still inside
        // decidePolicyFor).
        let app = app_for_nav.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = window.close();
            }
        });
        false
    })
    .build()
    .map_err(|error| format!("failed to create wechat auth window: {error}"))?;
    let _ = window.center();
    Ok(())
}

/// Close the auth window when the user cancels the sign-in from the login UI.
#[tauri::command]
pub(crate) fn wechat_auth_window_close(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(())
}
