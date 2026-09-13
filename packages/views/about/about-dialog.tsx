"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { useTranslation } from "@lynse/core/i18n/react";
import { AppUpdateDialog } from "../app-update-dialog";
import { ReportProblemDialog } from "../report-problem-dialog";
import { AboutContent } from "./about-content";
import { useAboutDialog } from "./open-about";

/**
 * In-app About dialog — the fallback About surface where there is no desktop
 * host to pop an OS window (the web app). Mount once near the app root
 * (DashboardLayout); visibility is driven by the shared store in
 * `open-about.ts` (`openAboutWindow()` works from anywhere).
 */
export function AboutDialog() {
  const { t } = useTranslation();
  const { open, setOpen } = useAboutDialog();

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xs gap-0 overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{t("about.title")}</DialogTitle>
          </DialogHeader>
          <div className="h-[380px]">
            <AboutContent />
          </div>
        </DialogContent>
      </Dialog>
      {/* Hosted here so the update + report flows open from the fallback too. */}
      <AppUpdateDialog />
      <ReportProblemDialog />
    </>
  );
}
