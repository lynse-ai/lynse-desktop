"use client";

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  exportSummary,
  type IntegrationAccount,
  type IntegrationsProvider,
  type SummaryExportResult,
} from "@lynse/core/integrations";
import { useFileConclusions } from "../workspace/hooks/use-files";
import { integrationStatusKey } from "./use-connect-flow";

/** onError turns this into the destination-picker hint instead of a raw failure. */
const NO_DESTINATION_SENTINEL = "connections.no_destination_sentinel";

/**
 * Export a note's meeting summary to a document provider (PRD FR-3).
 *
 * The summary comes from the `["file-conclusions", fileId]` query, not from a
 * one-off fetch: `feishu-push.ts:11-26` bypasses React Query for its text,
 * which means it can push a stale or duplicate read of data the cache already
 * owns. Reusing the query keeps one source of truth and gets the transient
 * "conclusion not ready yet" handling for free.
 */
export function useSummaryExport(
  provider: IntegrationsProvider,
  fileId: string | null,
  account: IntegrationAccount | null,
) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const conclusions = useFileConclusions(fileId);

  const latest = useMemo(() => {
    const list = conclusions.data ?? [];
    if (!list.length) return null;
    return list.reduce((newest, item) =>
      Date.parse(item.createdAt) >= Date.parse(newest.createdAt) ? item : newest,
    );
  }, [conclusions.data]);

  return useMutation<SummaryExportResult, Error, void>({
    mutationKey: ["connections", provider, "export-summary", fileId],
    mutationFn: async () => {
      if (!fileId) throw new Error("no file");
      if (!latest?.conclusionText.trim()) {
        throw new Error(t("connections.summary_export_no_summary"));
      }
      const destinationId = account?.default_destination_id;
      if (!destinationId) {
        // Sentinel the onError branch turns into the picker hint, so a missing
        // destination never reads as an unexplained failure.
        throw new Error(NO_DESTINATION_SENTINEL);
      }
      return exportSummary(provider, {
        file_id: fileId,
        destination_id: destinationId,
        summary: latest.conclusionText,
      });
    },
    onSuccess: (result) => {
      // FR-3 AC: the second export must update the same page — say which
      // happened, because "created" twice would mean the server duplicated.
      toast.success(
        result.created
          ? t("connections.summary_export_created", { destination: result.url })
          : t("connections.summary_export_updated", { destination: result.url }),
      );
      void client.invalidateQueries({ queryKey: integrationStatusKey(provider) });
    },
    onError: (error) => {
      toast.error(
        error.message === NO_DESTINATION_SENTINEL
          ? t("connections.pick_a_destination_first")
          : error.message,
      );
    },
  });
}
