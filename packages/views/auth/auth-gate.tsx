"use client";

import type { ReactNode } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { LoginPage } from "./login-page";
import { LYNSE_LOGO_SRC } from "./lynse-logo";

/**
 * Startup authentication gate: while the session is being restored show a
 * splash; when there is no session show the login page; otherwise render the
 * app. Used by both app shells (web dashboard layout + desktop App).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (isLoading) {
    // Branded splash matching the login page's logo placement, so the cold
    // start reads as the product loading rather than a stalled blank page.
    return (
      <main className="flex min-h-screen flex-col items-center bg-background">
        <img
          src={LYNSE_LOGO_SRC}
          alt="Lynse"
          className="mt-[15vh] h-10 w-auto animate-pulse dark:invert"
        />
      </main>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <>{children}</>;
}
