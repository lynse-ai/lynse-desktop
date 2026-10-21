"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Progress } from "@lynse/ui/components/ui/progress";
import { cn } from "@lynse/ui/lib/utils";
import { Loader2 } from "../icons";
import type { WorkbenchStatus } from "./types";
import { workbenchErrorCopy } from "./errors";

function percent(completed: number, total: number): number | null {
  return total > 0 ? Math.round(Math.min(1, Math.max(0, completed / total)) * 100) : null;
}

export function isWikiProcessingComplete(status: WorkbenchStatus | null, error?: string | null): boolean {
  return !!status?.enabled && status.initialComplete && status.allowAi && status.phase === "ready"
    && status.wikiProgress?.stage === "complete" && status.wikiProgress.failed === 0
    && status.conflicts === 0 && !status.error && !error;
}

export function WorkbenchProgress({ status, error }: { status: WorkbenchStatus | null; error?: string | null }) {
  const { t } = useTranslation();
  if (isWikiProcessingComplete(status, error)) return null;
  if (!status?.enabled) return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null;

  const progress = status.wikiProgress;
  const failure = error || status.error;
  const errorCopy = workbenchErrorCopy(failure);
  const syncTotal = Math.max(status.synced, status.discovered - status.awaitingTranscription - status.failed);
  let label = "workbench.home_syncing";
  let hint = "workbench.home_sync_hint";
  let value = percent(status.synced, syncTotal);
  let busy = ["pending", "discovering", "syncing", "processing"].includes(status.phase);
  let counter: string | null = null;

  if (!status.initialComplete) {
    if (status.phase === "discovering" || status.phase === "pending") value = null;
    if (status.phase === "incomplete" || status.phase === "failed") {
      label = "workbench.home_sync_paused";
      hint = "workbench.home_sync_paused_hint";
      busy = false;
    }
    counter = t("workbench.home_sync_count", { completed: status.synced, total: syncTotal });
  } else if (!status.allowAi) {
    label = "workbench.home_wait_consent";
    hint = "workbench.home_consent_hint";
    value = 0;
    busy = false;
  } else if (status.phase === "waiting_configuration") {
    label = "workbench.waiting_configuration";
    hint = "workbench.home_configuration_hint";
    value = 0;
    busy = false;
  } else if (status.phase === "processing") {
    const stage = progress?.stage ?? "preparing";
    label = `workbench.home_${stage}`;
    hint = "workbench.home_processing_hint";
    value = progress ? percent(progress.completed, progress.total) : null;
    if (progress && progress.total > 0) {
      counter = t(`workbench.home_${stage}_count`, { completed: progress.completed, total: progress.total });
    }
  } else if (status.phase === "failed" || (progress?.failed ?? 0) > 0 || error || status.error) {
    label = "workbench.home_needs_attention";
    hint = "workbench.home_attention_hint";
    value = progress ? percent(progress.completed, progress.total) : 0;
    busy = false;
  } else {
    label = progress?.stage === "complete" ? (progress.total === 0 ? "workbench.home_sources_ready" : "workbench.home_complete") : "workbench.home_preparing";
    hint = progress?.stage === "complete" && progress.total === 0 ? "workbench.home_create_topic_hint" : "workbench.home_processing_hint";
    value = progress?.stage === "complete" ? 100 : null;
    busy = progress?.stage !== "complete";
  }

  return <div className="space-y-2 text-xs" aria-live="polite">
    <div className="flex items-center justify-between gap-3">
      <p className="flex min-w-0 items-center gap-1.5 font-medium">
        {busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />}
        {t(label)}
      </p>
      {value !== null && <span aria-hidden="true" className="shrink-0 tabular-nums text-muted-foreground">{value}%</span>}
    </div>
    <Progress
      value={value}
      aria-label={t("workbench.home_progress_label")}
      getAriaValueText={() => counter ?? t(label)}
      className={cn("w-full [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-indicator]]:motion-reduce:transition-none",
        value === null && "[&_[data-slot=progress-indicator]]:w-1/3",
        busy && value === null && "[&_[data-slot=progress-indicator]]:animate-pulse [&_[data-slot=progress-indicator]]:motion-reduce:animate-none")}
    />
    {counter && <p className="tabular-nums text-muted-foreground">{counter}</p>}
    {status.initialComplete && status.phase === "processing" && progress?.topicTitle && <p className="truncate text-muted-foreground" title={progress.topicTitle}>{t("workbench.home_current_topic", { title: progress.topicTitle })}</p>}
    {status.initialComplete && status.phase === "processing" && progress?.currentTitle && <p className="truncate text-muted-foreground" title={progress.currentTitle}>{progress.currentTitle}</p>}
    <p className="leading-relaxed text-muted-foreground">{t(hint)}</p>
    {(status.awaitingTranscription > 0 || status.failed > 0) && <p className="leading-relaxed text-muted-foreground">{t("workbench.home_skipped", { waiting: status.awaitingTranscription, failed: status.failed })}</p>}
    {status.conflicts > 0 && <p className="text-destructive">{t("workbench.home_conflicts", { count: status.conflicts })}</p>}
    {failure && <p role="alert" className="break-words text-destructive">{errorCopy ? t(errorCopy.key, { count: errorCopy.count }) : failure}</p>}
  </div>;
}
