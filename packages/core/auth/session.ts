import { api } from "../api/client";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
}

/**
 * Session payload returned by every login channel (API key, phone SMS,
 * WeChat). `apiKey` is present when the backend also issues an API key for
 * the account — persisting it lets `restoreSession` mint fresh access tokens
 * after a restart.
 */
export interface AuthSession {
  accessToken: string;
  apiKey?: string;
  user: AuthUser;
}

/** Operation a captcha is requested for (`actionType` on send + verify). */
export type CaptchaActionType =
  | "REGISTER"
  | "LOGIN"
  | "BIND"
  | "RESET"
  | "CHANGE";

/** Verification channel (`authType` on verify + login). */
export type CaptchaAuthType = "EMAIL" | "PHONE";

/** Default international dial code (mainland China). */
export const DEFAULT_DIAL_CODE = "86";

/**
 * Result of a captcha send request. `cooldown` is the number of seconds the
 * client must wait before offering a resend.
 */
export interface SmsCodeResult {
  success: boolean;
  cooldown: number;
}

/**
 * Payload of `POST /api/auth/login`. `needBind` is true for a third-party
 * identity that still has to be bound to a phone/email.
 */
export interface AuthLoginResult {
  token: string;
  expireIn?: number;
  customerId?: string;
  thirdPartyId?: string;
  firstLogin?: boolean;
  needBind?: boolean;
}

/**
 * Send an SMS verification code.
 * `GET /api/auth/captcha/sms?phone=...&actionType=...&dialCode=...`
 * (`phone` without the `+` prefix; `dialCode` defaults to 86).
 */
export function sendSmsCode(opts: {
  phone: string;
  actionType: CaptchaActionType;
  dialCode?: string;
}): Promise<SmsCodeResult> {
  return api().getWithParams<SmsCodeResult>("/api/auth/captcha/sms", {
    phone: opts.phone,
    actionType: opts.actionType,
    dialCode: opts.dialCode ?? DEFAULT_DIAL_CODE,
  });
}

/**
 * Send an email verification code.
 * `GET /api/auth/captcha/email?email=...&actionType=...`
 */
export function sendEmailCode(opts: {
  email: string;
  actionType: CaptchaActionType;
}): Promise<SmsCodeResult> {
  return api().getWithParams<SmsCodeResult>("/api/auth/captcha/email", {
    email: opts.email,
    actionType: opts.actionType,
  });
}

/**
 * Pre-check a captcha before the business call (`/login`, `/register`,
 * `/bind`, …). Resolves when the backend accepted the code; the backend
 * reuses the result so the same `code` can be replayed to the business
 * endpoint without re-verification.
 * `POST /api/auth/captcha/verify` body
 * `{ authType, actionType, code, username, dialCode? }` → `data: null`.
 */
export function verifyCaptcha(req: {
  authType: CaptchaAuthType;
  actionType: CaptchaActionType;
  code: string;
  /** Email address, or phone number without the `+` prefix. */
  username: string;
  dialCode?: string;
}): Promise<null> {
  return api().post<null>("/api/auth/captcha/verify", {
    authType: req.authType,
    actionType: req.actionType,
    code: req.code,
    username: req.username,
    ...(req.authType === "PHONE"
      ? { dialCode: req.dialCode ?? DEFAULT_DIAL_CODE }
      : {}),
  });
}

/**
 * Sign in with a captcha code: pre-check it via `/captcha/verify`, then
 * exchange it for a session at `POST /api/auth/login`
 * (`AuthLoginReq` → `AuthLoginVO`). The verify step is required — the
 * backend reuses its result inside the login call.
 */
export async function loginWithCaptchaCode(req: {
  authType: CaptchaAuthType;
  actionType: CaptchaActionType;
  code: string;
  username: string;
  dialCode?: string;
}): Promise<AuthLoginResult> {
  await verifyCaptcha(req);
  return api().post<AuthLoginResult>("/api/auth/login", {
    authType: req.authType,
    username: req.username,
    code: req.code,
  });
}

/**
 * Exchange a phone number + SMS code for a session (two-step captcha
 * verification, then login). The login response carries only a token and
 * customer id, so a minimal user is synthesized from them.
 */
export async function loginWithSmsCode(
  phone: string,
  code: string,
  dialCode: string = DEFAULT_DIAL_CODE,
): Promise<AuthSession> {
  const result = await loginWithCaptchaCode({
    authType: "PHONE",
    actionType: "LOGIN",
    code,
    username: phone,
    dialCode,
  });
  return {
    accessToken: result.token,
    user: { id: result.customerId ?? "", name: "", email: "" },
  };
}
