import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "@lynse/ui/components/common/theme-provider";

/**
 * Mirror the app's theme setting onto the native window appearance.
 *
 * The vibrancy material behind the webview (NSVisualEffectView) renders with
 * the window's appearance, which by default tracks the macOS system setting,
 * while the CSS `.dark` class follows the in-app theme (default dark). Left
 * unsynced, a dark app theme on a light system paints the frosted sidebar rail
 * and the margins around the content card light behind dark UI. An explicit
 * light/dark choice pins the window appearance to match the CSS; "system"
 * clears the override so the material follows macOS again.
 */
export function NativeThemeSync() {
  const { theme, resolvedTheme } = useTheme();

  useEffect(() => {
    // next-themes reports undefined until after mount; the rerender once the
    // theme is resolved drives this effect again.
    if (!theme) return;
    const appearance =
      theme === "system" ? null : resolvedTheme === "dark" ? "dark" : "light";
    getCurrentWindow()
      .setTheme(appearance)
      .catch((error) => {
        // Missing capability or platform without a settable theme — surface it
        // (the logger pipes console output into the app log) instead of failing
        // silently: a denied call here reads as a light sidebar on a dark UI.
        console.warn("[native-theme] setTheme(%s) failed:", appearance, error);
      });
  }, [theme, resolvedTheme]);

  return null;
}
