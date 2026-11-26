//! Google sign-in window (Firebase-redirect relay contract).
//!
//! Google blocks OAuth inside embedded WebViews, so the sign-in cannot ride
//! the Firebase popup the web app uses. Instead the desktop opens a standalone
//! auth window on the web app's relay page
//! (`<web origin>/auth/google-desktop?nonce=…`), which immediately runs the
//! Firebase `signInWithRedirect` round trip INSIDE the window (accounts.goo
//! gle.com consent → back to the relay page), exchanges the redirect result
//! for the Firebase ID token and finally navigates to the done-marker URL:
//!
//!   <web origin>/auth/google-desktop/done#identityToken=…&nonce=…
//!   (failure: ?error=…&nonce=…)
//!
//! The window intercepts that navigation before it loads — matched by the
//! done path on the expected web origin carrying the expected nonce — and
//! forwards the URL to the main window as a `google-auth-callback` event,
//! closing itself. Same interception pattern as `apple_auth`; the nonce binds
//! the landing to this specific attempt so a replayed or forged URL cannot
//! complete an older (or someone else's) sign-in.

use crate::CommandResult;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const WINDOW_LABEL: &str = "google-auth";
const CALLBACK_EVENT: &str = "google-auth-callback";
const WINDOW_WIDTH: f64 = 480.0;
const WINDOW_HEIGHT: f64 = 680.0;
/// The relay page's done-marker path (web app route, see
/// `apps/web/app/auth/google-desktop`).
const DONE_PATH: &str = "/auth/google-desktop/done";

/// The done-marker URL this flow waits for: the expected web origin, the
/// done path, the expected nonce, and one of the outcome markers — the
/// Firebase ID token in the fragment (never sent to any server) or an error
/// key in the query. The path is matched by suffix because production web
/// deployments serve the app under a basePath (`/app`), which the relay page
/// reproduces on its done marker; bare-path local dev matches the same way.
fn is_google_landing(url: &tauri::Url, origin: &tauri::Url, nonce: &str) -> bool {
    if url.origin() != origin.origin() || !url.path().ends_with(DONE_PATH) {
        return false;
    }
    let carries_nonce = url
        .query_pairs()
        .any(|(key, value)| key == "nonce" && value == nonce)
        || url
            .fragment()
            .map(|fragment| {
                fragment.split('&').any(|pair| {
                    pair.strip_prefix("nonce=").map_or(false, |value| value == nonce)
                })
            })
            .unwrap_or(false);
    if !carries_nonce {
        return false;
    }
    let fragment_token = url.fragment().map_or(false, |fragment| {
        fragment.split('&').any(|pair| {
            pair.strip_prefix("identityToken=")
                .map_or(false, |token| !token.is_empty())
        })
    });
    if fragment_token {
        return true;
    }
    url.query_pairs()
        .any(|(key, value)| key == "error" && !value.is_empty())
}

/// Open the Google relay page in the standalone auth window. Any previous
/// window is replaced. MUST stay `async` — see wechat_auth.rs.
#[tauri::command]
pub(crate) async fn google_auth_window(
    app: AppHandle,
    url: String,
    landing_origin: String,
    nonce: String,
) -> CommandResult<()> {
    log::info!("[google-auth] opening authorize window");
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
        .map_err(|error| format!("invalid google relay url: {error}"))?;
    if authorize_url.scheme() != "https" {
        return Err("google relay url must use https".into());
    }
    let origin: tauri::Url = landing_origin
        .parse()
        .map_err(|error| format!("invalid google landing origin: {error}"))?;
    if origin.scheme() != "https" {
        return Err("invalid google landing origin".into());
    }
    if nonce.is_empty() || nonce.len() > 128 {
        return Err("invalid google auth nonce".into());
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
                log::info!("[google-auth] page load finished, revealing");
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .on_navigation(move |nav| {
            if !is_google_landing(nav, &origin, &nonce) {
                return true;
            }
            if callback_sent.swap(true, Ordering::SeqCst) {
                return false;
            }
            log::info!("[google-auth] done marker intercepted");
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
        .map_err(|error| format!("failed to create google auth window: {error}"))?;
    log::info!("[google-auth] window built");
    let _ = window.center();
    #[cfg(target_os = "windows")]
    crate::ensure_window_revealed(&app, WINDOW_LABEL);
    Ok(())
}

/// Close the auth window when the user cancels the sign-in from the login UI.
#[tauri::command]
pub(crate) fn google_auth_window_close(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://www.lynse.ai";

    fn landing(fragment: &str, query: &str) -> tauri::Url {
        let mut url = format!("{ORIGIN}{DONE_PATH}");
        if !query.is_empty() {
            url.push('?');
            url.push_str(query);
        }
        if !fragment.is_empty() {
            url.push('#');
            url.push_str(fragment);
        }
        url.parse().unwrap()
    }

    fn raw(url: &str) -> tauri::Url {
        url.parse().unwrap()
    }

    #[test]
    fn landing_is_bound_to_origin_path_and_nonce() {
        let origin: tauri::Url = ORIGIN.parse().unwrap();
        for url in [
            // Success: the Firebase ID token rides the fragment, with the
            // nonce beside it…
            landing("identityToken=jwt.a.b&nonce=n1", ""),
            // …or in the query while the token stays in the fragment.
            landing("identityToken=jwt", "nonce=n1"),
            // Failure: the relay page's error key.
            landing("", "error=auth%2Fnetwork-request-failed&nonce=n1"),
            // Production deployments serve the app under the /app basePath;
            // the relay page reproduces the prefix on its done marker.
            raw(&format!("{ORIGIN}/app{DONE_PATH}?nonce=n1#identityToken=jwt")),
        ] {
            assert!(is_google_landing(&url, &origin, "n1"), "should match: {url}");
        }
        for url in [
            // Wrong origin, path, or nonce — never the landing.
            raw("https://www.lynse.cn/auth/google-desktop/done#identityToken=jwt&nonce=n1"),
            raw("https://evil.example/auth/google-desktop/done#identityToken=jwt&nonce=n1"),
            landing("identityToken=jwt&nonce=other", ""),
            landing("identityToken=jwt", ""),
            // Nonce alone without an outcome marker carries nothing to relay.
            landing("", "nonce=n1"),
            // Markers without values.
            landing("identityToken=&nonce=n1", ""),
            landing("", "error=&nonce=n1"),
            // The relay page itself (pre-redirect) is not the landing.
            raw("https://www.lynse.ai/auth/google-desktop?nonce=n1"),
            raw(&format!("{ORIGIN}/app/auth/google-desktop?nonce=n1")),
            // Unrelated site navigation (Firebase handler, Google consent,
            // policy pages opened in-window).
            raw("https://www.lynse.ai/auth/google/done#identityToken=jwt&nonce=n1"),
            raw("https://accounts.google.com/signin/oauth#identityToken=x"),
        ] {
            assert!(!is_google_landing(&url, &origin, "n1"), "should not match: {url}");
        }
    }
}
