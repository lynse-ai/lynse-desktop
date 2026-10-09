import { api, ApiError } from "../api/client";
import { WORKBUDDY_CLOUD_SCOPES } from "../workbuddy/scopes";

/**
 * WorkBuddy authorization (OAuth via the Lynse backend as the token holder).
 *
 * Flow:
 *  1. `GET /api/auth/workbuddy/authorize` returns the full authorize URL.
 *     Remove excluded contact and credit scopes before opening it; preserve all
 *     other parameters, including client ID, redirect URI and state. Cloud
 *     mode requests profile access and both required cloud task scopes.
 *  2. The user approves on WorkBuddy; WorkBuddy redirects to the backend's
 *     `/callback`, which exchanges the code server-side and 302s to a frontend
 *     page (`?status=ok` / `?status=fail&reason=...`). The app never calls
 *     `/callback` itself.
 *  3. The app learns the outcome by polling `GET /api/auth/workbuddy/token`:
 *     while still unbound it fails with `error.workbuddy.oauth.not.bound`;
 *     once bound it returns the ticket to call WorkBuddy directly.
 *  4. Direct WorkBuddy OpenAPI calls use `Authorization: Bearer {accessToken}`.
 *     On 401, refresh via `POST /api/auth/workbuddy/token/refresh` and retry
 *     once; a failed refresh means the user must authorize again. The backend
 *     never hands out the refresh token.
 *
 * Backend contract (ApiClient unwraps the `{ code, data }` envelope);
 * error keys come from error-messages.yaml v1.0.24.
 */

/** WorkBuddy OpenAPI base — called straight from the client, not via Lynse. */
const WORKBUDDY_OPENAPI_BASE = "https://www.workbuddy.cn/openapi/v2";
const WORKBUDDY_EXCLUDED_SCOPES = new Set(["user.contact.readable", "user.credit.exchange"]);

/** Backend error keys for the WorkBuddy authorization flow. */
export const WORKBUDDY_ERROR = {
  CONFIG_INVALID: "error.workbuddy.config.invalid",
  EXCHANGE_FAILED: "error.workbuddy.token.exchange.failed",
  STATE_INVALID: "error.workbuddy.oauth.state.invalid",
  NOT_BOUND: "error.workbuddy.oauth.not.bound",
  TOKEN_EXPIRED: "error.workbuddy.oauth.token.expired",
  CALLBACK_FAILED: "error.workbuddy.oauth.callback.failed",
} as const;

export interface WorkBuddyAuthorizeStart {
  /** Complete authorize URL with excluded scopes removed. */
  authorizeUrl: string;
  /** Diagnostic id for this authorization attempt; not sent back. */
  state: string;
}

export interface WorkBuddyAuthorizationDiagnostics {
  backendOrigin: string | null;
  authorizeEndpoint: string | null;
  redirectEndpoint: string | null;
  responseTypeCode: boolean;
  clientIdPresent: boolean;
  redirectUriPresent: boolean;
  statePresent: boolean;
  stateMatches: boolean;
  scopeExplicit: boolean;
  contactReadable: boolean;
  creditExchange: boolean;
  taskReadable: boolean;
  taskInvokable: boolean;
}

let authorizationDiagnostics: ((value: WorkBuddyAuthorizationDiagnostics) => void) | null = null;

/** Hosts can record configuration evidence without recording OAuth secrets. */
export function setWorkBuddyAuthorizationDiagnostics(
  observer: ((value: WorkBuddyAuthorizationDiagnostics) => void) | null,
): void {
  authorizationDiagnostics = observer;
}

