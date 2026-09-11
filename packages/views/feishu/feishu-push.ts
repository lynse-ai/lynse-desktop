import { useEffect, useRef } from "react";
import i18next from "i18next";
import { toast } from "sonner";
import { api } from "@lynse/core/api";
import { getDesktopFeishuApi } from "./feishu";
import { isTranscriptionCompleted } from "../workspace/hooks/use-files";
import { isLocalFileId } from "../workspace/local-transcription";
import type { FileConclusion, TransStatusMap } from "../workspace/types";

/** Newest conclusion text for a file, or null when none is ready yet. */
export async function fetchLatestConclusionText(fileId: string): Promise<string | null> {
  try {
    const conclusions = await api().getWithParams<FileConclusion[]>(
      "/api/business/file/conclusion/list",
      { fileId },
    );
    if (!Array.isArray(conclusions) || conclusions.length === 0) return null;
    const sorted = [...conclusions].sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
    );
    return sorted[0]?.conclusionText ?? null;
  } catch {
    // The summary may genuinely not exist (or the API hiccupped) — nothing to push.
    return null;
  }
}

/**
 * Push a meeting-summary card to the configured Feishu group. No-op unless
 * the desktop bot is enabled, summary push is on, and a target group is
 * picked. `summary` is optional: when absent, the file's newest conclusion
 * is fetched. Failures surface as a toast — never as an unhandled rejection.
 */
export async function pushMeetingSummaryToFeishu(options: {
  fileId: string;
  title: string;
  summary?: string | null;
}): Promise<void> {
  const feishu = getDesktopFeishuApi();
  if (!feishu) return;
  // Local (offline-transcribed) recordings have no cloud summary to push.
  if (isLocalFileId(options.fileId)) return;
  try {
    const config = await feishu.getConfig();
    if (!config.enabled || !config.pushSummary || !config.targetChatId) return;
    const summary = options.summary?.trim() || (await fetchLatestConclusionText(options.fileId));
    if (!summary) return;
    const title = options.title.trim() || i18next.t("feishu.title");
    await feishu.sendSummaryCard({ title, summary, fileId: options.fileId });
  } catch (error) {
    toast.error(
      i18next.t("feishu.push_failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Headless companion for the notes page's `useTranscriptionStatus` poll:
 * when a cloud file's transcription flips to completed (upload → transcribe
 * flow), push its summary card once. The first observed snapshot is treated
 * as baseline — only transitions seen while the page is open push, so a
 * mount never spams the group with old completions.
 */
export function useFeishuTranscriptionCompletedWatcher(
  transStatus: TransStatusMap | undefined,
  getTitle: (fileId: string) => string | undefined,
): void {
  const pushedRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const getTitleRef = useRef(getTitle);
  getTitleRef.current = getTitle;

  useEffect(() => {
    if (!transStatus) return;
    for (const [fileId, status] of Object.entries(transStatus)) {
      if (!isTranscriptionCompleted(status)) continue;
      if (!primedRef.current) {
        // Baseline pass: mark what was already done before we looked.
        pushedRef.current.add(fileId);
        continue;
      }
      if (pushedRef.current.has(fileId)) continue;
      pushedRef.current.add(fileId);
      void pushMeetingSummaryToFeishu({ fileId, title: getTitleRef.current(fileId) ?? "" });
    }
    primedRef.current = true;
  }, [transStatus]);
}
