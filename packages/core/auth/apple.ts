import { api } from "../api/client";
import { webOriginForApi } from "./google";
import type { AuthSession } from "./session";
import type { SmsCaptchaResult } from "./sms";
import type { WechatLoginVo } from "./wechat";

/**
 * Apple web sign-in (backend-mediated redirect, per the integration contract):
 *
 *  1. `GET /api/auth/render?authType=APPLE` → the Apple authorize URL
 *     (client_id = Services ID com.lynse.web, response_type = code id_token).
 *  2. The browser signs in on appleid.apple.com; Apple form-posts the one-time
 *     `code` + `state` to the BACKEND's `/api/auth/apple/callback`, which
 *     validates the state, exchanges the code, verifies the identity and 302s
 *     the browser to the configured landing pages:
 *       - bound       → web-success-url#token=…&expireIn=… (fragment: never
 *         sent to any server)
 *       - first login → web-bind-url?thirdPartyId={apple_sub} (bind flow)
 *       - failure     → web-bind-url?error={i18n error key}
 *
 * The frontend never touches `/api/auth/login` for APPLE — the callback 302
 * fragment carries the session token directly (bound) or the `thirdPartyId`
 * (apple_sub) that the bind endpoint links to an account.
 */

/** Ask the backend for the Apple authorize URL. */
export function renderAppleLoginUrl(): Promise<string> {
  return api().getWithParams<string>("/api/auth/render", { authType: "APPLE" });
}

/** Placeholder configs ("your-client-id") mean Apple web login isn't set up. */
export function isAppleAuthorizeUrlConfigured(authorizeUrl: string | null): boolean {
  if (!authorizeUrl) return false;
  return !authorizeUrl.includes("your-client-id") && !authorizeUrl.includes("your-redirect-uri");
}

/** Send the browser through Apple's authorize page (full-page redirect). */
export function startAppleLogin(authorizeUrl: string): void {
  if (typeof window !== "undefined") window.location.assign(authorizeUrl);
}

/**
 * Bind captcha for the Apple flow: the contract sends the credential as
 * `username` with `authType=APPLE&actionType=bind` (lowercase per contract).
 */
export function sendAppleBindCaptcha(
  target: string,
  channel: "email" | "phone",
): Promise<SmsCaptchaResult> {
  return api().getWithParams<SmsCaptchaResult>(
    channel === "email" ? "/api/auth/captcha/email" : "/api/auth/captcha/sms",
    { username: target, authType: "APPLE", actionType: "bind" },
  );
}

/**
 * Link the Apple identity (`apple_sub` from the web-bind-url landing) to a
 * Lynse account. `accountType` selects email (intl) or phone (cn); the bind
 * response carries the session token directly (bind = login).
 */
export function bindAppleIdentity(input: {
  thirdPartyId: string;
  username: string;
  captchaCode: string;
  accountType: "EMAIL" | "PHONE";
}): Promise<WechatLoginVo> {
  return api().getWithParams<WechatLoginVo>("/api/auth/bind", {
    authType: "APPLE",
    accountType: input.accountType,
    thirdPartyId: input.thirdPartyId,
    username: input.username,
    captchaCode: input.captchaCode,
  });
}

/** Session from an Apple success landing fragment (#token=…&expireIn=…). */
export function sessionFromAppleFragment(token: string): AuthSession {
  return { accessToken: token, user: { id: "", name: "", email: "" } };
}

/**
 * Web origin the backend 302s its APPLE flow to, derived from the API host
 * (the same site pairing the rest of the desktop uses: production CN
 * api.lynse.cn → www.lynse.cn, intl api-en.lynse.ai and the test gateway
 * gapp.lynse.cn → www.lynse.ai; anything else — dev/staging APIs included —
 * falls back to the CN site). The desktop auth window matches its landing
 * interception against this origin.
 */
export function appleWebLandingOrigin(apiBaseUrl: string): string {
  return webOriginForApi(apiBaseUrl);
}

/** One outcome relayed from an intercepted Apple landing URL. */
export type AppleLanding =
  | { kind: "session"; token: string }
  | { kind: "bind"; thirdPartyId: string }
  | { kind: "error"; key: string };

/** Parse an intercepted Apple landing URL into its outcome. The backend's
 *  contract (see the module docs): bound accounts land on web-success-url
 *  with the session in the fragment (#token=…&expireIn=…), first logins on
 *  web-bind-url?thirdPartyId={sub}, failures on web-bind-url?error={key}.
 *  Null when the URL carries none of the markers. */
export function appleLandingFromUrl(url: string): AppleLanding | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hash) {
    const token = new URLSearchParams(parsed.hash.slice(1)).get("token");
    if (token) return { kind: "session", token };
  }
  const thirdPartyId = parsed.searchParams.get("thirdPartyId");
  if (thirdPartyId) return { kind: "bind", thirdPartyId };
  const error = parsed.searchParams.get("error");
  if (error) return { kind: "error", key: error };
  return null;
}
