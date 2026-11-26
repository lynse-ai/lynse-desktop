import { api } from "../api/client";
import type { AuthSession } from "./session";
import { smsSessionFromLogin, type AuthLoginVo } from "./sms";
// Core has no Node types (@types/node is out of boundary); declare just the
// shape Next.js injects (see config/index.ts for the inlining rules).
declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * Google sign-in via Firebase Auth (two-step, per the backend contract):
 *
 *  1. The Firebase Auth SDK runs the Google popup flow; `user.getIdToken()`
 *     yields the Firebase ID Token (JWT).
 *  2. `POST /api/auth/login { authType: "GOOGLE", identityToken }` — the
 *     backend verifies it with Firebase Admin and answers either a bound
 *     session (`token`) or a bind-required marker (`isNeedBind` +
 *     `thirdPartyId`) that must be completed with `bindThirdPartyPhone`.
 *
 * Firebase web config arrives via NEXT_PUBLIC_FIREBASE_* env vars; without
 * them `isGoogleConfigured()` is false and the UI hides the Google button
 * on deployments without Google sign-in.
 */

export interface GoogleBindRequired {
  status: "need_bind";
  thirdPartyId: string;
}

export interface GoogleLoginResult {
  status: "signed_in" | "need_bind" | "redirecting";
  session?: AuthSession;
  thirdPartyId?: string;
}

/** Firebase web config from build-time env; empty strings when unset.
 *  The literal `process.env.NEXT_PUBLIC_*` member expressions are required —
 *  Next.js inlines exactly those at build time (indirect access would survive
 *  into the browser bundle as an undefined `process`). */
function firebaseConfig() {
  return {
    apiKey: (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_API_KEY) || "",
    authDomain: (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN) || "",
    projectId: (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) || "",
    appId: (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_APP_ID) || "",
  };
}

