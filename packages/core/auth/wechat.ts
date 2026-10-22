import { api, type ApiClient } from "../api/client";
import type { AuthSession } from "./session";

/**
 * WeChat QR-code sign-in (backend "WECHAT_SCAN" website-app flow).
 *
 * Flow:
 *  1. `GET /api/auth/render?authType=WECHAT_SCAN` → the WeChat qrconnect URL.
 *     The appid, scope and a backend-generated `state` are baked into the
 *     URL server-side — the client holds no WeChat credentials at all.
 *  2. The URL is opened (web: same-window redirect; desktop: an embedded
 *     auth window). After the scan is confirmed WeChat redirects the browser
 *     to the backend-configured `redirect_uri` with `?code=…&state=…`.
 *  3. `POST /api/auth/login` `{ authType: "WECHAT_SCAN", code, state }` →
 *     `WechatLoginVo`. When the response says a phone number must be linked
 *     first (`isNeedBind`), the client shows a phone + SMS form and calls
 *     `GET /api/auth/bind` with the `thirdPartyId` from the login response;
 *     the bind response carries the same session payload.
 *
 * The ApiClient unwraps the `{ code, data }` envelope; business failures
 * arrive as HTTP 200 with `code !== 200` and surface as ApiError.
 */

export const WECHAT_AUTH_TYPE = "WECHAT_SCAN";

/**
 * Validate the backend's website-app configuration without changing it.
 * Mobile WECHAT_JUMP credentials cannot be reused for qrconnect. The native
 * window intercepts the supplied redirect_uri before the page is requested.
 */
export function desktopWechatAuthorizeUrl(authorizeUrl: string): string {
  const url = new URL(authorizeUrl);
  if (
    url.origin !== "https://open.weixin.qq.com" ||
    url.pathname !== "/connect/qrconnect" ||
    url.searchParams.get("scope") !== "snsapi_login" ||
    url.searchParams.get("response_type") !== "code" ||
    !url.searchParams.get("appid") ||
    !url.searchParams.get("state") ||
    !url.searchParams.get("redirect_uri")
  ) {
    throw new Error("Invalid WeChat authorize URL");
  }
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  if (!["https:", "http:"].includes(callback.protocol)) {
    throw new Error("Invalid WeChat callback URL");
  }
  return authorizeUrl;
}

/** `AuthLoginVO` returned by the WeChat branch of `/api/auth/login`. */
export interface WechatLoginVo {
  token?: string | null;
  expireIn?: number | null;
  isFirstLogin?: boolean;
  firstLogin?: boolean;
  /** Bind-required flag — documented as `isNeedBind`; `needBind` is the
   *  legacy spelling some builds return. */
  isNeedBind?: boolean;
  needBind?: boolean;
  openId?: string;
  customerId?: string | null;
  /** WeChat identity handle echoed back for the bind call. */
  thirdPartyId?: string | null;
}

/** Ask the backend for the WeChat authorize URL (`state` included). */
export function renderWechatLoginUrl(client: ApiClient = api()): Promise<string> {
  return client.getWithParams<string>("/api/auth/render", {
    authType: WECHAT_AUTH_TYPE,
  });
}

/** The `state` baked into an authorize URL by the backend. */
export function stateFromAuthorizeUrl(authorizeUrl: string): string | null {
  try {
    return new URL(authorizeUrl).searchParams.get("state");
  } catch {
    return null;
  }
}

/** Extract `code`/`state` from a WeChat redirect (callback URL or location). */
export function wechatCallbackParams(callbackUrl: string): {
  code: string | null;
  state: string | null;
} {
  try {
    const params = new URL(callbackUrl).searchParams;
    return { code: params.get("code"), state: params.get("state") };
  } catch {
    return { code: null, state: null };
  }
}

/** Whether the login response asks the user to link a phone number first. */
export function isWechatBindRequired(vo: WechatLoginVo): boolean {
  return vo.isNeedBind === true || vo.needBind === true;
}

/**
 * Exchange the OAuth `code` for a session — or a bind-required marker when
 * the WeChat identity is not linked to a phone number yet.
 */
export function loginByWechat(
  code: string,
  state?: string,
): Promise<WechatLoginVo> {
  return api().post<WechatLoginVo>("/api/auth/login", {
    authType: WECHAT_AUTH_TYPE,
    code,
    state,
  });
}

/**
 * Link the WeChat identity (`thirdPartyId` from the login response) to a
 * phone number. `captchaCode` is the SMS code sent via
 * `sendSmsCaptcha(phone, { actionType: "BIND" })`. Resolves the session.
 */
export function bindWechatPhone(input: {
  thirdPartyId: string;
  phone: string;
  captchaCode: string;
}): Promise<WechatLoginVo> {
  return api().getWithParams<WechatLoginVo>("/api/auth/bind", {
    authType: WECHAT_AUTH_TYPE,
    thirdPartyId: input.thirdPartyId,
    username: input.phone,
    captchaCode: input.captchaCode,
  });
}

/** Assemble the persistable session from a login/bind response. */
export function wechatSessionFromVo(vo: WechatLoginVo): AuthSession | null {
  if (!vo.token) return null;
  return {
    accessToken: vo.token,
    user: { id: vo.customerId ?? "", name: "", email: "" },
  };
}
