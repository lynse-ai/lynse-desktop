"use client";

/**
 * Feature-request center: 「提交建议」 submit tab + 「我的反馈」 tickets tab
 * in one dialog (the ZCode feedback-center pattern). Tickets live in the
 * lynclaw /api/feedback gateway (Feishu Bitable); problem reports take the
 * CNB channel instead and never show up here. The shared diagnostics store
 * still drives open/close and the pre-open screenshot capture; entry points
 * preset the tab via openFeatureRequests options.
 *
 * While the screenshot is being annotated the popup grows to the full
 * window: a portal would land outside Base UI's dialog (dismissed as an
 * outside press), and `fixed` inside the translated popup can't reach the
 * viewport, so the popup itself is the editor's frame.
 */

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent } from "@lynse/ui/components/ui/dialog";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import {
  takePendingFeedbackOptions,
  useReportProblemDialog,
  type FeedbackCenterPreset,
} from "../diagnostics";
import { FeatureRequestForm } from "./feature-request-form";
import { MyFeedbackPane } from "./my-feedback";

type CenterTab = "submit" | "tickets";

export function FeedbackCenterDialog() {
  const { open, setOpen } = useReportProblemDialog();
  const { t } = useTranslation();
  const [tab, setTab] = useState<CenterTab>("submit");
  const [formEpoch, setFormEpoch] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [annotating, setAnnotating] = useState(false);

  const contentClassName = useMemo(
    () =>
      annotating
        ? "gap-0 overflow-hidden p-0"
        : `grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 transition-opacity sm:max-w-xl ${
            capturing ? "opacity-0" : "opacity-100"
          }`,
    [annotating, capturing],
  );
  const contentStyle = useMemo(
    () =>
      annotating
        ? {
            width: "100vw",
            height: "100vh",
            maxWidth: "none",
            borderRadius: 0,
            borderColor: "transparent",
            gridTemplateRows: "minmax(0,1fr)",
          }
        : undefined,
    [annotating],
  );

  // Entry presets (tab) ride through the diagnostics store and are consumed
  // on each open; reopening with no preset keeps the current tab.
  useEffect(() => {
    if (!open) return;
    setCapturing(false);
    setAnnotating(false);
    const preset: FeedbackCenterPreset | null = takePendingFeedbackOptions();
    if (preset) {
      setTab(preset.tab);
      // A fresh form per open: the epoch remounts the submit pane so a
      // previously submitted description doesn't leak into the next ticket.
      setFormEpoch((epoch) => epoch + 1);
    }
  }, [open]);

  const tabs: { key: CenterTab; label: string }[] = [
    { key: "submit", label: t("settings.feedback_tab_submit") },
    { key: "tickets", label: t("settings.feedback_tab_tickets") },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={contentClassName} style={contentStyle} showCloseButton={false}>
        {!annotating && (
          <div className="border-b px-5 py-3.5 pr-12">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold leading-tight">{t("settings.feedback_center_title")}</h2>
                <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground text-pretty">
                  {t("settings.feedback_center_subtitle")}
                </p>
              </div>
              <div className="flex shrink-0 rounded-lg bg-muted/50 p-0.5">
                {tabs.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => setTab(entry.key)}
                    className={cn(
                      "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                      tab === entry.key
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {tab === "submit" ? (
          <FeatureRequestForm
            key={formEpoch}
            onCapturingChange={setCapturing}
            onAnnotatingChange={setAnnotating}
            onSubmitted={() => setTab("tickets")}
          />
        ) : (
          <MyFeedbackPane onNewTicket={() => setTab("submit")} />
        )}
      </DialogContent>
    </Dialog>
  );
}
