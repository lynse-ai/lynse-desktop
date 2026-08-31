"use client";

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * True only inside the Tauri desktop runtime. The web build never sets
 * `__TAURI_INTERNALS__`, so window-control calls stay inert there.
 */
export const isTauri =
  typeof window !== "undefined" &&
  !!(
    window as unknown as { __TAURI_INTERNALS__?: unknown }
  ).__TAURI_INTERNALS__;

/**
 * Tracks the main window's maximized/fullscreen state and reflects it onto
 * `<html data-maximized="true|false">` so layout CSS can adapt to wide/large
 * windows (e.g. center the reading column instead of letting it stretch
 * edge-to-edge). Also returns the current boolean for components that need to
 * branch on it.
 */
export function useMaximized(): boolean {
  const [isLarge, setIsLarge] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    const sync = () => {
      Promise.all([win.isMaximized(), win.isFullscreen()])
        .then(([max, fs]) => setIsLarge(max || fs))
        .catch(() => {});
    };

    sync();
    win.onResized(sync)
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    document.documentElement.dataset.maximized = isLarge ? "true" : "false";
  }, [isLarge]);

  return isLarge;
}
