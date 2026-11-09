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
  scopes: string[];
  status: "valid" | "expired" | "revoked";
  authorized_at: number;
  expires_at: number;
}

export interface McpConsoleState {
  user: { name: string } | null;
  csrf: string;
  authorizations: McpAuthorization[];
}

const API = "/platform/oauth/api";

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error) return data.error;
  } catch {
    // Non-JSON body; fall through to the generic message.
  }
  return fallback;
}

/** GET the console state; the response also carries the CSRF guard and the
 *  bridge session cookie needed for every subsequent POST. */
export async function fetchConsoleState(): Promise<McpConsoleState> {
  const response = await fetch(`${API}/authorizations`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(await readError(response, "authorization service unavailable"));
  return (await response.json()) as McpConsoleState;
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
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof data.error === "string" && data.error ? data.error : "request failed");
  }
  return data;
}

/** Establish the bridge session from the web app's own account token when the
 *  bridge is not signed in yet; a rejected token (e.g. signed into the other
 *  environment) resolves false and the UI falls back to its logged-out state. */
export async function bootstrapConsole(state: McpConsoleState, token: string): Promise<McpConsoleState> {
  await consoleAction("token-login", state.csrf, { token });
  return fetchConsoleState();
}
