"use client";

import { DropdownMenuItem } from "@lynse/ui/components/ui/dropdown-menu";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import type { IntegrationAccount } from "@lynse/core/integrations";
import { Loader2 } from "../icons";
import { isConnectionsEnabled } from "../feature-flags";
import { useIntegrationStatus } from "./use-connect-flow";
import { useDestinations } from "./use-connections";
import { useSummaryExport } from "./export-summary";

export interface SummaryExportAvailability {
  /** True when `SummaryExportMenuItem` will render an item: Connections on,
   *  signed in, Notion connected with at least one account. The parent menu
   *  keys its surrounding separators on this so an absent entry never leaves
   *  an empty separator-only group. */
  visible: boolean;
  account: IntegrationAccount | null;
}

/**
 * Single source of truth for whether the export entry shows. Both the menu
 * item and its host read this, so item and separators flip in the same render.
 */
export function useSummaryExportAvailability(): SummaryExportAvailability {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const enabled = isConnectionsEnabled();
  const status = useIntegrationStatus("notion", enabled && isAuthenticated);
  const account = status.data?.accounts.find((candidate) => candidate.is_primary)
    ?? status.data?.accounts[0] ?? null;
  return {
    visible: enabled && Boolean(status.data?.connected) && account !== null,
    account,
  };
}

/**
 * "Export summary to Notion" entry for the note header's overflow menu
 * (PRD FR-3). Self-contained on purpose: `workspace/content-panel.tsx` is
 * already large, and the gating (feature flag, desktop-only section, sign-in,
 * a connected Notion account with a default database) belongs with the
 * integration, not with the note UI.
 *
 * Renders nothing when the feature is off or Notion is not connected, so the
 * menu never shows an item that can only fail. Hosts that wrap it in
 * separators should consult `useSummaryExportAvailability` for the same
 * condition.
 */
export function SummaryExportMenuItem({
  fileId,
  disabled,
}: {
  fileId: string | null;
  /** Note is still summarizing, or has no summary yet. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { visible, account } = useSummaryExportAvailability();
  const exporter = useSummaryExport("notion", fileId, account);
  // Name the database the user actually picked; the workspace alone does not
  // say where the note will land.
  const destinations = useDestinations("notion", Boolean(account?.default_destination_id));
  const destinationName = account?.default_destination_id
    ? destinations.data?.destinations.find((d) => d.id === account.default_destination_id)?.name
    : undefined;

  // `account` guard doubles as the type narrowing for the JSX below; when
  // `visible` holds, `account` is always non-null.
  if (!visible || !account) return null;

  const ready = Boolean(account.default_destination_id);

  return (
    <DropdownMenuItem
      disabled={disabled || exporter.isPending || !ready}
      onClick={(event) => {
        event.preventDefault();
        exporter.mutate();
      }}
    >
      {exporter.isPending ? (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" strokeWidth={1.5} />
      ) : null}
      <span>
        {ready
          ? t("connections.export_summary", {
              destination:
                destinationName ?? account.workspace_name ?? t("connections.provider.notion"),
            })
          : t("connections.pick_a_destination_first")}
      </span>
    </DropdownMenuItem>
  );
}
