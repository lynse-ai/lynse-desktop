"use client";

import { useEffect, useRef, useState } from "react";
import {
  GOOGLE_RELAY_DONE_PATH,
  GOOGLE_RELAY_PATH,
  completeGoogleBrowserRedirect,
  errCode,
  isGoogleConfigured,
  startGoogleBrowserRedirect,
} from "@lynse/core/auth/google";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";

type RelayPhase = "starting" | "completing" | "failed";

/**
 * LocalStorage backup for the relay nonce. The Firebase redirect round trip
 * returns to this page through the SDK's handler; whether the original query
 * string survives that round trip is an SDK detail, so the nonce rides in
 * localStorage (same origin, same browser session) as the reliable source —
 * the query copy is only a same-load convenience.
 */
const NONCE_STORAGE_KEY = "lynse_google_desktop_relay_nonce";

function readNonce(): string | null {
  const query = new URLSearchParams(window.location.search).get("nonce");
  if (query) return query;
  try {
    return window.localStorage.getItem(NONCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parkNonce(nonce: string): void {
  try {
    window.localStorage.setItem(NONCE_STORAGE_KEY, nonce);
  } catch {
    // Storage unavailable: the query-string nonce still covers the
    // same-load case; nothing else to do.
  }
}

/**
 * Google sign-in relay page for the desktop's standalone auth window
 * (`<web origin>/auth/google-desktop?nonce=…`).
 *
 * Google refuses OAuth inside embedded WebViews, so the desktop cannot run
 * the popup flow — instead this page runs the Firebase REDIRECT round trip
 * inside the desktop's auth window: sign-in state through accounts.google.com
 * and back, then hand the resulting Firebase ID token to the desktop by
 * navigating to the done-marker URL the window intercepts
 * (`/auth/google-desktop/done#identityToken=…&nonce=…`). The DESKTOP
 * exchanges the token against /api/auth/login — this page never creates a
 * web session, so a visit without a `nonce` (plain web traffic) is inert.
 */
export function GoogleDesktopRelay() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<RelayPhase>("completing");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Mount replay (StrictMode) must not restart the redirect twice.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const nonce = readNonce();
    // Desktop-less visits carry no nonce: nothing to relay, stay inert.
    if (!nonce) {
      setPhase("failed");
      setErrorDetail("missing nonce");
      return;
    }
    parkNonce(nonce);

    if (!isGoogleConfigured()) {
      // Deployment misconfiguration — surface it inside the window instead
      // of navigating the desktop to a failure marker it cannot act on.
      setPhase("failed");
      setErrorDetail("firebase config missing");
      return;
    }

    const finish = (identityToken: string | null, error: string | null) => {
      // Contract match for the auth window's interceptor: the nonce rides the
      // query, the identity token stays in the FRAGMENT (never sent to any
      // server), errors ride the query. The deployment prefix (production
      // sites serve the app under /app) is reproduced from this page's own
      // pathname, so the marker stays on a routed URL whatever the prefix is.
      const prefix = window.location.pathname.slice(
        0,
        -GOOGLE_RELAY_PATH.length,
      );
      const done = `${window.location.origin}${prefix}${GOOGLE_RELAY_DONE_PATH}`;
      if (identityToken) {
        window.location.assign(
          `${done}?nonce=${encodeURIComponent(nonce)}#identityToken=${encodeURIComponent(identityToken)}`,
        );
        return;
      }
      const params = new URLSearchParams({ nonce, error: error ?? "unknown" });
      window.location.assign(`${done}?${params.toString()}`);
    };

    // A pending redirect result means the Google round trip just came back;
    // otherwise start it (the page navigates away to Google).
    completeGoogleBrowserRedirect()
      .then((identityToken) => {
        if (identityToken) {
          finish(identityToken, null);
          return;
        }
        setPhase("starting");
        startGoogleBrowserRedirect()
          .then(() => setPhase("completing"))
          .catch((e: unknown) => {
            setPhase("failed");
            setErrorDetail(errCode(e) ?? String(e));
            finish(null, errCode(e) ?? "google_relay_failed");
          });
      })
      .catch((e: unknown) => {
        setPhase("failed");
        setErrorDetail(errCode(e) ?? String(e));
        finish(null, errCode(e) ?? "google_relay_failed");
      });
  }, []);

  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-foreground">
      {phase === "failed" ? (
        <>
          <p className="text-sm text-destructive">{t("auth.login_failed")}</p>
          {errorDetail && (
            <p className="max-w-xs text-center font-mono text-2xs leading-relaxed text-muted-foreground">
              {errorDetail}
            </p>
          )}
        </>
      ) : (
        <>
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("auth.google_waiting")}</p>
        </>
      )}
    </main>
  );
}
