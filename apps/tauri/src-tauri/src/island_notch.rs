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

/// Height of the docked island's collapsed mini capsule — slimmer than the
/// 44pt floating pill row, since it only carries the dot, timer and waveform
/// (controls only appear on hover at the full 44pt bar).
pub(crate) const MINI_ISLAND_HEIGHT: f64 = 32.0;

/// Logical size of the notch-mode island in its collapsed (mini) state —
/// a full stadium capsule (no notch-filling square top), so the height is
/// the slim mini row and the width is the notch plus a small lip (clamped
/// to what the compact UI can render in).
pub(crate) fn compact_island_size(notch_width: f64) -> (f64, f64) {
    ((notch_width + 40.0).max(200.0), MINI_ISLAND_HEIGHT)
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
        height: insets.top,
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
    fn compact_size_is_wider_than_the_notch_at_mini_height() {
        // Typical notch gets a small horizontal lip; the capsule is always the
        // slim mini height (stadium shape, controls live on the hover bar).
        assert_eq!(compact_island_size(185.0), (225.0, 32.0));
        // Tiny cutouts clamp up to the minimum the compact UI can render in.
        assert_eq!(compact_island_size(100.0), (200.0, 32.0));
        assert_eq!(compact_island_size(0.0), (200.0, 32.0));
    }
}