/** Whether the Google button can actually run (Firebase config present). */
export function isGoogleConfigured(): boolean {
  const config = firebaseConfig();
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

/** Identity shape echoed back for the bind call (mirrors WeChatLoginVo). */
export interface ThirdPartyLoginVo {
  token?: string | null;
  expireIn?: number | null;
  isFirstLogin?: boolean;
  isNeedBind?: boolean;
  needBind?: boolean;
  customerId?: string | null;
  thirdPartyId?: string | null;
}

/** Exchange a Firebase ID Token for a Lynse session via the login endpoint. */
export function loginByGoogleIdentityToken(identityToken: string): Promise<ThirdPartyLoginVo> {
  return api().post<ThirdPartyLoginVo>("/api/auth/login", {
    authType: "GOOGLE",
    identityToken,
  });
}

function needBind(vo: ThirdPartyLoginVo): boolean {
  // The backend marks a first-time Google identity with isNeedBind; some
  // environments only return isFirstLogin + no token. Treat both as bind.
  return isGoogleBindRequired(vo);
}

/** Bind-required marker shared by the popup and the desktop relay flows. */
export function isGoogleBindRequired(vo: ThirdPartyLoginVo): boolean {
  return vo.isNeedBind === true || vo.needBind === true ||
    (vo.isFirstLogin === true && !vo.token);
}

let firebase: {
  auth: ReturnType<typeof import("firebase/auth")["getAuth"]>;
  sdk: typeof import("firebase/auth");
} | undefined;
let loading: Promise<void> | undefined;

export function warmUpGoogleAuth(): Promise<void> {
  if (firebase) return Promise.resolve();
  return loading ??= Promise.all([import("firebase/app"), import("firebase/auth")])
    .then(([appSdk, sdk]) => {
      const app = appSdk.getApps()[0] ?? appSdk.initializeApp(firebaseConfig());
      firebase = { auth: sdk.getAuth(app), sdk };
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
}

/** Firebase error code (e.g. `auth/popup-blocked`), null for other shapes. */
export function errCode(e: unknown): string | null {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : null;
}

/** Finish a Google sign-in from a popup credential or a redirect result. */
async function finishGoogleSignIn(user: { getIdToken: (force?: boolean) => Promise<string> }): Promise<GoogleLoginResult> {
  const identityToken = await user.getIdToken();
  const vo = await loginByGoogleIdentityToken(identityToken);
  if (needBind(vo)) {
    return { status: "need_bind", thirdPartyId: vo.thirdPartyId ?? "" };
  }
  return { status: "signed_in", session: smsSessionFromLogin(vo as AuthLoginVo) };
}

/**
 * Google sign-in: popup first (opens synchronously inside the click handler —
 * the login page preloads Firebase when this method is configured). Browsers
 * that block popups fall back to the full-page redirect,
 * whose result `completeGoogleRedirect` finishes after the browser returns.
 */
export async function signInWithGoogle(): Promise<GoogleLoginResult | GoogleBindRequired> {
  if (!firebase) await warmUpGoogleAuth();
  if (!firebase) throw new Error("Google sign-in unavailable");
  const { auth, sdk } = firebase;
  const provider = new sdk.GoogleAuthProvider();
  try {
    const credential = await sdk.signInWithPopup(auth, provider);
    return await finishGoogleSignIn(credential.user);
  } catch (e: unknown) {
    if (errCode(e) === "auth/popup-blocked") {
      await sdk.signInWithRedirect(auth, provider);
      return { status: "redirecting" };
    }
    throw e;
  }
}

// ── Desktop: standalone auth-window relay flow ──────────────────────────────
//
// Google refuses OAuth in embedded WebViews, so the desktop cannot run the
// popup above. Instead the desktop opens its standalone auth window on the
// web app's relay page (`/auth/google-desktop?nonce=…`), which runs the
// Firebase REDIRECT round trip inside that window and hands the resulting ID
// token back by navigating to a done-marker URL the window intercepts
// (`/auth/google-desktop/done#identityToken=…&nonce=…`). The web app serves
// the relay page from the same origin pair as the Apple flow
// (`webOriginForApi`), so the contract stays web-origin driven.

/** Relay page path on the web app (the auth window's initial URL). */
export const GOOGLE_RELAY_PATH = "/auth/google-desktop";
/** Done-marker path the auth window intercepts (never actually loads). */
export const GOOGLE_RELAY_DONE_PATH = "/auth/google-desktop/done";
/**
 * Both production web deployments (www.lynse.cn / www.lynse.ai) serve the app
 * under the `/app` basePath — the auth window must open the relay page (and
 * the relay page must aim its done marker) through that prefix or nginx 404s
 * the request. Local dev servers mount at the root, where the prefix is
 * simply absent.
 */
export const WEB_DEPLOY_BASE_PATH = "/app";

/**
 * The web origin serving the desktop relay flows, derived from the API host
 * (production CN api.lynse.cn → www.lynse.cn; intl api-en.lynse.ai and the
 * test gateway gapp.lynse.cn → www.lynse.ai; anything else — dev/staging —
 * falls back to the CN site).
 */
export function webOriginForApi(apiBaseUrl: string): string {
  try {
    const host = new URL(apiBaseUrl).hostname;
    if (host === "api-en.lynse.ai" || host === "gapp.lynse.cn") return "https://www.lynse.ai";
  } catch {
    // Malformed base URL: fall through to the CN site.
  }
  return "https://www.lynse.cn";
}

/** One-time nonce binding the relay landing to a specific sign-in attempt. */
export function newGoogleRelayNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The auth window's initial URL: the relay page carrying this attempt's nonce,
 * behind the production web deployments' `/app` basePath (nginx proxies only
 * that prefix).
 */
export function buildGoogleRelayUrl(webOrigin: string, nonce: string): string {
  const url = new URL(`${webOrigin}${WEB_DEPLOY_BASE_PATH}${GOOGLE_RELAY_PATH}`);
  url.searchParams.set("nonce", nonce);
  return url.href;
}

/** One outcome parsed from an intercepted done-marker URL. */
export type GoogleRelayLanding =
  | { kind: "identity"; identityToken: string; nonce: string }
  | { kind: "error"; error: string; nonce: string };

/**
 * Parse an intercepted done-marker URL. Null unless it carries the expected
 * nonce and one of the outcome markers — a replayed or forged landing cannot
 * complete a sign-in it was not minted for.
 */
export function googleRelayLandingFromUrl(
  url: string,
  expectedNonce: string,
): GoogleRelayLanding | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const params = new URLSearchParams(parsed.hash ? parsed.hash.slice(1) : "");
  const query = parsed.searchParams;
  const nonce = params.get("nonce") ?? query.get("nonce") ?? "";
  if (!nonce || nonce !== expectedNonce) return null;
  const identityToken = params.get("identityToken");
  if (identityToken) return { kind: "identity", identityToken, nonce };
  const error = query.get("error");
  if (error) return { kind: "error", error, nonce };
  return null;
}

/**
 * Relay page, step 1: send the auth window through Google's consent page via
 * the Firebase redirect flow (popups stay blocked in WebViews). The nonce
 * does not participate in the Firebase round trip — the caller persists it
 * and echoes it back on the done marker.
 */
export async function startGoogleBrowserRedirect(): Promise<void> {
  if (!firebase) await warmUpGoogleAuth();
  if (!firebase) throw new Error("Google sign-in unavailable");
  await firebase.sdk.signInWithRedirect(firebase.auth, new firebase.sdk.GoogleAuthProvider());
}

/**
 * Relay page, step 2: finish the redirect round trip and yield the Firebase
 * ID token for the done marker (the DESKTOP exchanges it against
 * /api/auth/login — the web page never creates a session of its own).
 * Null when no redirect is pending (fresh page load before the round trip).
 */
export async function completeGoogleBrowserRedirect(): Promise<string | null> {
  if (!firebase) await warmUpGoogleAuth();
  if (!firebase) return null;
  const result = await firebase.sdk.getRedirectResult(firebase.auth);
  if (!result?.user) return null;
  return result.user.getIdToken();
}

/**
 * Finish a redirect sign-in on the page the browser lands back on.
 * Resolves null when no redirect is pending (normal first visit).
 */
export async function completeGoogleRedirect(): Promise<GoogleLoginResult | null> {
  await warmUpGoogleAuth();
  if (!firebase) return null;
  const result = await firebase.sdk.getRedirectResult(firebase.auth);
  if (!result?.user) return null;
  return finishGoogleSignIn(result.user);
}

/**
 * Complete a bind-required Google sign-in after the phone-binding form.
 * (Delegates to the generic third-party bind endpoint with GOOGLE auth.)
 */
export async function completeGoogleLogin(vo: ThirdPartyLoginVo): Promise<AuthSession> {
  return smsSessionFromLogin(vo as AuthLoginVo);
}
