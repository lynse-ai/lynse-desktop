"use client";

import { useEffect } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { sessionFromAppleFragment } from "@lynse/core/auth/apple";

/**
 * Apple web login success landing: the backend 302s to web-success-url with
 * the session in the URL fragment (`#token=…&expireIn=…`). Fragments never
 * reach any server, so the client parses them here — before AuthGate can
 * bounce an unauthenticated visitor back to the login page — signs in, and
 * scrubs the token out of the address bar history.
 */
export function AppleFragmentBootstrap() {
  const completeLogin = useAuthStore((s) => s.completeLogin);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash.includes("token=")) return;
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get("token");
    if (!token) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    completeLogin(sessionFromAppleFragment(token));
  }, [completeLogin]);
  return null;
}
