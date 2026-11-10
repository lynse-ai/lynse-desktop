import { api } from "../api/client";
import type { AuthSession } from "./session";
import { smsSessionFromLogin, type AuthLoginVo } from "./sms";
// Static imports: the popup must open synchronously inside the click handler.
// A dynamic import here would drop the user-gesture context and the browser
// would block the popup (or, with redirect, lose the pending result on the
// handler page). Tree-shaking still keeps only the auth SDK paths we use.
import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth";

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
 * (the firebase module is never imported, so CN builds don't carry it).
 */

export interface GoogleBindRequired {
  status: "need_bind";
  thirdPartyId: string;
}

export interface GoogleLoginResult {
  status: "signed_in";
  session: AuthSession;
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
  return vo.isNeedBind === true || vo.needBind === true;
}

function firebaseAuth() {
  const app = getApps()[0] ?? initializeApp(firebaseConfig());
  return getAuth(app);
}

/**
 * Warm up the Firebase Auth instance before any click. getAuth performs an
 * async IndexedDB persistence handshake on first use; calling it here lets
 * that finish while the page is idle, so signInWithPopup can open the popup
 * synchronously inside the click handler without a popup blocker.
 */
export function warmUpGoogleAuth(): void {
  if (isGoogleConfigured()) void firebaseAuth();
}

/**
 * Run the Google popup flow synchronously inside the click handler (the
 * Firebase SDK is statically imported above, so the browser keeps the
 * user-gesture context). Resolves `need_bind` (the UI shows the binding
 * screen with `thirdPartyId`) or `signed_in`.
 */
export async function signInWithGoogle(): Promise<GoogleLoginResult | GoogleBindRequired> {
  const credential = await signInWithPopup(firebaseAuth(), new GoogleAuthProvider());
  const identityToken = await credential.user.getIdToken();
  const vo = await loginByGoogleIdentityToken(identityToken);
  if (needBind(vo)) {
    return { status: "need_bind", thirdPartyId: vo.thirdPartyId ?? "" };
  }
  return { status: "signed_in", session: smsSessionFromLogin(vo as AuthLoginVo) };
}

/**
 * Complete a bind-required Google sign-in after the phone-binding form.
 * (Delegates to the generic third-party bind endpoint with GOOGLE auth.)
 */
export async function completeGoogleLogin(vo: ThirdPartyLoginVo): Promise<AuthSession> {
  return smsSessionFromLogin(vo as AuthLoginVo);
}
