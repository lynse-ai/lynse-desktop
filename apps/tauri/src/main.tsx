import ReactDOM from "react-dom/client";
import "./globals.css";
import { installTauriBridge } from "./tauri-bridge";
import { installPrivatePlugins } from "./private-plugins";
import { installLogger } from "./logger";
import { installEventUnlistenGuard } from "./event-guard";
import { initAppTheme } from "@lynse/views/settings/app-theme";
import { syncNotchIslandPreference, useIslandPreferences } from "@lynse/views/settings/island-preferences";
import { analytics } from "@lynse/core/analytics";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

async function bootstrap() {
  // Playwright E2E: emulate the Tauri IPC surface in a plain browser (vite
  // --mode e2e) so the real bridge and app boot unmodified. Never active in
  // dev or packaged builds.
  if (import.meta.env.MODE === "e2e" || import.meta.env.VITE_LYNSE_E2E === "1") {
    const { installE2EShim } = await import("./e2e/tauri-shim");
    installE2EShim();
  }
  // Runs after the e2e shim (which provides its own event internals) and before
  // the first listener is registered in installTauriBridge, so every teardown
  // path in the app goes through the guard.
  installEventUnlistenGuard();
  const windowKind = new URLSearchParams(window.location.search).get("window");
  // Transparent floating windows must render the webview body transparent too,
  // otherwise the theme background shows through as a square frame.
  if (windowKind === "live-subtitles") {
    document.documentElement.classList.add("subtitle-window");
  }
  if (windowKind === "recording-island") {
    document.documentElement.classList.add("recording-island-window");
    // Windows anchors the island above the taskbar and grows it upward, so
    // the capsule flips: pill hugs the bottom edge, drawer unfolds above it.
    if (/Windows/i.test(navigator.userAgent)) {
      document.documentElement.classList.add("recording-island-window-bottom");
    }
    // Docked "Dynamic Island" build (Rust appended `style=notch`): the
    // surface turns opaque black, hanging below the hardware cutout.
    if (new URLSearchParams(window.location.search).get("style") === "notch") {
      document.documentElement.dataset.islandStyle = "notch";
    }
  }

  // Frontend failures (uncaught errors, rejections, console.error/warn) flow
  // into the same log file the Rust side writes, so a bug report only ever
  // needs one folder. Install before the bridge so bridge failures log too.
  installLogger(windowKind ?? "main");

  // Full-fidelity appearance pass (colors, fonts, contrast) before React
  // mounts; index.html already painted the bare color trio pre-bundle.
  initAppTheme();
  // The notch-attached island paints itself opaque black; force dark tokens
  // so drawer content and controls stay legible on it in every user theme.
  if (document.documentElement.dataset.islandStyle === "notch") {
    document.documentElement.classList.add("dark");
    initAppTheme();
  }

  const [{ default: App }] = await Promise.all([import("./App"), installTauriBridge(windowKind)]);
  if (!windowKind) {
    installPrivatePlugins();
    analytics.track("app_launched", {
      platform: "desktop",
      version: "1.2.17",
      os: /Macintosh|Mac OS/i.test(navigator.userAgent) ? "macos" : /Windows/i.test(navigator.userAgent) ? "windows" : "other",
      locale: navigator.language,
    });
  }
  syncWindowEffects();
  // Re-apply the persisted notch-island preference: the Rust flag is an
  // executor only and resets on launch, so the main window re-syncs it here
  // (before a recording can pre-create the island window).
  syncNotchIslandPreference(useIslandPreferences.getState().notchIslandEnabled);
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
}

// Keep `data-window-effects` in sync with the material Rust actually installed
// behind the webview, so the sidebar transparency matches reality (vibrancy
// unavailable → opaque sidebar).
function syncWindowEffects() {
  if (!/Mac/i.test(navigator.platform || navigator.userAgent)) return;
  let cancelled = false;
  const win = getCurrentWindow();
  win
    .listen<string>("lynse://window-effects", (event) => {
      document.documentElement.dataset.windowEffects = event.payload;
    })
    .catch(() => {});
  invoke<string>("window_effects_mode")
    .then((mode) => {
      if (!cancelled) document.documentElement.dataset.windowEffects = mode;
    })
    .catch(() => {});
  window.addEventListener("beforeunload", () => {
    cancelled = true;
  });
}

void bootstrap();
