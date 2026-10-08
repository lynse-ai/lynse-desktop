import { api } from "./client";

export type ConnectorRequestStatus = "waiting_auth" | "ready" | "resuming" | "done" | "cancelled" | "expired" | "error" | "account_selection_required" | "reauthorization_required" | "permission_denied" | "rate_limited" | "unavailable" | "identity_required" | "invalid_input";

export interface ConnectorAccount {
  id: string;
  display_name?: string;
  email?: string;
}

export interface ConnectorConnectionRequest {
  request_id: string;
  provider: string;
  provider_display_name: string;
  reason?: string;
  action_url?: string;
  expires_at?: string;
  status: ConnectorRequestStatus;
  accounts?: ConnectorAccount[];
}

export interface ConnectorRequestResult {
  request_id?: string;
  status: ConnectorRequestStatus;
  auth_expires_at?: string;
  status_detail?: string;
  read_status?: string;
  accounts?: unknown[];
  result?: { account?: { display_name?: string; email?: string }; [key: string]: unknown };
  error?: { message?: string };
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATUSES = new Set<ConnectorRequestStatus>(["waiting_auth", "ready", "resuming", "done", "cancelled", "expired", "error", "account_selection_required", "reauthorization_required", "permission_denied", "rate_limited", "unavailable", "identity_required", "invalid_input"]);

export function normalizeConnectionRequest(raw: unknown): ConnectorConnectionRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.provider !== "string" || !/^[a-z0-9_-]{1,64}$/.test(value.provider)) return null;
  const status = value.status as ConnectorRequestStatus;
  if (!STATUSES.has(status)) return null;
  const requestId = typeof value.request_id === "string" ? value.request_id : "";
  if (!REQUEST_ID.test(requestId) && !(status === "account_selection_required" && !requestId)) return null;
  let actionUrl: string | undefined;
  try {
    const url = new URL(String(value.action_url ?? ""));
    if (url.protocol === "https:" && !url.username && !url.password) actionUrl = url.href;
  } catch { /* Invalid authorization entries remain non-clickable. */ }
  const accounts = Array.isArray(value.accounts) ? value.accounts.flatMap((account: unknown) => {
    if (!account || typeof account !== "object") return [];
    const entry = account as Record<string, unknown>;
    const id = typeof entry.account_id === "string" ? entry.account_id : entry.id;
    if (typeof id !== "string" || !id) return [];
    return [{ id, display_name: typeof entry.display_name === "string" ? entry.display_name : undefined, email: typeof entry.email === "string" ? entry.email : undefined }];
  }) : undefined;
  return {
    request_id: requestId,
    provider: value.provider,
    provider_display_name: typeof value.provider_display_name === "string" ? value.provider_display_name : value.provider,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    action_url: actionUrl,
    expires_at: typeof value.expires_at === "string" ? value.expires_at : undefined,
    status,
    accounts,
  };
}

function requestPath(requestId: string) {
  if (!REQUEST_ID.test(requestId)) throw new Error("Invalid connector request");
  return `/api/connectors/requests/${encodeURIComponent(requestId)}`;
}

function options(sessionToken: string, signal?: AbortSignal) {
  const client = api();
  return { baseUrl: client.getAgentBaseUrl() ?? client.getBaseUrl(), tokenOnly: true, sessionToken, signal };
}

function validateResult(result: ConnectorRequestResult, requestId: string) {
  if (!STATUSES.has(result.status) || (result.request_id !== undefined && result.request_id !== requestId)) {
    throw new Error("Invalid connector response");
  }
  return result;
}

export async function getConnectorRequest(requestId: string, sessionToken: string, signal?: AbortSignal) {
  return validateResult(await api().get<ConnectorRequestResult>(requestPath(requestId), options(sessionToken, signal)), requestId);
}

export async function resumeConnectorRequest(requestId: string, sessionToken: string, signal?: AbortSignal) {
  return validateResult(await api().post<ConnectorRequestResult>(`${requestPath(requestId)}/resume`, {}, options(sessionToken, signal)), requestId);
}

export async function cancelConnectorRequest(requestId: string, sessionToken: string, signal?: AbortSignal) {
  return validateResult(await api().post<ConnectorRequestResult>(`${requestPath(requestId)}/cancel`, {}, options(sessionToken, signal)), requestId);
}