function inspectAuthorization(start: WorkBuddyAuthorizeStart): WorkBuddyAuthorizationDiagnostics {
  let backend: URL | null = null;
  try { backend = new URL(api().getBaseUrl()); } catch { /* Do not record invalid configuration values. */ }
  let url: URL | null = null;
  try { url = new URL(start.authorizeUrl); } catch { /* Report malformed URLs without logging their contents. */ }
  const query = url?.searchParams;
  const redirectUri = query?.get("redirect_uri");
  let redirect: URL | null = null;
  try { if (redirectUri) redirect = new URL(redirectUri); } catch { /* Configuration evidence only. */ }
  const scopes = new Set((query?.get("scope") ?? "").split(/\s+/));
  return {
    backendOrigin: backend?.origin ?? null,
    authorizeEndpoint: url ? `${url.origin}${url.pathname}` : null,
    redirectEndpoint: redirect ? `${redirect.origin}${redirect.pathname}` : null,
    responseTypeCode: query?.get("response_type") === "code",
    clientIdPresent: Boolean(query?.get("client_id")),
    redirectUriPresent: Boolean(redirectUri),
    statePresent: Boolean(query?.get("state")),
    stateMatches: Boolean(start.state && query?.get("state") === start.state),
    scopeExplicit: Boolean(query?.get("scope")),
    contactReadable: scopes.has("user.contact.readable"),
    creditExchange: scopes.has("user.credit.exchange"),
    taskReadable: scopes.has("user.task.readable"),
    taskInvokable: scopes.has("user.task.invokable"),
  };
}

export interface WorkBuddyTokenInfo {
  authorized: boolean;
  /** Bearer token for direct WorkBuddy OpenAPI calls. */
  accessToken?: string;
  /** WorkBuddy user open_id. */
  openId?: string;
  /** Space-separated granted scopes. */
  scope?: string;
  /** Server-formatted expiry, `yyyy-MM-dd HH:mm:ss`. */
  expiresAt?: string;
  expired?: boolean;
}

/** Raised when polling outlives the ~10-minute authorize `state` window. */
export class WorkBuddyPollTimeoutError extends Error {
  constructor() {
    super("WorkBuddy authorization timed out");
    this.name = "WorkBuddyPollTimeoutError";
  }
}

export function isWorkBuddyNotBoundError(error: unknown): boolean {
  return error instanceof ApiError && error.message === WORKBUDDY_ERROR.NOT_BOUND;
}

/**
 * All three calls ride the configured backend base URL (same server the login
 * token was issued by — a token is only valid on its issuing server), so
 * pointing the app at the test server exercises WorkBuddy there too.
 */

/** `GET /api/auth/workbuddy/authorize` — step 1 of the flow. */
export async function startWorkBuddyAuthorization(opts: { cloud?: boolean } = {}): Promise<WorkBuddyAuthorizeStart> {
  const start = await api().get<WorkBuddyAuthorizeStart>("/api/auth/workbuddy/authorize");
  const url = new URL(start.authorizeUrl);
  const scope = url.searchParams.get("scope");
  // Omitting scope requests the app's full registered list, which may include
  // excluded scopes. Never fall back to that implicit grant after filtering.
  if (!opts.cloud && !scope?.trim()) throw new Error("WorkBuddy authorization requires an explicit scope list");
  const scopes = scope?.trim() ? scope.trim().split(/\s+/) : [];
  const permitted = opts.cloud
    ? ["user.profile.readable", ...WORKBUDDY_CLOUD_SCOPES]
    : scopes.filter((value) => !WORKBUDDY_EXCLUDED_SCOPES.has(value));
  if (permitted.length === 0) throw new Error("WorkBuddy authorization has no permitted scopes");
  if (permitted.length === scopes.length && permitted.every((value, index) => value === scopes[index])) return start;
  url.searchParams.set("scope", permitted.join(" "));
  return { ...start, authorizeUrl: url.href };
}

/** `GET /api/auth/workbuddy/token` — the server refreshes an about-to-expire
 *  ticket before returning it. */
export function getWorkBuddyToken(): Promise<WorkBuddyTokenInfo> {
  return api().get<WorkBuddyTokenInfo>("/api/auth/workbuddy/token");
}

/** `POST /api/auth/workbuddy/token/refresh` — same shape as the token read. */
export function refreshWorkBuddyToken(): Promise<WorkBuddyTokenInfo> {
  return api().post<WorkBuddyTokenInfo>("/api/auth/workbuddy/token/refresh");
}

