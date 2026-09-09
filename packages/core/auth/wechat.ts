import { api } from "../api/client";
import type { AuthSession } from "./session";

/**
 * WeChat QR-code sign-in (WeChat Open Platform "website app", scope
 * snsapi_login).
 *
 * Flow:
 *  1. The client builds the authorize URL with the public appid and a random
 *     `state`, then sends the user there (web: same-window redirect; desktop:
 *     system browser).
 *  2. After the user scans and confirms, WeChat redirects to
 *     `<redirectUri>?code=...&state=...` — the callback must be a page under
 *     the domain registered as the app's 授权回调域 (for the desktop app this
 *     is the web app's callback page).
 *  3. The callback POSTs `{ code, state }` to the backend, which exchanges the
 *     code for the WeChat access token (server-side secret), resolves or
 *     creates the Lynse user, and returns the app session. When `state`
 *     belongs to a pending desktop session, the backend also stores the result
 *     so the desktop app can pick it up.
 *  4. The desktop app polls `GET /api/auth/wechat/session?state=...` until the
 *     result shows up.
 *
 * Expected backend contract (ApiClient unwraps the `{ code, data }` envelope):
 *  - `POST /api/auth/wechat/login`   body `{ code, state? }` →
 *    `{ accessToken, apiKey?, user }`
 *  - `GET  /api/auth/wechat/session?state=...` →
 *    `{ status: "pending" } | { status: "complete", accessToken, apiKey?, user }`
 */

export type WechatSessionPoll =
  | { status: "pending" }
  | ({ status: "complete" } & AuthSession);

type WechatLoginConfig = {
  /** WeChat Open Platform appid (public — safe to ship to the client). */
  appId: string;
  /**
   * Origin hosting the `/auth/wechat` callback page. Only needed when the
   * redirect cannot be resolved from `window.location.origin` (desktop app).
   */
  redirectOrigin?: string;
};

let wechatConfig: WechatLoginConfig = { appId: "", redirectOrigin: "" };

/** Called once at app startup with the platform's build-time env values. */
export function configureWechatLogin(config: Partial<WechatLoginConfig>): void {
  wechatConfig = {
    appId: config.appId ?? wechatConfig.appId,
    redirectOrigin: config.redirectOrigin ?? wechatConfig.redirectOrigin,
  };
}

export function isWechatLoginConfigured(): boolean {
  return wechatConfig.appId !== "";
}

/** Random `state` for CSRF protection and desktop session binding. */
export function createWechatState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * The callback page URL WeChat redirects to after the scan. On web this is the
 * current origin; the desktop shell configures `redirectOrigin` to point at
 * the web app.
 */
export function defaultWechatRedirectUri(): string {
  const origin =
    wechatConfig.redirectOrigin ||
    (typeof window !== "undefined" ? window.location.origin : "");
  if (!origin) throw new Error("WeChat redirect origin is not configured");
  return `${origin.replace(/\/+$/, "")}/auth/wechat`;
}

/** WeChat Open Platform authorize URL (PC website app, QR-code login). */
export function buildWechatQrUrl(redirectUri: string, state: string): string {
  if (!wechatConfig.appId) throw new Error("WeChat login is not configured");
  const params = new URLSearchParams({
    appid: wechatConfig.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "snsapi_login",
    state,
  });
  return `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}#wechat_redirect`;
}

/**
 * Exchange the OAuth `code` for a Lynse session. `state` is forwarded so the
 * backend can complete a pending desktop session.
 */
export async function exchangeWechatCode(
  code: string,
  state?: string,
): Promise<AuthSession> {
  return api().post<AuthSession>("/api/auth/wechat/login", { code, state });
}

/**
 * Poll for the result of a desktop-initiated login. Resolves once the backend
 * reports `complete`; rejects on timeout.
 */
export async function pollWechatSession(
  state: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    isCancelled?: () => boolean;
  } = {},
): Promise<AuthSession> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 3 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) throw new Error("cancelled");
    const session = await api().getWithParams<WechatSessionPoll>(
      "/api/auth/wechat/session",
      { state },
    );
    if (session.status === "complete") {
      const { status: _status, ...result } = session;
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("WeChat login timed out");
}
