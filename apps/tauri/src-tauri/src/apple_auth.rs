//! Apple sign-in authorize window (backend-mediated form-post contract).
//!
//! `GET /api/auth/render?authType=APPLE` hands back the Apple authorize URL;
//! appleid.apple.com form-POSTs the one-time `code` + `state` to the
//! BACKEND's `/api/auth/apple/callback`, which validates the state, exchanges
//! the code and 302s the window to the backend-configured web landing pages:
//! web-success-url#token=…&expireIn=… (bound account), web-bind-url
//! ?thirdPartyId={apple_sub} (first login) or web-bind-url?error={key}
//! (failure). The window follows every navigation and only intercepts that
//! final landing — matched by the expected web origin carrying one of the
//! landing markers — forwarding the URL to the main window as an
//! `apple-auth-callback` event and closing itself. The renderer derives the
//! landing origin from the API host (`core/auth/apple.ts`), so the backend
//! config stays the single source of truth.

use crate::CommandResult;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const WINDOW_LABEL: &str = "apple-auth";
const CALLBACK_EVENT: &str = "apple-auth-callback";
const WINDOW_WIDTH: f64 = 480.0;
const WINDOW_HEIGHT: f64 = 680.0;

fn is_apple_landing(url: &tauri::Url, landing: &tauri::Url) -> bool {
    if url.origin() != landing.origin() {
        return false;
    }
    // Bound account: the session rides the fragment (never sent to a server).
    let fragment_token = url.fragment().map_or(false, |fragment| {
        fragment.split('&').any(|pair| {
            pair.strip_prefix("token=").map_or(false, |token| !token.is_empty())
        })
    });
    if fragment_token {
        return true;
    }
    // First login or failure: web-bind-url?thirdPartyId={sub} / ?error={key}.
    url.query_pairs().any(|(key, value)| {
        (key == "thirdPartyId" || key == "error") && !value.is_empty()
    })
}

/// Open the Apple authorize page in the embedded auth window. Any previous
/// window is replaced. MUST stay `async` — see wechat_auth.rs.
#[tauri::command]
pub(crate) async fn apple_auth_window(
    app: AppHandle,
    url: String,
    landing_origin: String,
) -> CommandResult<()> {
    log::info!("[apple-auth] opening authorize window");
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
        .map_err(|error| format!("invalid apple authorize url: {error}"))?;
    if authorize_url.scheme() != "https" && authorize_url.host_str() != Some("localhost") {
        return Err("apple authorize url must use https".into());
    }
    let landing: tauri::Url = landing_origin
        .parse()
        .map_err(|error| format!("invalid apple landing origin: {error}"))?;
    if !matches!(landing.scheme(), "https" | "http" | "lynse") {
        return Err("invalid apple landing scheme".into());
    }
    let callback_sent = AtomicBool::new(false);
    let app_for_nav = app.clone();
    let window = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(authorize_url))
        .title("Apple")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(360.0, 480.0)
        // Created hidden and revealed on page-load-finished (the About window
        // pattern): a runtime-created window shown before its webview is ready
        // never makes it onscreen on macOS.
        .visible(false)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                log::info!("[apple-auth] page load finished, revealing");
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .on_navigation(move |nav| {
            if !is_apple_landing(nav, &landing) {
                return true;
            }
            if callback_sent.swap(true, Ordering::SeqCst) {
                return false;
            }
            log::info!("[apple-auth] landing redirect intercepted");
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
        .map_err(|error| format!("failed to create apple auth window: {error}"))?;
    log::info!("[apple-auth] window built");
    let _ = window.center();
    #[cfg(target_os = "windows")]
    crate::ensure_window_revealed(&app, WINDOW_LABEL);
    Ok(())
}

/// Close the auth window when the user cancels the sign-in from the login UI.
#[tauri::command]
pub(crate) fn apple_auth_window_close(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn landing_is_bound_to_origin_and_markers() {
        let landing = "https://www.lynse.cn".parse().unwrap();
        for url in [
            // Bound account: session token in the fragment.
            "https://www.lynse.cn/app#token=secret&expireIn=3600",
            // First login: the identity handle rides the query.
            "https://www.lynse.cn/bind?thirdPartyId=apple-sub-1",
            // Failure: the backend error key.
            "https://www.lynse.cn/bind?error=error.apple.state.invalid",
            // Both markers on one URL — still the landing.
            "https://www.lynse.cn/bind?authType=APPLE&thirdPartyId=x&error=y",
        ] {
            assert!(is_apple_landing(&url.parse().unwrap(), &landing));
        }
        for url in [
            // Wrong origin — the landing must be the renderer-supplied one.
            "https://www.lynse.ai/bind?thirdPartyId=x",
            "https://api.lynse.cn/bind?thirdPartyId=x",
            "https://evil.example/app#token=secret",
            // Fragment without a token payload.
            "https://www.lynse.cn/app#section",
            "https://www.lynse.cn/app#token=",
            "https://www.lynse.cn/app",
            // Empty marker values.
            "https://www.lynse.cn/bind?thirdPartyId=",
            "https://www.lynse.cn/bind?error=",
            // Plain site navigation (agreement pages etc. opened in-window).
            "https://www.lynse.cn/policy/policy-viewer.html?md=terms-cn.md",
        ] {
            assert!(!is_apple_landing(&url.parse().unwrap(), &landing));
        }
    }
}
