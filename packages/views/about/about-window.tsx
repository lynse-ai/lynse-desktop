"use client";

import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initI18n } from "@lynse/core/i18n";
import { useTranslation } from "@lynse/core/i18n/react";
import { AppUpdateDialog } from "../app-update-dialog";
import { ReportProblemDialog } from "../report-problem-dialog";
import { RESOURCES } from "../locales";
import { isTauri } from "../layout/use-maximized";
import { AboutContent } from "./about-content";

/**
 * Standalone About window — the OS-level popup (its own title bar and
 * traffic lights) created by the Rust `open_about_window` command and
 * rendered for the `?window=about` route, mirroring the recording-island
 * window setup.
 *
 * Runs outside CoreProvider, so it bootstraps i18n itself (see the init
 * below). Re-asserting the native window title here keeps it correct if the
 * locale changed since the window was first opened.
 */
export function AboutWindow() {
  // The init must happen during render, before useTranslation() below: a
  // passive effect is too late — the hook resolves no i18next instance on
  // the first render, subscribes to nothing, and never re-renders once init
  // completes (raw keys stay on screen). initI18n is idempotent and reads
  // the persisted locale from localStorage.
  useMemo(() => initI18n({ resources: RESOURCES }), []);
  const { t } = useTranslation();

  useEffect(() => {
    if (!isTauri) return;
    void getCurrentWindow().setTitle(t("about.title")).catch(() => {});
  }, [t]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <AboutContent />
      {/* The update + report dialogs own their flows from this window too. */}
      <AppUpdateDialog />
      <ReportProblemDialog />
    </div>
  );
}
