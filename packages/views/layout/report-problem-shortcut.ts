"use client";

import { useEffect } from "react";
import { isMacDesktop } from "./use-maximized";
import { openReportProblem } from "../diagnostics";

/** Display label for the report-problem hotkey (menu hints). */
export const reportProblemShortcutLabel = isMacDesktop ? "⌘⇧B" : "Ctrl+Shift+B";

/**
 * Global ⌘⇧B / Ctrl+Shift+B opens the problem report dialog. The title-bar
 * bug button is gone; the profile and sidebar help menus surface this label.
 * Mount once per shell (AppTitleBar is present on every route).
 */
export function useReportProblemShortcut() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        openReportProblem();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
