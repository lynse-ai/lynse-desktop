"use client";

import type { ReactNode } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { Loader2 } from "../icons";
import { LoginPage } from "./login-page";

/**
 * Startup authentication gate: while the session is being restored show a
 * splash; when there is no session show the login page; otherwise render the
 * app. Used by both app shells (web dashboard layout + desktop App).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <>{children}</>;
}
