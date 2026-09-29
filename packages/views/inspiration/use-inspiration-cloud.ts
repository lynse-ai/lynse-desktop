"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@lynse/core/auth";

import {
  bindInspirationCloud,
  fetchInspirationCloudStatus,
  isInspirationCloudEnabled,
  syncInspirationCloud,
  unbindInspirationCloud,
} from "./cloud";
import type { InspirationCloudStatus } from "./types";

const SYNC_DEBOUNCE_MS = 1_500;
const CLOUD_QUERY_KEY = ["inspiration-cloud"] as const;

/**
 * Lynse Memory cloud sync wiring for the inspiration page (plan T7/T8).
 *
 * Binds the verified Lynse account on login (`/v1/me` inside
 * `bindInspirationCloud`; API-Key sessions never bind) and runs sync passes
 * at the plan's trigger points: login, network recovery (`online`), app wake
 * (`visibilitychange`) and — debounced — after any local operation lands in
 * the list (saves, edits, deletes). Failures keep the pending queue intact;
 * the status pill reflects 仅本机/同步中/已同步/冲突 via `recordStates`.
 */
export function useInspirationCloud() {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enabled = isInspirationCloudEnabled();
  const status = useQuery({
    queryKey: CLOUD_QUERY_KEY,
    queryFn: async (): Promise<InspirationCloudStatus | null> => {
      try {
        return (await fetchInspirationCloudStatus()) ?? null;
      } catch {
        return null;
      }
    },
    enabled,
    // Pending transcript-style polling is overkill; the sync triggers below
    // refresh this query explicitly after each pass.
  });

  // Login → bind (or re-verify). Logout → unbind; the per-account queue
  // pauses in the shell until the same account binds again.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        if (isAuthenticated) {
          await bindInspirationCloud();
        } else {
          await unbindInspirationCloud();
        }
      } catch {
        // Offline startup keeps the previously verified binding (plan T7.1);
        // an identity failure must not block the page.
      }
      if (!cancelled) void queryClient.invalidateQueries({ queryKey: CLOUD_QUERY_KEY });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, isAuthenticated, queryClient]);

  const runSync = useCallback(async () => {
    if (!isInspirationCloudEnabled()) return;
    const report = await syncInspirationCloud();
    if (report && !report.skipped) {
      await queryClient.invalidateQueries({ queryKey: CLOUD_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ["inspirations"] });
    }
  }, [queryClient]);

  const scheduleSync = useCallback(() => {
    if (!isInspirationCloudEnabled()) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSync(), SYNC_DEBOUNCE_MS);
  }, [runSync]);

  // Network recovery + app wake + initial pass on mount/login.
  useEffect(() => {
    if (!enabled) return;
    const handleOnline = () => void runSync();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void runSync();
    };
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    void runSync();
    return () => {
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, runSync]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  return { status: status.data ?? null, syncNow: runSync, scheduleSync };
}
