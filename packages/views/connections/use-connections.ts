import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@lynse/core/auth";
import {
  disconnectAccount,
  exportActionItems,
  fetchCalendarEvents,
  fetchDestinations,
  setAccountToggles,
  setAutoExport,
  setDefaultDestination,
  type CalendarEventsResponse,
  type Destination,
  type ExportPayload,
  type ExportResult,
  type IntegrationsProvider,
} from "@lynse/core/integrations";
import { LIST_STALE_TIME_MS } from "../workspace/hooks/use-files";
import { integrationStatusKey } from "./use-connect-flow";
import { getWorkbenchApi } from "../workbench/api";
import { isWikiEnabled } from "../feature-flags";

/**
 * Query/mutation layer for Connections.
 *
 * Keys are hyphenated domain heads with primitive members and
 * `isAuthenticated`, matching `use-files.ts:308,386`. `staleTime` is explicit
 * because the client default is `Infinity` (`core/query-client.ts:7`).
 *
 * These queries are deliberately NOT added to the list-query persistence
 * allowlist (`core/query-persistence.ts:43-46`): connection state is
 * server-owned, and a stale "connected" row that outlives a revoked token is
 * worse than a spinner.
 */

export const connectionsKeys = {
  destinations: (provider: IntegrationsProvider) => ["connections", provider, "destinations"] as const,
  calendarEvents: (from: string, to: string, isAuthenticated: boolean) =>
    ["calendar-events", from, to, isAuthenticated] as const,
};

function useInvalidateProvider(provider: IntegrationsProvider) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: integrationStatusKey(provider) });
    void client.invalidateQueries({ queryKey: ["connections", provider, "accounts"] });
    void client.invalidateQueries({ queryKey: connectionsKeys.destinations(provider) });
  };
}

export function useDestinations(provider: IntegrationsProvider, enabled = true) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery<{ destinations: Destination[] }>({
    queryKey: connectionsKeys.destinations(provider),
    queryFn: () => fetchDestinations(provider),
    staleTime: LIST_STALE_TIME_MS,
    enabled: isAuthenticated && enabled,
    retry: false,
  });
}

export function useCalendarEvents(range: { from: string; to: string }, enabled = true) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery<CalendarEventsResponse>({
    queryKey: connectionsKeys.calendarEvents(range.from, range.to, isAuthenticated),
    queryFn: () => fetchCalendarEvents(range),
    staleTime: LIST_STALE_TIME_MS,
    enabled: isAuthenticated && enabled,
    retry: false,
  });
}

export function useDisconnect(provider: IntegrationsProvider) {
  const invalidate = useInvalidateProvider(provider);
  return useMutation({
    mutationFn: async (accountId: string) => {
      const bridge = getWorkbenchApi();
      if (provider === "gmail" && bridge && isWikiEnabled()) {
        const wiki = await bridge.wiki({ action: "state" });
        if (wiki.sources?.gmailEnabled && wiki.sources.gmailAccountId === accountId) {
          await bridge.wiki({ action: "sources", sources: { ...wiki.sources, gmailEnabled: false } });
        }
      }
      return disconnectAccount(provider, accountId);
    },
    onSuccess: invalidate,
  });
}

export function useAutoExport(provider: IntegrationsProvider) {
  const invalidate = useInvalidateProvider(provider);
  return useMutation({
    mutationFn: (input: { accountId: string; autoExport: boolean }) =>
      setAutoExport(provider, { account_id: input.accountId, auto_export: input.autoExport }),
    onSuccess: invalidate,
  });
}

/** Where an account's exports land; required before the first export. */
export function useDefaultDestination(provider: IntegrationsProvider) {
  const invalidate = useInvalidateProvider(provider);
  return useMutation({
    mutationFn: (input: { accountId: string; destinationId: string }) =>
      setDefaultDestination(provider, {
        account_id: input.accountId,
        destination_id: input.destinationId,
      }),
    onSuccess: invalidate,
  });
}

/**
 * Sync/Notify are per calendar account and live under the calendar prefix, so
 * invalidation spans both providers' status keys — the caller passes the
 * provider the account came from.
 */
export function useAccountToggles(provider: IntegrationsProvider) {
  const invalidate = useInvalidateProvider(provider);
  return useMutation({
    mutationFn: (input: { accountId: string; syncEnabled?: boolean; notifyEnabled?: boolean }) =>
      setAccountToggles(input.accountId, {
        sync_enabled: input.syncEnabled,
        notify_enabled: input.notifyEnabled,
      }),
    onSuccess: invalidate,
  });
}

export interface ExportOptions {
  /** Called with the partial-success breakdown so the row can toast it. */
  onResult?: (result: ExportResult) => void;
}

/**
 * Export is a mutation, not a query — and it must not be retried: the backend
 * dedupes by `action_item_ids`, but a blind retry of a partial success would
 * re-send the failed subset with a different id set.
 */
export function useExportActionItems(provider: IntegrationsProvider, options: ExportOptions = {}) {
  const client = useQueryClient();
  return useMutation<ExportResult, Error, ExportPayload>({
    mutationFn: (payload) => exportActionItems(provider, payload),
    retry: false,
    onSuccess: (result) => {
      options.onResult?.(result);
      void client.invalidateQueries({ queryKey: ["connections", provider, "status"] });
    },
  });
}
