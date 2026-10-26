//! WeChat OAuth sign-in window.
//!
//! The backend's WECHAT_SCAN flow (`GET /api/auth/render`) hands back a WeChat
//! authorize URL; after the scan is confirmed WeChat redirects the browser to
//! the backend-configured `redirect_uri` with `?code=…&state=…`. The desktop
//! app can never be that redirect target, so instead of the system browser
//! the authorize page opens in a small embedded window and this module
//! intercepts the redirect navigation before it loads: the callback URL is
//! forwarded to the main window as a `wechat-auth-callback` event and the
//! window closes itself. Only the redirect_uri and state from this login
//! attempt can complete it.

use crate::CommandResult;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const WINDOW_LABEL: &str = "wechat-auth";
const CALLBACK_EVENT: &str = "wechat-auth-callback";
const WINDOW_WIDTH: f64 = 480.0;
const WINDOW_HEIGHT: f64 = 620.0;

fn is_wechat_callback(url: &tauri::Url, callback: &tauri::Url, state: &str) -> bool {
    url.origin() == callback.origin()
        && url.path() == callback.path()
        && url
            .query_pairs()
            .any(|(key, value)| key == "state" && value == state)
        && url
            .query_pairs()
            .any(|(key, value)| (key == "code" || key == "error") && !value.is_empty())
}

/// Use a desktop browser UA for the Open Platform QR page.
const DESKTOP_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

/// Open the WeChat authorize page in the embedded auth window. Any previous
/// window (e.g. parked on a WeChat error page) is replaced.
///
/// MUST stay `async`: Tauri's window builder deadlocks inside a synchronous
/// command on Windows (the WebView2 controller never finishes creating, so
/// the window stays hidden and every later IPC call hangs). See
/// `WebviewWindowBuilder::build` — "Known issues".
#[tauri::command]
pub(crate) async fn wechat_auth_window(app: AppHandle, url: String) -> CommandResult<()> {
    log::info!("[wechat-auth] opening authorize window");
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.close();
        // The manager drops the label on the event loop, not on close(): wait
        // briefly so the rebuild cannot trip over "webview label already exists".
        for _ in 0..100 {
            if app.get_webview_window(WINDOW_LABEL).is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let authorize_url: tauri::Url = url
        .parse()
        .map_err(|error| format!("invalid wechat authorize url: {error}"))?;
    if authorize_url.origin().ascii_serialization() != "https://open.weixin.qq.com"
        || authorize_url.path() != "/connect/qrconnect"
    {
        return Err("invalid wechat QR authorize endpoint".into());
    }
    let param = |key: &str| {
        authorize_url
            .query_pairs()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
            .filter(|value| !value.is_empty())
    };
    let callback: tauri::Url = param("redirect_uri")
        .ok_or("missing wechat redirect_uri")?
        .parse()
        .map_err(|error| format!("invalid wechat redirect_uri: {error}"))?;
    if !matches!(callback.scheme(), "https" | "http") {
        return Err("invalid wechat callback scheme".into());
    }
    let state = param("state").ok_or("missing wechat state")?;
    let callback_sent = AtomicBool::new(false);
    let app_for_nav = app.clone();
    let window = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(authorize_url))
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
                log::info!("[wechat-auth] page load finished, revealing");
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .on_navigation(move |nav| {
            if !is_wechat_callback(nav, &callback, &state) {
                return true;
            }
            if callback_sent.swap(true, Ordering::SeqCst) {
                return false;
            }
            log::info!("[wechat-auth] callback redirect intercepted");
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
    log::info!("[wechat-auth] window built");
    let _ = window.center();
    #[cfg(target_os = "windows")]
    crate::ensure_window_revealed(&app, WINDOW_LABEL);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_is_bound_to_server_path_and_state() {
        let callback = "https://api.lynse.cn/auth/wechat/callback".parse().unwrap();
        for url in [
            "https://api.lynse.cn/auth/wechat/callback?code=once&state=expected",
            "https://api.lynse.cn/auth/wechat/callback?error=access_denied&state=expected",
        ] {
            assert!(is_wechat_callback(
                &url.parse().unwrap(),
                &callback,
                "expected"
            ));
        }
        for url in [
            "https://www.lynse.cn/auth/wechat/callback?code=once&state=expected",
            "https://gapp.lynse.cn/auth/wechat/callback?code=once&state=expected",
            "https://api.lynse.cn/other?code=once&state=expected",
            "https://api.lynse.cn/auth/wechat/callback?code=once&state=other",
            "https://api.lynse.cn/auth/wechat/callback?code=&state=expected",
            "https://api.lynse.cn/auth/wechat/callback?code=once",
        ] {
            assert!(!is_wechat_callback(
                &url.parse().unwrap(),
                &callback,
                "expected"
            ));
        }
    }
}
