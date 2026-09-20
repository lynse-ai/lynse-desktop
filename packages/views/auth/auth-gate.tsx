"use client";

import type { ReactNode } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { LoginPage } from "./login-page";
import { LYNSE_SPLASH_SRC } from "./splash-image";

/**
 * Startup authentication gate: while the session is being restored show a
 * splash; when there is no session show the login page; otherwise render the
 * app. Used by both app shells (web dashboard layout + desktop App).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (isLoading) {
    // Full-bleed launch artwork ("MAKE IT LAST." — waveform breathing into
    // the Lynse mark) so the cold start reads as the product, not a stalled
    // blank page. Branding lives inside the image, bottom-right.
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
