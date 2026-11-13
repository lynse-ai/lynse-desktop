"use client";

import { useSyncExternalStore } from "react";
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
 * Desktop on macOS — the only desktop platform whose window overlays the
 * traffic lights on the webview (Windows/Linux desktops keep their native
 * title bar instead). Top paddings that clear the lights key off this;
 * other desktops use the tighter web paddings.
 */
export const isMacDesktop =
  isTauri && /Mac/i.test(navigator.platform || navigator.userAgent);

let maximized = false;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | undefined;

function subscribe(listener: () => void) {
  if (!isTauri) return () => {};
  listeners.add(listener);
  if (listeners.size === 1) {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let stopped = false;
    let revision = 0;

    const sync = () => {
      const current = ++revision;
      Promise.all([win.isMaximized(), win.isFullscreen()])
        .then(([max, full]) => {
          if (stopped || current !== revision) return;
          const next = max || full;
          document.documentElement.dataset.maximized = String(next);
          if (maximized === next) return;
          maximized = next;
          listeners.forEach((notify) => notify());
        })
        .catch(() => {});
    };

    sync();
    win.onResized(sync)
      .then((fn) => {
        if (stopped) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    stopWatching = () => {
      stopped = true;
      unlisten?.();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    stopWatching?.();
    stopWatching = undefined;
  };
}

/** Shares the native window state with React subscribers and layout CSS. */
export function useMaximized(): boolean {
  return useSyncExternalStore(subscribe, () => maximized, () => false);
}
