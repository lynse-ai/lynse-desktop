"use client";

import { useEffect, useState } from "react";
import i18next from "i18next";
import { toast } from "sonner";
import { getDesktopAppApi } from "../app-update";
import { isMacDesktop } from "../layout/use-maximized";

// ── In-app fallback dialog store ──────────────────────────────────────────
// Outside the desktop host (the web app) there is no OS window to pop, so
// the About surface renders as a dialog driven by this singleton store —
// the same pattern as the app-update dialog in ../app-update.ts. The host
// dialog is mounted once in DashboardLayout.
let aboutDialogOpen = false;
const aboutDialogListeners = new Set<() => void>();

function setAboutDialogOpen(open: boolean): void {
  if (aboutDialogOpen === open) return;
  aboutDialogOpen = open;
  aboutDialogListeners.forEach((listener) => listener());
}

export function closeAboutDialog(): void {
  setAboutDialogOpen(false);
}

/** Subscribe the mounted fallback dialog to the shared open state. */
export function useAboutDialog(): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpen] = useState(aboutDialogOpen);

  useEffect(() => {
    const sync = () => setOpen(aboutDialogOpen);
    aboutDialogListeners.add(sync);
    sync();
    return () => {
      aboutDialogListeners.delete(sync);
    };
  }, []);

  return { open, setOpen: setAboutDialogOpen };
}

/**
 * Open the About surface: a standalone OS window on desktop (created by the
 * Rust host, centered over the main window), the fallback dialog elsewhere.
 * `title` must be localized and only the frontend knows the active locale,
 * so it is resolved here and passed to the host command.
 */
export function openAboutWindow(): void {
  // Only macOS pops the standalone OS window. On Windows the host command
  // stalls inside `WebviewWindowBuilder::build()` — no window, no error, and
  // the rest of the UI stays responsive — so About uses the in-app dialog
  // there instead of a window that never arrives.
  const api = isMacDesktop ? getDesktopAppApi() : null;
  if (api?.openAboutWindow) {
    const title = i18next.isInitialized ? i18next.t("about.title") : "Lynse";
    // Never swallow a failed host command: the OS window failing to appear
    // (a real bug report on Windows) must stay diagnosable, so surface the
    // error and fall back to the in-app dialog.
    api.openAboutWindow(title).catch((error) => {
      toast.error(String(error));
      setAboutDialogOpen(true);
    });
    return;
  }
  setAboutDialogOpen(true);
}
