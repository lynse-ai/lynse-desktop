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

function errCode(e: unknown): string | null {
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
