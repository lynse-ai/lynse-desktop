import { api } from "../api/client";
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
