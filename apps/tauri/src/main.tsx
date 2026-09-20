import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";
import { installTauriBridge } from "./tauri-bridge";
import { installLogger } from "./logger";
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
  }

  // Frontend failures (uncaught errors, rejections, console.error/warn) flow
  // into the same log file the Rust side writes, so a bug report only ever
  // needs one folder. Install before the bridge so bridge failures log too.
  installLogger(windowKind ?? "main");

  await installTauriBridge();
  syncWindowEffects();
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
