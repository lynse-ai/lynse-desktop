import { api } from "./client";

export interface ContextInboxItem {
  item_id: string;
  kind: string;
  title: string;
  body: string;
  status: "pending" | "dismissed" | "accepted" | "invalid";
  version: number;
  created_at: string;
  updated_at: string;
  displayed_at: string;
  snoozed_until: string;
  goal_id: string;
  source_refs: { source_id: string; source_revision: number; excerpt?: string; fragment_ref?: string }[];
}

export interface ContextInboxResponse {
  status: "ok";
  user_id: string;
  items: ContextInboxItem[];
  can_display: boolean;
  available: true;
}

export type ContextInboxAction = "displayed" | "dismiss" | "snooze";

function requestOptions(sessionToken: string, signal?: AbortSignal) {
  const client = api();
  return {
    baseUrl: client.getAgentBaseUrl() ?? client.getBaseUrl(),
    tokenOnly: true,
    sessionToken,
    signal,
  };
}

/** Available only on cloud live + PostgreSQL; unknown/offline modes fail closed. */
export async function listContextInbox(sessionToken: string, signal?: AbortSignal) {
  const response = await api().get<ContextInboxResponse>(
    "/api/context/inbox?status=pending",
    requestOptions(sessionToken, signal),
  );
  if (response.status !== "ok" || response.available !== true || !response.user_id || !Array.isArray(response.items)) {
    throw new Error("Context inbox unavailable");
  }
  return response;
}

export async function getContextInboxItem(itemId: string, sessionToken: string, signal?: AbortSignal) {
  const response = await api().get<{ status: string; user_id: string; item: ContextInboxItem }>(
    `/api/context/inbox/${encodeURIComponent(itemId)}`,
    requestOptions(sessionToken, signal),
  );
  if (response.status !== "ok" || !response.user_id || response.item?.item_id !== itemId) {
    throw new Error("Context item unavailable");
  }
  return response;
}

export async function actOnContextInbox(
  item: ContextInboxItem,
  action: ContextInboxAction,
  sessionToken: string,
  operationId: string,
  snoozedUntil?: string,
  signal?: AbortSignal,
) {
  const response = await api().post<{ status: string; changed: boolean; item: ContextInboxItem }>(
    `/api/context/inbox/${encodeURIComponent(item.item_id)}/actions`,
    {
      operation_id: operationId,
      action,
      base_version: item.version,
      ...(snoozedUntil ? { snoozed_until: snoozedUntil } : {}),
    },
    requestOptions(sessionToken, signal),
  );
  if (response.status !== "ok" || response.item?.item_id !== item.item_id) {
    throw new Error("Context action was not accepted");
  }
  return response;
}

export function syncContextMeetings(sessionToken: string, signal?: AbortSignal) {
  return api().post("/api/context/sync", undefined, requestOptions(sessionToken, signal));
}

export function isContextExportPath(path: string): boolean {
  return /^\/api\/context\/goals\/[A-Za-z0-9_-]+\/export$/.test(path);
}

export async function downloadContextReview(path: string, sessionToken: string, signal?: AbortSignal) {
  if (!isContextExportPath(path)) throw new Error("Invalid context export path");
  const blob = await api().getBlob(path, requestOptions(sessionToken, signal));
  if (api().getToken() !== sessionToken) throw new Error("Session changed");
  if (!blob.type.startsWith("text/markdown")) throw new Error("Context export unavailable");
  return blob;
}
