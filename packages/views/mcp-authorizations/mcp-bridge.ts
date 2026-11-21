/**
 * Client for the Lynse MCP website bridge (same-origin only).
 *
 * The bridge lives under /platform/oauth/api on the same origin and is proxied
 * by nginx to the MCP service; it sends no CORS headers, so it must be called
 * with plain fetch (not the account ApiClient, which targets the account
 * backend). Its session is a bridge-scoped HttpOnly cookie, separate from the
 * web app's account token — `bootstrapConsole` bridges the two via the
 * `token-login` action without a second SMS round.
 */

export interface McpAuthorization {
  authorization_id: string;
  client_id: string;
  client_name: string;
  grant_type: string;
  source: "mcp" | "cli";
  scopes: string[];
  status: "valid" | "expired" | "revoked" | "reset_required";
  authorized_at: number;
  expires_at: number;
}

export interface McpConsoleState {
  user: { name: string; subject?: string } | null;
  csrf: string;
  authorizations: McpAuthorization[];
  supportsReset: boolean;
  supportsDeviceAuthorization: boolean;
}

const API = "/platform/oauth/api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

function parseAuthorization(value: unknown): McpAuthorization {
  if (!isRecord(value)) throw new Error("invalid authorization record");
  const { authorization_id, client_id, client_name, grant_type, scopes, status, authorized_at, expires_at } = value;
  const source = value.source ?? "mcp";
  if (
    typeof authorization_id !== "string" || typeof client_id !== "string"
    || typeof client_name !== "string" || typeof grant_type !== "string"
    || (source !== "mcp" && source !== "cli") || !isStringArray(scopes)
    || (status !== "valid" && status !== "expired" && status !== "revoked" && status !== "reset_required")
    || typeof authorized_at !== "number" || !Number.isFinite(authorized_at)
    || typeof expires_at !== "number" || !Number.isFinite(expires_at)
  ) throw new Error("invalid authorization record");
  return { authorization_id, client_id, client_name, grant_type, source, scopes, status, authorized_at, expires_at };
}

export function parseConsoleState(value: unknown): McpConsoleState {
  if (!isRecord(value) || typeof value.csrf !== "string" || !Array.isArray(value.authorizations)) {
    throw new Error("invalid authorization console response");
  }
  const account = value.user;
  if (account !== null && (!isRecord(account) || typeof account.name !== "string")) {
    throw new Error("invalid authorization console user");
  }
  const user = account && typeof account.name === "string"
    ? { name: account.name, subject: typeof account.subject === "string" ? account.subject : undefined }
    : null;
  return {
    user,
    csrf: value.csrf,
    authorizations: value.authorizations.map(parseAuthorization),
    supportsReset: value.supports_reset === true,
    supportsDeviceAuthorization: value.supports_device_authorization === true,
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (isRecord(data) && typeof data.error === "string" && data.error) return data.error;
  } catch {
    // Non-JSON body; fall through to the generic message.
  }
  return fallback;
}

/** GET the console state; the response also carries the CSRF guard and the
 *  bridge session cookie needed for every subsequent POST. */
export async function fetchConsoleState(): Promise<McpConsoleState> {
  const response = await fetch(`${API}/authorizations`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "authorization service unavailable"));
  return parseConsoleState(await response.json());
}

/** POST a console action with the CSRF guard echo. Bridge errors arrive as
 *  `{"error": "<user-facing Chinese message>"}` and are surfaced verbatim. */
export async function consoleAction(
  action: string,
  csrf: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-MCP-CSRF": csrf },
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(isRecord(data) && typeof data.error === "string" && data.error ? data.error : "request failed");
  }
  if (!isRecord(data)) throw new Error("invalid authorization response");
  return data;
}

function parseAuthorizationAccount(data: Record<string, unknown>) {
  const { subject, name, avatar_url: avatarUrl } = data;
  if (typeof subject !== "string" || !subject || typeof name !== "string"
    || (avatarUrl !== null && (typeof avatarUrl !== "string" || !avatarUrl.startsWith("https://")))) {
    throw new Error("invalid authorization account");
  }
  return { subject, name, avatarUrl };
}

export async function fetchDeviceAccount(csrf: string, token: string) {
  return parseAuthorizationAccount(await consoleAction("agent/device/account", csrf, { token }));
}

type McpScope = "lynse:read" | "lynse:write";

export async function fetchMcpConsent(ticket: string) {
  const query = new URLSearchParams({ ticket });
  const response = await fetch(`${API}/context?${query}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "authorization service unavailable"));
  const data: unknown = await response.json();
  if (!isRecord(data) || data.web_account !== true || typeof data.client_name !== "string"
    || typeof data.csrf !== "string" || !isStringArray(data.scopes) || !data.scopes.includes("lynse:read")
    || !data.scopes.every((scope): scope is McpScope => scope === "lynse:read" || scope === "lynse:write")) {
    throw new Error("invalid MCP authorization request");
  }
  return { clientName: data.client_name, csrf: data.csrf, scopes: data.scopes };
}

export async function fetchMcpConsentAccount(ticket: string, csrf: string, token: string) {
  return parseAuthorizationAccount(await consoleAction("mcp-account", csrf, { ticket, token }));
}

export async function completeMcpConsent(ticket: string, csrf: string, decision:
  | { decision: "allow"; token: string; subject: string }
  | { decision: "deny" },
) {
  const { redirect_uri } = await consoleAction("consent", csrf, { ticket, ...decision });
  if (typeof redirect_uri !== "string") throw new Error("invalid MCP callback");
  const callback = new URL(redirect_uri);
  // The gateway matches the registered URI, including supported native app schemes.
  if (["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(callback.protocol)) {
    throw new Error("invalid MCP callback");
  }
  return callback.href;
}

export async function reviewDeviceRequest({ csrf, code, subject, token }: {
  csrf: string;
  code: string;
  subject: string;
  token: string;
}) {
  const data = await consoleAction("agent/device/review", csrf, { user_code: code, subject, token });
  const { ticket, client_name: clientName, scopes, requested_at: requestedAt, request_ip: requestIp } = data;
  if (data.source !== "cli" || typeof clientName !== "string" || !isStringArray(scopes)
    || typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)
    || typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt) || requestedAt <= 0
    || (requestIp !== null && typeof requestIp !== "string")) {
    throw new Error("invalid device authorization request");
  }
  const writeOptional = data.write_optional === true && scopes.includes("lynse:write");
  return { ticket, clientName, scopes, requestedAt, requestIp, writeOptional };
}

export async function completeDeviceRequest({ csrf, ticket, token, decision, allowWrite }: {
  csrf: string;
  ticket: string;
  token: string;
  decision: "allow" | "deny";
  allowWrite: boolean;
}) {
  const data = await consoleAction("agent/device/complete", csrf, { ticket, token, decision, allow_write: allowWrite });
  if (data.decision !== (decision === "allow" ? "allowed" : "denied")) {
    throw new Error("invalid device authorization result");
  }
}

/** Establish the bridge session from the web app's own account token when the
 *  bridge is not signed in yet; a rejected token (e.g. signed into the other
 *  environment) resolves false and the UI falls back to its logged-out state. */
export async function bootstrapConsole(state: McpConsoleState, token: string): Promise<McpConsoleState> {
  await consoleAction("token-login", state.csrf, { token });
  return fetchConsoleState();
}
