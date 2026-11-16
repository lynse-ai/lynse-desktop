"use client";

import { useEffect } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { useNavigation } from "../navigation";

/**
 * Post-login redirect handoff for full-page redirect login channels.
 *
 * The AuthGate renders the login page in place, so in-page channels (SMS,
 * email code, Google popup, QR) return to the current URL for free. Two
 * channels leave the document instead: WeChat scan lands on `/auth/wechat`
 * and Apple lands on the dashboard's `web-success-url`. A page that needs
 * the user back after such a login parks its router-relative path in
 * sessionStorage (survives the full-page round trip in the same tab); the
 * landing hooks consume it and navigate there.
 */

const STORAGE_KEY = "lynse_post_login_redirect";

export function setPostLoginRedirect(path: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, path);
  } catch {
    // sessionStorage can be unavailable (private mode quirks); the redirect
    // then simply degrades to the default landing.
  }
}

/** Read and clear the parked path in one step. */
export function consumePostLoginRedirect(): string | null {
  try {
    const path = window.sessionStorage.getItem(STORAGE_KEY);
    window.sessionStorage.removeItem(STORAGE_KEY);
    return path;
  } catch {
    return null;
  }
}

/**
 * Renders nothing. Mounted by standalone pages wrapped in an AuthGate whose
 * after-login URL may differ (redirect channels): while unauthenticated it
 * parks the current router-relative path; once authenticated it clears any
 * leftover marker. The cleanup covers client-side navigation away while
 * still logged out (full-page redirects skip React teardown, which is what
 * keeps the marker alive across the round trip).
 */
export function PostLoginRedirectMarker() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { pathname, searchParams } = useNavigation();
  const search = searchParams.toString();

  useEffect(() => {
    if (isAuthenticated) {
      consumePostLoginRedirect();
      return;
    }
    setPostLoginRedirect(search ? `${pathname}?${search}` : pathname);
    return () => {
      consumePostLoginRedirect();
    };
  }, [isAuthenticated, pathname, search]);

  return null;
}
