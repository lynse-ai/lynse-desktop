import { api, ApiError } from "../api/client";
import type { AuthSession } from "./session";

/**
 * Phone number + SMS verification code sign-in.
 *
 * Flow:
 *  1. `GET /api/auth/captcha/sms?phone=...&actionType=LOGIN&dialCode=86`
 *     asks the backend to text a one-time code. The response carries a
 *     `cooldown` (seconds) the UI must honor before allowing a resend.
 *  2. `POST /api/auth/login` with `authType: "PHONE_CODE"` signs in. Phones
 *     that are not registered yet are registered on the fly by the backend,
 *     so one form covers both sign-in and sign-up.
 *
 * Expected backend contract (ApiClient unwraps the `{ code, data }` envelope;
 * business failures arrive as HTTP 200 with `code !== 200`):
 *  - `GET /api/auth/captcha/sms?phone=...&actionType=...&dialCode=...` →
 *      `{ success, cooldown }` (cooldown in seconds)
 *  - `POST /api/auth/login`
 *      body `{ authType: "PHONE_CODE", username: <phone>, captchaCode, dialCode }`
 *      → `{ token, customerId }`
 */

/** What the code is for; the backend scopes the SMS template to it. */
export type SmsCaptchaActionType =
  | "REGISTER"
  | "LOGIN"
  | "BIND"
  | "RESET"
  | "CHANGE";

export interface SmsCaptchaResult {
  /** Whether the SMS was dispatched (does not guarantee delivery). */
  success: boolean;
  /** Seconds the same phone must wait before requesting another code. */
  cooldown: number;
}

/** `AuthLoginVO` returned by `POST /api/auth/login`. */
export interface AuthLoginVo {
  token: string;
  customerId?: string;
}

/** Default resend wait when the backend omits the cooldown on success. */
export const SMS_RESEND_DEFAULT_SECONDS = 60;

/** SMS code lengths the backend may issue — the form accepts either. */
export const SMS_CODE_LENGTHS = [4, 6] as const;

/** Upper bound for the code input (the longer of SMS_CODE_LENGTHS). */
export const SMS_CODE_MAX_LENGTH = 6;

/** Whether a code has a complete length (4 or 6 digits). */
export function isCompleteSmsCode(code: string): boolean {
  return (SMS_CODE_LENGTHS as readonly number[]).includes(code.length);
}

/** Mainland-China mobile number (no + prefix, no dial code), 11 digits. */
export function isValidChinaPhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone);
}

/** Ask the backend to send a sign-in code to `phone`. */
export function sendSmsCaptcha(
  phone: string,
  opts: { actionType?: SmsCaptchaActionType; dialCode?: string } = {},
): Promise<SmsCaptchaResult> {
  return api().getWithParams<SmsCaptchaResult>("/api/auth/captcha/sms", {
    phone,
    actionType: opts.actionType ?? "LOGIN",
    dialCode: opts.dialCode ?? "86",
  });
}

/**
 * Sign in with phone + code. `phone` goes in the `username` field per the
 * backend contract. Unregistered phones are registered automatically.
 */
export function loginByPhoneCode(
  phone: string,
  captchaCode: string,
  dialCode = "86",
): Promise<AuthLoginVo> {
  return api().post<AuthLoginVo>("/api/auth/login", {
    authType: "PHONE_CODE",
    username: phone,
    captchaCode,
    dialCode,
  });
}

/** Assemble the persistable session from a phone-code login response. */
export function smsSessionFromLogin(vo: AuthLoginVo): AuthSession {
  return {
    accessToken: vo.token,
    user: { id: vo.customerId ?? "", name: "", email: "" },
  };
}

/**
 * Resend wait to honor after a failed send attempt — the gateway reports
 * rate limiting as `error.operation.too.frequent` with the remaining
 * `cooldown` seconds inside the envelope's `data`.
 */
export function cooldownSecondsFromError(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null;
  const data = error.data as { cooldown?: unknown } | undefined;
  const cooldown = Number(data?.cooldown);
  return Number.isFinite(cooldown) && cooldown > 0 ? cooldown : null;
}
