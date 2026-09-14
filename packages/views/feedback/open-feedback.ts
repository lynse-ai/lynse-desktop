"use client";

import i18next from "i18next";
import { getDesktopAppApi } from "../app-update";
import { isTauri } from "../layout/use-maximized";

/** The Lynse workspace on the hosted FeedLog service. */
export const FEEDBACK_BOARD_URL = "https://lynse.feedlog.ai";

/**
 * Open the feedback board: a standalone OS window hosting the FeedLog
 * widget on desktop (created by the Rust `open_feedback_window` command,
 * mirroring the About window), the public board in a browser tab elsewhere.
 * `title` must be localized and only the frontend knows the active locale,
 * so it is resolved here and passed to the host command.
 */
export function openFeedbackWindow(): void {
  const api = isTauri ? getDesktopAppApi() : null;
  if (api?.openFeedbackWindow) {
    const title = i18next.isInitialized ? i18next.t("feedback.title") : "Lynse";
    void api.openFeedbackWindow(title);
    return;
  }
  window.open(FEEDBACK_BOARD_URL, "_blank", "noopener");
}
