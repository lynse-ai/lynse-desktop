"use client";

import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { getDesktopAppApi } from "../app-update";
import { LoginPage } from "./login-page";
import { LYNSE_SPLASH_SRC } from "./splash-image";

/**
 * Startup authentication gate: while the session is being restored show a
 * splash; when there is no session show the login page; otherwise render the
 * app. Used by both app shells (web dashboard layout + desktop App).
 *
 * On desktop the window shape follows the auth state: the pre-auth faces
 * (splash + login) render inside the compact welcome window (690×450), and
 * signing in grows the same window into the dashboard size (960×600) — the
 * packaged default is already compact, so cold start never resizes. Sign-out
 * shrinks it back. No-op on the web (the API getter returns null).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // Splash counts as compact: the window is born that size, and flipping it
  // to dashboard-sized for a one-frame splash would visibly jump.
  useEffect(() => {
    if (!isLoading) {
      void getDesktopAppApi()?.setCompactWindowSize(!isAuthenticated);
    }
  }, [isLoading, isAuthenticated]);

  if (isLoading) {
    // Full-bleed launch artwork (profile breathing a waveform into an
    // orbital constellation against a dark planet arc) so the cold start
    // reads as the product, not a stalled blank page. No branding is baked
    // into this variant — the brief loading face stays pure artwork.
    return (
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#050505]">
        <img
          src={LYNSE_SPLASH_SRC}
          alt="Lynse · 灵光记"
          className="absolute inset-0 h-full w-full select-none object-cover"
          draggable={false}
        />
      </main>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <>{children}</>;
}
