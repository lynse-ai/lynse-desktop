//! Notch ("Dynamic Island") geometry for the macOS recording island.
//!
//! On MacBook Pro/Air displays the camera housing leaves a hardware notch at
//! the top-center of the screen. A borderless window pinned flush to the top
//! edge and centered on that notch reads as an island growing out of it —
//! exactly how dedicated notch apps fake the iPhone Dynamic Island.
//!
//! The notch's exact bounds are never hard-coded: `NSScreen.safeAreaInsets`
//! reports whether the display has a cutout, and the two
//! `auxiliaryTop{Left,Right}Area` rectangles around it give its width and
//! horizontal center. Displays without a cutout yield `None` everywhere, so
//! the island falls back to its floating-pill positioning.

/// Geometry of the display notch, in logical points. `center_x` is expressed
/// in Tauri's desktop space (top-left origin): the x axis matches NSScreen's
/// bottom-left origin exactly. The island is a full stadium capsule hung
/// *below* the cutout, so `height` doubles as its top-edge y offset (0 for
/// the synthetic fake-island geometry on notchless displays).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct NotchGeometry {
    /// Horizontal center of the notch on its screen.
    pub(crate) center_x: f64,
    /// Width of the cutout.
    pub(crate) width: f64,
    /// Height of the cutout (= the screen's top safe-area inset).
    pub(crate) height: f64,
}

/// Horizontal extent of one `auxiliaryTop*Area` rectangle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct AuxExtent {
    pub(crate) min_x: f64,
    pub(crate) max_x: f64,
}

/// Derives the notch's center and width from the two menu-bar areas flanking
/// it. `None` when the areas touch or overlap — i.e. there is no cutout
/// between them.
pub(crate) fn notch_from_auxiliary(left: AuxExtent, right: AuxExtent) -> Option<(f64, f64)> {
    if right.min_x <= left.max_x {
        return None;
    }
    Some(((left.max_x + right.min_x) / 2.0, right.min_x - left.max_x))
}

/// Height of the docked island's collapsed mini capsule — proportions match
/// the cutout itself (~1:5), so the silhouette reads as the notch extending
/// downward into a rounded island rather than a thin strip below it.
pub(crate) const MINI_ISLAND_HEIGHT: f64 = 36.0;

/// Logical size of the notch-mode island in its collapsed (mini) state —
/// a full stadium capsule whose width hugs the cutout exactly (clamped to
/// what the compact UI can render on notchless displays).
pub(crate) fn compact_island_size(notch_width: f64) -> (f64, f64) {
    (notch_width.max(180.0), MINI_ISLAND_HEIGHT)
}

/// Detects the display notch by asking AppKit. Must run on the main thread
/// (returns `None` elsewhere); callers working off-main route it through
/// `run_on_main_thread`. Only the built-in retina display has a cutout, so
/// external-monitor-only setups naturally fall back.
#[cfg(target_os = "macos")]
pub(crate) fn detect_notch() -> Option<NotchGeometry> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;

    let mtm = MainThreadMarker::new()?;
    let screens = NSScreen::screens(mtm);
    let screen = screens
        .iter()
        .find(|screen| screen.safeAreaInsets().top > 0.0)?;
    let insets = screen.safeAreaInsets();
    // aux areas are zero rects when there is no cutout; `notch_from_auxiliary`
    // rejects that degenerate case along with real overlaps.
    let left_area = screen.auxiliaryTopLeftArea();
    let right_area = screen.auxiliaryTopRightArea();
    let (center_x, width) = notch_from_auxiliary(
        AuxExtent {
            min_x: left_area.origin.x,
            max_x: left_area.origin.x + left_area.size.width,
        },
        AuxExtent {
            min_x: right_area.origin.x,
            max_x: right_area.origin.x + right_area.size.width,
        },
    )?;
    Some(NotchGeometry {
        center_x,
        width,
        // 1pt upward overlap: the capsule must fuse with the cutout with no
        // hairline gap between the two black surfaces (subpixel rounding
        // would otherwise leave a visible seam). Both surfaces are black, so
        // the overlap is invisible.
        height: (insets.top - 1.0).max(0.0),
    })
}

/// Non-macOS builds never have a notch; the island stays a floating pill.
#[cfg(not(target_os = "macos"))]
pub(crate) fn detect_notch() -> Option<NotchGeometry> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extent(min_x: f64, max_x: f64) -> AuxExtent {
        AuxExtent { min_x, max_x }
    }

    #[test]
    fn notch_from_auxiliary_measures_center_and_width() {
        // Typical 14" MacBook Pro: menu bar left of the notch ends at 200,
        // right of it starts at 385.
        let notch = notch_from_auxiliary(extent(0.0, 200.0), extent(385.0, 1440.0));
        assert_eq!(notch, Some((292.5, 185.0)));
    }

    #[test]
    fn notch_from_auxiliary_rejects_zero_rects() {
        // No cutout: both aux areas start at x=0 (zero rect on the left side
        // normalizes to min_x = max_x = 0).
        let notch = notch_from_auxiliary(extent(0.0, 0.0), extent(0.0, 0.0));
        assert_eq!(notch, None);
    }

    #[test]
    fn notch_from_auxiliary_rejects_touching_and_overlapping_areas() {
        assert_eq!(notch_from_auxiliary(extent(0.0, 200.0), extent(200.0, 400.0)), None);
        assert_eq!(notch_from_auxiliary(extent(0.0, 300.0), extent(250.0, 400.0)), None);
    }

    #[test]
    fn compact_size_hugs_the_notch_at_island_proportions() {
        // The capsule is exactly the cutout's width, so it reads as the notch
        // extending downward rather than a wider strip floating below it.
        assert_eq!(compact_island_size(185.0), (185.0, 36.0));
        // Tiny cutouts and the fake-island fallback clamp to the minimum the
        // compact UI can render in.
        assert_eq!(compact_island_size(100.0), (180.0, 36.0));
        assert_eq!(compact_island_size(0.0), (180.0, 36.0));
    }
}
