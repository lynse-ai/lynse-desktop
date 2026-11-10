import { api } from "../api/client";
import type { AuthSession } from "./session";
import { smsSessionFromLogin, type AuthLoginVo, type SmsCaptchaResult } from "./sms";

/**
 * Email + verification code sign-in (verified against the live backend).
 *
 * Flow:
 *  1. `GET /api/auth/captcha/email?email=...&actionType=LOGIN` sends a
 *     one-time code; the response carries a `cooldown` (seconds).
 *  2. `POST /api/auth/login` with `authType: "EMAIL_CODE"` and the email in
 *     the `username` field signs in; unknown addresses register on the fly
 *     (same behavior as phone codes).
 *
 * Note the asymmetric param names: the send endpoint takes `email`, the
 * login endpoint takes `username` (probed 2026-11-10, both environments).
 */

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Ask the backend to send a code to `email`. `BIND` links a third-party
 * identity (Google/Apple on the intl site); `LOGIN` signs in directly.
 */
export function sendEmailCaptcha(
  email: string,
  opts: { actionType?: "LOGIN" | "BIND" } = {},
): Promise<SmsCaptchaResult> {
  return api().getWithParams<SmsCaptchaResult>("/api/auth/captcha/email", {
    email,
    actionType: opts.actionType ?? "LOGIN",
  });
}

/** Sign in with email + code (`username` field per the backend contract). */
export function loginByEmailCode(email: string, captchaCode: string): Promise<AuthLoginVo> {
  return api().post<AuthLoginVo>("/api/auth/login", {
    authType: "EMAIL_CODE",
    username: email,
    captchaCode,
  });
}

/** The email login response shares the phone login session shape. */
export function emailSessionFromLogin(vo: AuthLoginVo): AuthSession {
  return smsSessionFromLogin(vo);
}
