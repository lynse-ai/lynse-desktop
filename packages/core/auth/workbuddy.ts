import { api, ApiError } from "../api/client";

/**
 * WorkBuddy authorization (OAuth via the Lynse backend as the token holder).
 *
 * Flow:
 *  1. `GET /api/auth/workbuddy/authorize` returns the full authorize URL —
 *     open it in the system browser; never rebuild or append query params.
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
  /** Complete authorize URL — open it in the system browser as-is. */
  authorizeUrl: string;
  /** Diagnostic id for this authorization attempt; not sent back. */
  state: string;
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
export function startWorkBuddyAuthorization(): Promise<WorkBuddyAuthorizeStart> {
  return api().get<WorkBuddyAuthorizeStart>("/api/auth/workbuddy/authorize");
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
 * Poll for the ticket while the user works through the browser authorization.
 * `error.workbuddy.oauth.not.bound` is the expected "not finished yet" answer;
 * definitive server-side failures stop the loop early, transport hiccups do
 * not. Resolves with the ticket once `authorized`; rejects on timeout.
 */
export async function pollWorkBuddyAuthorization(
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    isCancelled?: () => boolean;
  } = {},
): Promise<WorkBuddyTokenInfo> {
  const intervalMs = opts.intervalMs ?? 2500;
  // The authorize `state` expires after roughly 10 minutes — past that the
  // backend callback can no longer complete, so stop polling.
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) throw new Error("cancelled");
    try {
      const info = await getWorkBuddyToken();
      if (info.authorized) return info;
      // Bound-but-unauthorized shape without an error envelope: keep waiting.
    } catch (error) {
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

// ── Direct WorkBuddy OpenAPI calls ──────────────────────────────────────────

let cachedTicket: { accessToken: string; expiresAtMs: number } | null = null;

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

function parseExpiresAtMs(expiresAt?: string): number {
  if (!expiresAt) return 0;
  const ms = Date.parse(expiresAt.replace(" ", "T"));
  return Number.isNaN(ms) ? 0 : ms;
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
  // TEMP diagnostics: the real avatar field name has not been verified
  // against a populated account yet — demote/remove once confirmed.
  console.warn("[workbuddy] /user/profile raw:", JSON.stringify(body));
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
  if (cachedTicket && cachedTicket.expiresAtMs - 60_000 > Date.now()) {
    return cachedTicket.accessToken;
  }
  const info = await getWorkBuddyToken();
  if (!info.authorized || !info.accessToken) {
    throw new Error(WORKBUDDY_ERROR.NOT_BOUND);
  }
  cachedTicket = {
    accessToken: info.accessToken,
    expiresAtMs: parseExpiresAtMs(info.expiresAt),
  };
  return cachedTicket.accessToken;
}

/**
 * Call the WorkBuddy OpenAPI directly (`https://www.workbuddy.cn/openapi/v2/...`)
 * with the authorized token — through the injected relay when the host
 * provides one (desktop), else plain `fetch` (web). A 401 triggers exactly
 * one ticket refresh through the Lynse backend and one retry; when the
 * refresh itself fails the not-bound key surfaces so the caller can send the
 * user through authorization again.
 */
export async function callWorkBuddyOpenApi<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const body = init.body ? JSON.stringify(init.body) : undefined;
  const send = (accessToken: string): Promise<{ status: number; body: string }> => {
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

  let res = await send(await getWorkBuddyAccessToken());
  if (res.status === 401) {
    cachedTicket = null;
    const info = await refreshWorkBuddyToken();
    if (!info.authorized || !info.accessToken) {
      throw new Error(WORKBUDDY_ERROR.TOKEN_EXPIRED);
    }
    cachedTicket = {
      accessToken: info.accessToken,
      expiresAtMs: parseExpiresAtMs(info.expiresAt),
    };
    res = await send(info.accessToken);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`WorkBuddy OpenAPI request failed (${res.status})`);
  }
  return JSON.parse(res.body) as T;
}