/**
 * The backend token endpoint reports the user's *stored* binding, not the
 * outcome of a specific authorize attempt (no state-scoped poll exists yet —
 * the integrations OAuth flow has one, WorkBuddy does not). To tell "the user
 * just consented" apart from "was already bound", callers pass the binding
 * observed before opening the browser and the poll only resolves once that
 * fingerprint (openId + scope + expiry) actually changed.
 *
 * Caveat: when the stored ticket is close to expiry the backend rotates it on
 * read, which also moves the fingerprint — a narrow false "changed" window
 * that only a state-scoped backend endpoint could close.
 */
function tokenFingerprint(info: WorkBuddyTokenInfo): string {
  return [info.openId ?? "", info.scope ?? "", info.expiresAt ?? ""].join("|");
}

/**
 * Poll for the ticket while the user works through the browser authorization.
 * `error.workbuddy.oauth.not.bound` is the expected "not finished yet" answer;
 * definitive server-side failures stop the loop early, transport hiccups do
 * not. When `opts.previous` holds an authorized binding, resolving additionally
 * requires the fingerprint to move, so a stale pre-existing grant never ends
 * the wait. Resolves with the (changed) ticket; rejects on timeout.
 */
export async function pollWorkBuddyAuthorization(
  opts: {
    previous?: WorkBuddyTokenInfo | null;
    intervalMs?: number;
    timeoutMs?: number;
    isCancelled?: () => boolean;
  } = {},
): Promise<WorkBuddyTokenInfo> {
  const assertSession = workBuddySessionGuard();
  const assertCurrent = () => {
    assertSession();
    if (opts.isCancelled?.()) throw new Error("cancelled");
  };
  const intervalMs = opts.intervalMs ?? 2500;
  // The authorize `state` expires after roughly 10 minutes — past that the
  // backend callback can no longer complete, so stop polling.
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  const previousFingerprint =
    opts.previous?.authorized ? tokenFingerprint(opts.previous) : null;

  while (Date.now() < deadline) {
    assertCurrent();
    try {
      const info = await getWorkBuddyToken();
      assertCurrent();
      if (info.authorized) {
        const changed =
          previousFingerprint === null ||
          tokenFingerprint(info) !== previousFingerprint;
        if (changed) {
          // A fresh grant replaces whatever ticket this session may have
          // cached — drop it so the next OpenAPI call refetches instead of
          // replaying a pre-authorization token that lacks the new scopes.
          cachedTicket = null;
          return info;
        }
      }
      // Bound-but-unauthorized shape without an error envelope: keep waiting.
    } catch (error) {
      assertCurrent();
      if (isWorkBuddyNotBoundError(error)) {
        // Expected while the user is still on the authorize page.
      } else if (
        error instanceof ApiError &&
        (error.message === WORKBUDDY_ERROR.CONFIG_INVALID ||
          error.message === WORKBUDDY_ERROR.EXCHANGE_FAILED)
      ) {
        // Definitive — retrying within this session cannot succeed.
        throw error;
      }
      // Anything else (transport hiccup, transient 5xx): keep trying.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new WorkBuddyPollTimeoutError();
}

/**
 * Shared browser-authorization run behind both entry points (settings card,
 * chat page): fetch the current binding as the change baseline, ask the host
 * to open the authorize URL, then poll until the binding actually moves.
 * The two UI layers previously each inlined this loop with diverging error
 * handling; they now only supply how the URL opens and how cancellation is
 * observed.
 */
export async function runWorkBuddyAuthorization(opts: {
  /** Opens the authorize URL outside the app (system browser / new tab). */
  openUrl: (url: string) => void;
  cloud?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  isCancelled?: () => boolean;
}): Promise<WorkBuddyTokenInfo> {
  const assertSession = workBuddySessionGuard();
  const assertCurrent = () => {
    assertSession();
    if (opts.isCancelled?.()) throw new Error("cancelled");
  };
  assertCurrent();
  let previous: WorkBuddyTokenInfo | null = null;
  try {
    previous = await getWorkBuddyToken();
  } catch {
    // Unbound (the normal first-run case) or a transient read failure —
    // either way the poll may resolve on the first authorized answer.
    previous = null;
  }
  assertCurrent();
  const start = await startWorkBuddyAuthorization({ cloud: opts.cloud });
  assertCurrent();
  // Diagnostics are best-effort and observe the URL that will actually open.
  try { authorizationDiagnostics?.(inspectAuthorization(start)); } catch { /* Ignore a failed diagnostic sink. */ }
  opts.openUrl(start.authorizeUrl);
  return pollWorkBuddyAuthorization({
    previous,
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs,
    isCancelled: opts.isCancelled,
  });
}

// ── Direct WorkBuddy OpenAPI calls ──────────────────────────────────────────

let cachedTicket: { accessToken: string; expiresAtMs: number; context: string } | null = null;
let ticketGeneration = 0;

function ticketContext(): string {
  const client = api();
  return `${client.getBaseUrl?.() ?? ""}|${client.getToken?.() ?? ""}|${ticketGeneration}`;
}

/** Invalidate grants when the authenticated account or backend changes. */
export function clearWorkBuddyTokenCache(): void {
  ticketGeneration += 1;
  cachedTicket = null;
}

function assertTicketContext(context: string): void {
  if (ticketContext() !== context) throw new Error("WorkBuddy session changed");
}

/** An opaque guard for live task channels and protected artifact requests. */
export function workBuddySessionGuard(): () => void {
  const context = ticketContext();
  return () => assertTicketContext(context);
}

/**
 * Host-injected HTTP relay for the direct OpenAPI calls below. Desktop shells
 * wire this to a Tauri command (reqwest) because www.workbuddy.cn serves no
 * CORS headers for the `tauri://localhost` origin, so WebView `fetch` is
 * blocked. Core stays host-agnostic: without a relay (web) the calls fall
 * back to plain `fetch` with the same wire shape.
 */
export interface WorkBuddyHttpRelayRequest {
  /** Path under the OpenAPI base, leading slash, query string included. */
  path: string;
  method: string;
  /** Serialized JSON body, when present. */
  body?: string;
  accessToken: string;
}

export interface WorkBuddyHttpRelayResponse {
  /** Upstream HTTP status, verbatim (401s included). */
  status: number;
  /** Raw response body text; the caller parses it. */
  body: string;
}

let httpRelay:
  | ((req: WorkBuddyHttpRelayRequest) => Promise<WorkBuddyHttpRelayResponse>)
  | null = null;

export function setWorkBuddyHttpRelay(
  relay: ((req: WorkBuddyHttpRelayRequest) => Promise<WorkBuddyHttpRelayResponse>) | null,
): void {
  httpRelay = relay;
}

/** Raised when WorkBuddy keeps answering 429 past the documented backoff. */
export class WorkBuddyRateLimitError extends Error {
  constructor() {
    super("WorkBuddy rate limited");
    this.name = "WorkBuddyRateLimitError";
  }
}

/**
 * Server-formatted expiry, `yyyy-MM-dd HH:mm:ss` in the server's wall clock
 * (Asia/Shanghai). `Date.parse` would read it as the *local* timezone and be
 * off by the machine's UTC offset, so pin the +08:00 explicitly. Only used
 * for relative "is it still fresh" checks; a parse failure yields 0, which
 * just means "refetch".
 */
/** Exported for tests. */
export function parseExpiresAtMs(expiresAt?: string): number {
  const match = expiresAt
    ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(expiresAt.trim())
    : null;
  if (!match) return 0;
  // The regex guarantees every group participated; defaults only satisfy
  // noUncheckedIndexedAccess on the destructuring.
  const [, y = "", mo = "", d = "", h = "", mi = "", s = ""] = match;
  return Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +s);
}

/** WorkBuddy error bodies carry the actionable detail (`invalid_scope`, app
 *  under review, …) — keep a short excerpt so failures stay diagnosable from
 *  the message alone. */
function bodyExcerpt(body: string): string {
  const text = body.trim().replace(/\s+/g, " ");
  return text ? `: ${text.slice(0, 300)}` : "";
}

/** WorkBuddy user profile (`user.profile.readable`). */
export interface WorkBuddyProfile {
  nickname?: string;
  avatar?: string;
}

const firstStringField = (data: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

/**
 * `GET /user/profile` — the WorkBuddy user's nickname and avatar. Tolerates
 * both the documented bare-object shape and a `{ code, data }` envelope;
 * a nonzero envelope code surfaces as an error. Avatar key spellings vary
 * across platform versions, so the common variants are accepted.
 */
export async function getWorkBuddyProfile(): Promise<WorkBuddyProfile> {
  const body = await callWorkBuddyOpenApi<unknown>("/user/profile");
  // Verified live (2026-09-21): the response is the bare documented shape
  // `{"nickname":"…","avatar":""}` — avatar is "" when the account has none.
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof root.code === "number" && root.code !== 0) {
    throw new Error(
      typeof root.msg === "string" && root.msg
        ? `WorkBuddy profile error: ${root.msg}`
        : `WorkBuddy profile error (${root.code})`,
    );
  }
  const data = (
    root.data && typeof root.data === "object" ? root.data : root
  ) as Record<string, unknown>;
  return {
    nickname: firstStringField(data, ["nickname", "nickName", "name", "userName"]),
    avatar: firstStringField(data, [
      "avatar",
      "avatarUrl",
      "avatar_url",
      "headImg",
      "headImgUrl",
      "head_img",
      "head_img_url",
      "face",
      "faceUrl",
      "photo",
      "photoUrl",
      "image",
      "icon",
    ]),
  };
}

/**
 * In-memory access token for direct WorkBuddy OpenAPI calls, refreshed through
 * the Lynse backend when missing or close to expiry. Never persisted — the
 * doc requires the token stay out of URLs and storage.
 */
export async function getWorkBuddyAccessToken(): Promise<string> {
  const context = ticketContext();
  if (cachedTicket?.context === context && cachedTicket.expiresAtMs - 60_000 > Date.now()) {
    return cachedTicket.accessToken;
  }
  const info = await getWorkBuddyToken();
  assertTicketContext(context);
  if (!info.authorized || !info.accessToken) {
    throw new Error(WORKBUDDY_ERROR.NOT_BOUND);
  }
  cachedTicket = {
    accessToken: info.accessToken,
    expiresAtMs: parseExpiresAtMs(info.expiresAt),
    context,
  };
  return cachedTicket.accessToken;
}

/** 403 bodies that a backend refresh can actually fix: the grant moved under
 *  the cached ticket (typically the user just re-consented to new scopes).
 *  Every other documented 403 — access_denied, forbidden (server whitelist),
 *  PermissionDenied — is terminal and must surface as-is. */
function isInsufficientScopeBody(body: string): boolean {
  return body.includes("insufficient_scope");
}

/**
 * One OpenAPI call with the documented 429 policy: exponential backoff
 * (1s → 2s → 4s) before giving up. The relay surfaces no response headers,
 * so a server-provided Retry-After hint is unavailable and the fixed
 * schedule is used verbatim. Exhausting it raises WorkBuddyRateLimitError so
 * callers can tell throttling apart from transport failures.
 */
async function sendWithRateLimitBackoff(
  send: (accessToken: string) => Promise<{ status: number; body: string }>,
  accessToken: string,
): Promise<{ status: number; body: string }> {
  const backoffMs = [0, 1_000, 2_000, 4_000];
  for (const [index, waitMs] of backoffMs.entries()) {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const res = await send(accessToken);
    if (res.status !== 429) return res;
    if (index === backoffMs.length - 1) throw new WorkBuddyRateLimitError();
  }
  throw new WorkBuddyRateLimitError();
}

/**
 * Call the WorkBuddy OpenAPI directly (`https://www.workbuddy.cn/openapi/v2/...`)
 * with the authorized token — through the injected relay when the host
 * provides one (desktop), else plain `fetch` (web). A 401, or a 403 whose
 * body says `insufficient_scope`, triggers exactly one ticket refresh through
 * the Lynse backend and one retry (the grant moved under the cached token);
 * when the refresh itself fails the not-bound key surfaces so the caller can
 * send the user through authorization again. Any other 4xx surfaces with the
 * upstream body instead of burning a refresh on it.
 */
export async function callWorkBuddyOpenApi<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const context = ticketContext();
  const body = init.body ? JSON.stringify(init.body) : undefined;
  const send = (accessToken: string): Promise<{ status: number; body: string }> => {
    assertTicketContext(context);
    if (httpRelay) {
      return httpRelay({ path, method: init.method ?? "GET", body, accessToken });
    }
    return fetch(`${WORKBUDDY_OPENAPI_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${accessToken}`,
      },
      body,
    }).then(async (res) => ({ status: res.status, body: await res.text() }));
  };

  let res = await sendWithRateLimitBackoff(send, await getWorkBuddyAccessToken());
  assertTicketContext(context);
  if (res.status === 401 || (res.status === 403 && isInsufficientScopeBody(res.body))) {
    cachedTicket = null;
    const info = await refreshWorkBuddyToken();
    assertTicketContext(context);
    if (!info.authorized || !info.accessToken) {
      throw new Error(WORKBUDDY_ERROR.TOKEN_EXPIRED);
    }
    cachedTicket = {
      accessToken: info.accessToken,
      expiresAtMs: parseExpiresAtMs(info.expiresAt),
      context,
    };
    res = await sendWithRateLimitBackoff(send, info.accessToken);
    assertTicketContext(context);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `WorkBuddy OpenAPI request failed (${res.status})${bodyExcerpt(res.body)}`,
    );
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    // A 2xx with a non-JSON body (empty string, HTML interstitial) should not
    // surface as a context-free SyntaxError.
    throw new Error(
      `WorkBuddy OpenAPI returned a non-JSON body (${res.status})${bodyExcerpt(res.body)}`,
    );
  }
}

