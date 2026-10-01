//! Native macOS window material — the standard frosted sidebar look.
//!
//! Installs an `NSVisualEffectView` with the `sidebar` material behind the
//! webview, exactly what Notes / Finder / Finder-style apps use for their
//! sidebars: the desktop shows through as a neutral blur that follows the
//! system light/dark appearance, without refraction.
//!
//! The material is installed *behind* the webview, so it blends with the
//! desktop. It can never sample web content — anything that needs to blur the
//! page itself has to use CSS `backdrop-filter` in the DOM.
//!
//! If vibrancy is unavailable the renderer falls back to a fully opaque
//! background (`WindowEffects::None`).

use std::sync::OnceLock;

use tauri::{Emitter, Manager, WebviewWindow};

#[cfg(target_os = "macos")]
use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};

/// Event emitted once the material is resolved. Payload is the `&str` form of
/// [`WindowEffects`].
pub(crate) const WINDOW_EFFECTS_EVENT: &str = "lynse://window-effects";

/// Which native material is painted behind the webview.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowEffects {
    /// `NSVisualEffectView` using the sidebar material.
    Vibrancy,
    /// Nothing installed — the renderer must paint its own background.
    None,
}

impl WindowEffects {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            WindowEffects::Vibrancy => "vibrancy",
            WindowEffects::None => "none",
        }
    }
}

static WINDOW_EFFECTS: OnceLock<WindowEffects> = OnceLock::new();

/// Reports the material that was actually installed so the renderer knows
/// whether it may leave the sidebar transparent.
#[tauri::command]
pub fn window_effects_mode() -> &'static str {
    WINDOW_EFFECTS
        .get()
        .copied()
        .unwrap_or(WindowEffects::None)
        .as_str()
}

/// Installs the window material on the main window.
pub(crate) fn apply_window_effects(window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        // `with_webview` defers the closure until the WKWebView exists and then
        // runs it on the main thread, which both AppKit and window-vibrancy
        // require. The closure must own its captures (it runs later), so clone
        // into it; the `window` we call `with_webview` on is a separate clone.
        let window_for_effect = window.clone();
        let app = window.app_handle().clone();
        window.with_webview(move |webview| {
            let mode = unsafe {
                install_macos_material(
                    &window_for_effect,
                    &webview,
                    NSVisualEffectMaterial::Sidebar,
                    None,
                    None,
                )
            };
            let _ = WINDOW_EFFECTS.set(mode);
            let _ = app.emit(WINDOW_EFFECTS_EVENT, mode.as_str());
        })?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = window;

    Ok(())
}

/// Installs the frosted material on the recording-island floating window.
///
/// Uses the `popover` material (what floating panels use) kept permanently
/// active — an always-on-top island must look identical whether or not it has
/// keyboard focus. `corner_radius` should equal half the collapsed island
/// height so the frost traces the capsule; the expanded transcript drawer
/// keeps the same radius, which reads as a dynamic-island style expansion.
///
/// Does not touch [`WINDOW_EFFECTS`] / the mode event: those report the main
/// window's sidebar material, which is what renderer chrome keys off.
pub(crate) fn apply_island_effects(
    window: &WebviewWindow,
    corner_radius: f64,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let window_for_effect = window.clone();
        window.with_webview(move |webview| {
            unsafe {
                install_macos_material(
                    &window_for_effect,
                    &webview,
                    NSVisualEffectMaterial::Popover,
                    Some(NSVisualEffectState::Active),
                    Some(corner_radius),
                );
            }
        })?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        let _ = corner_radius;
    }

    Ok(())
}

/// # Safety
///
/// `webview` must hand back live AppKit pointers, and every call happens on the
/// main thread (guaranteed by `with_webview`).
#[cfg(target_os = "macos")]
unsafe fn install_macos_material(
    window: &WebviewWindow,
    webview: &tauri::webview::PlatformWebview,
    material: NSVisualEffectMaterial,
    state: Option<NSVisualEffectState>,
    radius: Option<f64>,
) -> WindowEffects {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow};
    use window_vibrancy::apply_vibrancy;

    let Some(mtm) = MainThreadMarker::new() else {
        return WindowEffects::None;
    };

    let webview_ptr = webview.inner() as *mut NSView;
    let window_ptr = webview.ns_window() as *mut NSWindow;
    if webview_ptr.is_null() || window_ptr.is_null() {
        return WindowEffects::None;
    }

    let webview_view: &NSView = &*webview_ptr;
    let ns_window: &NSWindow = &*window_ptr;

    // wry installs the WKWebView *as* the window's content view. `apply_vibrancy`
    // inserts its effect view as a subview of whatever view it is given, which
    // would bury the material inside the page instead of behind it. Swap in a
    // plain container first so the effect view can sit underneath the webview.
    let bounds = webview_view.bounds();
    let container = NSView::initWithFrame(mtm.alloc(), bounds);
    container.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    webview_view.removeFromSuperview();
    ns_window.setContentView(Some(&container));
    container.addSubview(webview_view);
    webview_view.setFrame(container.bounds());
    // Fill the container and follow it when the window resizes.
    webview_view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );

    // The main window keeps radius 0 (the system already rounds transparent
    // windows); the island passes its capsule radius explicitly.
    match apply_vibrancy(window, material, state, radius) {
        Ok(()) => WindowEffects::Vibrancy,
        Err(error) => {
            log::warn!("Window vibrancy unavailable: {error}");
            WindowEffects::None
        }
    }
}
