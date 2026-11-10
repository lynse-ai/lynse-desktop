import { api } from "../api/client";
import { isWechatBindRequired, type WechatLoginVo } from "./wechat";

/**
 * Apple sign-in (server-rendered authorize URL flow):
 *
 *  1. `GET /api/auth/render?authType=APPLE` → the AppleID authorize URL with
 *     a baked-in `state`. The backend owns the client-id/redirect config.
 *  2. Redirect the browser to that URL; Apple calls the configured redirect
 *     with `code`/`state`, and `POST /api/auth/login { authType: "APPLE",
 *     code, state }` completes the sign-in.
 *
 * The backend's Apple configuration may still carry placeholder values
 * ("your-client-id"); `isAppleAuthorizeUrlConfigured` detects that so the UI
 * can hide the entry until the backend is truly configured.
 */

/** Ask the backend for the Apple authorize URL. */
export async function renderAppleLoginUrl(): Promise<string | null> {
  const url = await api().getWithParams<string>("/api/auth/render", { authType: "APPLE" });
  return typeof url === "string" && url ? url : null;
}

/** Placeholder configs ("your-client-id") mean Apple is not actually set up. */
export function isAppleAuthorizeUrlConfigured(authorizeUrl: string | null): boolean {
  if (!authorizeUrl) return false;
  return !authorizeUrl.includes("your-client-id") && !authorizeUrl.includes("your-redirect-uri");
}

/** Send the browser through Apple's authorize page. */
export function startAppleLogin(authorizeUrl: string): void {
  if (typeof window !== "undefined") window.location.href = authorizeUrl;
}

/** Exchange the Apple callback `code` for a session (or a bind marker). */
export function loginByApple(code: string, state?: string): Promise<WechatLoginVo> {
  return api().post<WechatLoginVo>("/api/auth/login", { authType: "APPLE", code, state });
}

/** Convenience: bind-required check shared with the WeChat flow. */
export const isAppleBindRequired = isWechatBindRequired;
