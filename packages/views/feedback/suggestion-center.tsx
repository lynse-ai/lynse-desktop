"use client";

/**
 * Feature-suggestion center: 「提交建议」 submit tab + 「我的反馈」 list tab
 * in one dialog. Suggestions post to the self-hosted FeedLog board
 * (feedback.lynse.ai) through the native transport; problem reports stay on
 * the CNB channel and never show up here. The shared diagnostics store
 * drives open/close and the tab preset via openFeatureRequests options.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent } from "@lynse/ui/components/ui/dialog";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import {
  takePendingFeedbackOptions,
  useReportProblemDialog,
  type FeedbackCenterPreset,
} from "../diagnostics";
import { FEEDLOG_BOARD_URL } from "./open-feedback";
import { FeatureSuggestionForm } from "./suggestion-form";
import { MySuggestionsPane } from "./my-suggestions";

type CenterTab = "submit" | "tickets";

export function FeedbackCenterDialog() {
  const { open, setOpen } = useReportProblemDialog();
  const { t } = useTranslation();
  const [tab, setTab] = useState<CenterTab>("submit");
  const [formEpoch, setFormEpoch] = useState(0);

  // Entry presets (tab) ride through the diagnostics store and are consumed
  // on each open; reopening with no preset keeps the current tab.
  useEffect(() => {
    if (!open) return;
    const preset: FeedbackCenterPreset | null = takePendingFeedbackOptions();
    if (preset) {
      setTab(preset.tab);
      // A fresh form per open: the epoch remounts the submit pane so a
      // previously submitted suggestion doesn't leak into the next one.
      setFormEpoch((epoch) => epoch + 1);
    }
  }, [open]);

  const tabs: { key: CenterTab; label: string }[] = [
    { key: "submit", label: t("settings.feedback_tab_submit") },
    { key: "tickets", label: t("settings.feedback_tab_tickets") },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
      >
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
        {tab === "submit" ? (
          <FeatureSuggestionForm key={formEpoch} onSubmitted={() => setTab("tickets")} />
        ) : (
          <MySuggestionsPane onNewSuggestion={() => setTab("submit")} />
        )}
        <div className="flex items-center justify-between border-t px-5 py-2.5">
          <button
            type="button"
            className="text-2xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            onClick={() => window.open(FEEDLOG_BOARD_URL, "_blank", "noopener")}
          >
            {t("settings.feedback_suggestion_board_open")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
