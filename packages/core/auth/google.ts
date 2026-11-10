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

/** Firebase web config from build-time env; empty strings when unset. */
function firebaseConfig() {
  const env = (typeof process !== "undefined" && process.env) || {};
  return {
    apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    appId: env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
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

/**
 * Run the Google popup flow and sign in. Resolves `need_bind` (the UI then
 * shows the phone-binding form with `thirdPartyId`) or `signed_in`.
 */
export async function signInWithGoogle(): Promise<GoogleLoginResult | GoogleBindRequired> {
  const [{ initializeApp, getApps }, { getAuth, GoogleAuthProvider, signInWithPopup }] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
  ]);
  const app = getApps()[0] ?? initializeApp(firebaseConfig());
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  const credential = await signInWithPopup(auth, provider);
  const identityToken = await credential.user.getIdToken();
  const vo = await loginByGoogleIdentityToken(identityToken);
  if (needBind(vo)) {
    return { status: "need_bind", thirdPartyId: vo.thirdPartyId ?? "" };
  }
  const session: AuthSession = smsSessionFromLogin(vo as AuthLoginVo);
  return { status: "signed_in", session };
}

/**
 * Complete a bind-required Google sign-in after the phone-binding form.
 * (Delegates to the generic third-party bind endpoint with GOOGLE auth.)
 */
export async function completeGoogleLogin(vo: ThirdPartyLoginVo): Promise<AuthSession> {
  return smsSessionFromLogin(vo as AuthLoginVo);
}
