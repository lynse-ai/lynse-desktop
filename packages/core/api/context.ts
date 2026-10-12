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
  displayed_at: string | null;
  snoozed_until: string | null;
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

/** Verify an account for an explicit opt-in when the login has no profile. */
export async function getContextIdentity(sessionToken: string) {
  const response = await api().get<{ user_id: string }>(
    "/api/connectors/identity", requestOptions(sessionToken),
  );
  if (!response.user_id?.trim()) throw new Error("Context identity unavailable");
  return response;
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
  // Gateways may serve the export as text/plain or octet-stream and may omit
  // the header entirely; only reject shapes that indicate an HTML error page
  // or a JSON API envelope rather than the markdown document itself.
  const contentType = blob.type.toLowerCase();
  if (contentType.includes("text/html") || contentType.startsWith("application/json")) {
    throw new Error("Context export unavailable");
  }
  const body = (await blob.text()).trimStart();
  if (api().getToken() !== sessionToken) throw new Error("Session changed");
  let isApiEnvelope = false;
  if (body.startsWith("{")) {
    try {
      const json: unknown = JSON.parse(body);
      isApiEnvelope = json !== null && typeof json === "object" && (
        "status" in json || "error" in json || "detail" in json ||
        ("code" in json && ("msg" in json || "message" in json || "data" in json))
      );
    } catch {
      // Markdown can start with a brace without being a JSON API envelope.
    }
  }
  if (/^(?:<!doctype\s+html\b|<(?:html|head|body)\b)/i.test(body) || isApiEnvelope) {
    throw new Error("Context export unavailable");
  }
  return blob;
}
