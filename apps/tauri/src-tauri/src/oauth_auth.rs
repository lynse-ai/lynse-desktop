//! Generic OAuth authorize window (Lynse account-center SSO).
//!
//! Same interception pattern as `wechat_auth`, but the authorize URL and the
//! redirect target are caller-supplied: the account center's authorize page
//! opens in a small embedded window and the navigation to the registered
//! `redirect_uri` (which carries `code` or `error` plus `state`) is caught
//! before it loads. The URL is relayed to the main window as an
//! `oauth-auth-callback` event and the window closes itself. Only a redirect
//! to the exact callback origin+path carrying the expected `state` matches.

use crate::CommandResult;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const WINDOW_LABEL: &str = "oauth-auth";
const CALLBACK_EVENT: &str = "oauth-auth-callback";
const WINDOW_WIDTH: f64 = 480.0;
const WINDOW_HEIGHT: f64 = 680.0;

fn is_oauth_callback(url: &tauri::Url, callback: &tauri::Url, state: &str) -> bool {
    url.origin() == callback.origin()
        && url.path() == callback.path()
        && url
            .query_pairs()
            .any(|(key, value)| key == "state" && value == state)
        && url
            .query_pairs()
            .any(|(key, value)| (key == "code" || key == "error") && !value.is_empty())
}

/// Open the account-center authorize page in the embedded auth window.
/// Any previous window is replaced. MUST stay `async` — see wechat_auth.rs.
#[tauri::command]
pub(crate) async fn oauth_auth_window(
    app: AppHandle,
    url: String,
    callback: String,
    state: String,
) -> CommandResult<()> {
    log::info!("[oauth-auth] opening authorize window");
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
        .map_err(|error| format!("invalid oauth authorize url: {error}"))?;
    if authorize_url.scheme() != "https" && authorize_url.host_str() != Some("localhost") {
        return Err("oauth authorize url must use https".into());
    }
    let callback_url: tauri::Url = callback
        .parse()
        .map_err(|error| format!("invalid oauth callback url: {error}"))?;
    if !matches!(callback_url.scheme(), "https" | "http" | "lynse") {
        return Err("invalid oauth callback scheme".into());
    }
    if state.is_empty() || state.len() > 512 {
        return Err("invalid oauth state".into());
    }
    let callback_sent = AtomicBool::new(false);
    let app_for_nav = app.clone();
    let window = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(authorize_url))
        .title("Lynse")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(360.0, 480.0)
        // Created hidden and revealed on page-load-finished (the About window
        // pattern): a runtime-created window shown before its webview is ready
        // never makes it onscreen on macOS.
        .visible(false)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                log::info!("[oauth-auth] page load finished, revealing");
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .on_navigation(move |nav| {
            if !is_oauth_callback(nav, &callback_url, &state) {
                return true;
            }
            if callback_sent.swap(true, Ordering::SeqCst) {
                return false;
            }
            log::info!("[oauth-auth] callback redirect intercepted");
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
        .map_err(|error| format!("failed to create oauth auth window: {error}"))?;
    log::info!("[oauth-auth] window built");
    let _ = window.center();
    #[cfg(target_os = "windows")]
    crate::ensure_window_revealed(&app, WINDOW_LABEL);
    Ok(())
}

/// Close the auth window when the user cancels the sign-in from the login UI.
#[tauri::command]
pub(crate) fn oauth_auth_window_close(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_is_bound_to_path_and_state() {
        let callback = "https://sso.example.test/oauth/desktop-callback"
            .parse()
            .unwrap();
        for url in [
            "https://sso.example.test/oauth/desktop-callback?code=once&state=expected",
            "https://sso.example.test/oauth/desktop-callback?error=access_denied&state=expected",
        ] {
            assert!(is_oauth_callback(
                &url.parse().unwrap(),
                &callback,
                "expected"
            ));
        }
        for url in [
            "https://evil.example/oauth/desktop-callback?code=once&state=expected",
            "https://sso.example.test/other?code=once&state=expected",
            "https://sso.example.test/oauth/desktop-callback?code=once&state=other",
            "https://sso.example.test/oauth/desktop-callback?code=&state=expected",
            "https://sso.example.test/oauth/desktop-callback?code=once",
        ] {
            assert!(!is_oauth_callback(
                &url.parse().unwrap(),
                &callback,
                "expected"
            ));
        }
    }
}
