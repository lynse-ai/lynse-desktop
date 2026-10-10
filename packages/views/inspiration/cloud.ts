"use client";

/**
 * Lynse Memory cloud sync glue (plan T7/T8).
 *
 * Division of labour with the Tauri shell:
 * - HERE: read the memory-service base URL + Lynse token, verify the token
 *   against `GET /v1/me` and bind the server-derived user id (T7.1), then
 *   trigger sync passes at the plan's trigger points — login, network
 *   recovery, app wake, and after local operations enqueue (T8.2).
 * - SHELL (`inspiration_cloud.rs`): account-partitioned cache, pending-op
 *   journal, media pipeline and the sync engine itself.
 *
 * API-Key-only sessions never bind: without a Lynse token there is no
 * verified user id, so the cloud cache never opens (plan T7.4).
 */

import { api } from "@lynse/core/api";

import { getDesktopInspirationApi } from "./desktop-api";
import type { InspirationCloudStatus, InspirationCloudSyncReport } from "./types";

/** localStorage key holding the Lynse Memory service base URL (empty = off). */
export const LYNSE_MEMORY_API_URL_KEY = "lynse_memory_api_url";

/**
 * Production Lynse Memory CloudBase service — the service's default domain
 * per the CloudBase console (`lynse-memory-319577-10`, user-confirmed
 * 2026-10-10). Override (or disable with an empty override) via
 * localStorage[LYNSE_MEMORY_API_URL_KEY].
 */
export const DEFAULT_MEMORY_API_URL =
  "https://lynse-memory-319577-10-1401959758.sh.run.tcloudbase.com";

/** Pre-2026-10-10 default host; routes to the same lynse-memory service. */
export const LEGACY_MEMORY_API_URL =
  "https://lynse-memory-321192-9-1401959758.sh.run.tcloudbase.com";

export function memoryApiBase(): string {
  if (typeof window === "undefined") return "";
  const configured = (window.localStorage.getItem(LYNSE_MEMORY_API_URL_KEY) ?? "").trim();
  if (configured !== "") {
    // A manual override pinned to the pre-migration host keeps working, but
    // it should ride the current default like the unset case does.
    if (configured === LEGACY_MEMORY_API_URL) return DEFAULT_MEMORY_API_URL;
    return configured;
  }
  // Empty override = explicitly disabled; unset = production default.
  if (window.localStorage.getItem(LYNSE_MEMORY_API_URL_KEY) === "") return "";
  return DEFAULT_MEMORY_API_URL;
}

export function isInspirationCloudEnabled(): boolean {
  return memoryApiBase() !== "" && getDesktopInspirationApi() !== null;
}

class MemoryIdentityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Verify the Lynse token and return the SERVER-derived user id (/v1/me). */
export async function verifyMemoryIdentity(): Promise<{ userId: string; apiBase: string }> {
  const apiBase = memoryApiBase();
  if (!apiBase) throw new MemoryIdentityError("disabled", "Lynse Memory is not configured");
  const token = api().getToken();
  if (!token) throw new MemoryIdentityError("missing_token", "not logged in with a Lynse account");
  const response = await fetch(`${apiBase}/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let payload: { user_id?: string; error?: { code?: string; message?: string } } = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || !payload.user_id) {
    const code = payload.error?.code ?? `http_${response.status}`;
    throw new MemoryIdentityError(code, payload.error?.message ?? "identity verification failed");
  }
  return { userId: payload.user_id, apiBase };
}

/**
 * Bind the verified account and open its cloud cache. Returns the status,
 * or null when the cloud feature is off / not on desktop. Failures are
 * reported, never silently swallowed into a fake "bound" state.
 */
export async function bindInspirationCloud(): Promise<InspirationCloudStatus | null> {
  const desktop = getDesktopInspirationApi();
  if (!desktop || !memoryApiBase()) return null;
  const { userId, apiBase } = await verifyMemoryIdentity();
  return desktop.cloudBind(userId, apiBase);
}

export async function unbindInspirationCloud(): Promise<void> {
  const desktop = getDesktopInspirationApi();
  if (!desktop) return;
  await desktop.cloudUnbind();
}

export async function fetchInspirationCloudStatus(): Promise<InspirationCloudStatus | null> {
  const desktop = getDesktopInspirationApi();
  if (!desktop || !memoryApiBase()) return null;
  return desktop.cloudStatus();
}

let syncInFlight = false;

/**
 * One sync pass (idempotent; the shell serialises concurrent runs). Triggers:
 * login, network recovery, app wake, and after local saves/deletes. Failures
 * keep the pending queue intact — never reported as success.
 */
export async function syncInspirationCloud(): Promise<InspirationCloudSyncReport | null> {
  const desktop = getDesktopInspirationApi();
  if (!desktop || !memoryApiBase() || syncInFlight) return null;
  const token = api().getToken();
  if (!token) return null;
  syncInFlight = true;
  try {
    return await desktop.cloudSync(token);
  } finally {
    syncInFlight = false;
  }
}

export { MemoryIdentityError };