/**
 * Local-assistant online state (`user.localassistant.readable`, documented
 * shape `data.online`). Call it before posting a message: the assistant has
 * no push channel, so a message to an offline desktop client is never
 * answered and the caller would poll to its deadline. A failed probe throws
 * — treat "unknown" differently from "offline" at the call site.
 */
export async function getWorkBuddyOnlineStatus(): Promise<boolean> {
  const body = await callWorkBuddyOpenApi<unknown>("/localassistant");
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data = (
    root.data && typeof root.data === "object" ? root.data : root
  ) as Record<string, unknown>;
  return data.online === true || root.online === true;
}

/**
 * Map a WorkBuddy-flow error onto an i18n key (plus interpolation params).
 * Known dotted server keys map to dedicated lines; everything else
 * interpolates the raw message into the fallback's {{error}} slot. Shared by
 * the settings card and the chat page; pure key mapping keeps core
 * React-free.
 */
export function workbuddyErrorCopy(
  error: unknown,
  fallbackKey: string,
): { key: string; params?: Record<string, unknown> } {
  if (error instanceof WorkBuddyPollTimeoutError) return { key: "workbuddy.err_timeout" };
  const raw = error instanceof Error && error.message ? error.message.trim() : "";
  switch (raw) {
    case WORKBUDDY_ERROR.CONFIG_INVALID:
      return { key: "workbuddy.err_config_invalid" };
    case WORKBUDDY_ERROR.EXCHANGE_FAILED:
      return { key: "workbuddy.err_exchange_failed" };
    case WORKBUDDY_ERROR.STATE_INVALID:
      return { key: "workbuddy.err_state_invalid" };
    case WORKBUDDY_ERROR.NOT_BOUND:
      return { key: "workbuddy.err_not_bound" };
    case WORKBUDDY_ERROR.TOKEN_EXPIRED:
      return { key: "workbuddy.err_token_expired" };
    case WORKBUDDY_ERROR.CALLBACK_FAILED:
      return { key: "workbuddy.err_callback_failed" };
    case "system.error.busy":
      return { key: "workbuddy.err_server_busy" };
    default:
      return { key: fallbackKey, params: { error: raw } };
  }
}
