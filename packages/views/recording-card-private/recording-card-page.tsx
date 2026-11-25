"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { useTranslation } from "@lynse/core/i18n/react";
import { AuthGate } from "../auth/auth-gate";
import { PostLoginRedirectMarker } from "../auth/post-login-redirect";
import { RecordingCardManager } from "./recording-card-manager";
import { useRecordingCardSession } from "./use-recording-card-session";
import { recordingCardLocales } from "./locales";

/**
 * Standalone (shell-free) web page for managing a recording card over USB.
 * Uses the WebUSB backend. The desktop app renders RecordingCardDesktopPage
 * with the native Rust backend instead (see apps/tauri/src/Dashboard.tsx).
 */
export function RecordingCardPage() {
  const accountId = useAuthStore((state) => state.user?.id);
  const { i18n } = useTranslation();
  const [localesReady, setLocalesReady] = useState(false);
  useEffect(() => {
    for (const [locale, recordingCard] of Object.entries(recordingCardLocales)) {
      i18n.addResourceBundle(locale, "translation", { recordingCard }, true, true);
    }
    setLocalesReady(true);
  }, [i18n]);
  return (
    <main className="flex min-h-screen justify-center bg-background px-4 py-10">
      <div className="w-full">
        <PostLoginRedirectMarker />
        <AuthGate>
          {localesReady && <RecordingCardPageContent key={accountId} />}
        </AuthGate>
      </div>
    </main>
  );
}

function RecordingCardPageContent() {
  const session = useRecordingCardSession();
  return <RecordingCardManager session={session} />;
}
