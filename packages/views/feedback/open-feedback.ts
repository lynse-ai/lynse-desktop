"use client";

import i18next from "i18next";
import { toast } from "sonner";
import { FEEDLOG_BASE_URL } from "@lynse/core/api";
import { getDesktopAppApi } from "../app-update";
import { isMacDesktop } from "../layout/use-maximized";

/** Public suggestion board (the FeedLog portal) — the browser-tab surface. */
export const FEEDLOG_BOARD_URL = FEEDLOG_BASE_URL;

/** Public changelog page — version announcements published in FeedLog. */
export const CHANGELOG_URL = `${FEEDLOG_BASE_URL}/changelog`;

/**
 * Open the standalone FeedLog widget window (macOS OS window via the Rust
 * `open_feedback_window` command). No menu entry points here since the
 * in-app suggestion center took over, but the window chain stays wired —
 * call sites can use it as a "browse the board" surface later.
 */
export function openFeedbackWindow(): void {
  const api = isMacDesktop ? getDesktopAppApi() : null;
  if (api?.openFeedbackWindow) {
    const title = i18next.isInitialized ? i18next.t("feedback.title") : "Lynse";
    // Never swallow a failed host command: surface the error and fall back
    // to the public board in a browser tab.
    api.openFeedbackWindow(title).catch((error) => {
      toast.error(String(error));
      window.open(FEEDLOG_BOARD_URL, "_blank", "noopener");
    });
    return;
  }
  window.open(FEEDLOG_BOARD_URL, "_blank", "noopener");
}

/** Open the FeedLog changelog (version announcements) in a browser tab. */
export function openChangelog(): void {
  window.open(CHANGELOG_URL, "_blank", "noopener");
}
