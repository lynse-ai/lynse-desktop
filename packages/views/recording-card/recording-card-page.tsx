"use client";

import { AuthGate } from "../auth/auth-gate";
import { PostLoginRedirectMarker } from "../auth/post-login-redirect";
import { RecordingCardManager } from "./recording-card-manager";
import { useRecordingCardSession } from "./use-recording-card-session";

/**
 * Standalone (shell-free) web page for managing a recording card over USB.
 * Uses the WebUSB backend. The desktop app renders RecordingCardDesktopPage
 * with the native Rust backend instead (see apps/tauri/src/Dashboard.tsx).
 */
export function RecordingCardPage() {
  return (
    <main className="flex min-h-screen justify-center bg-background px-4 py-10">
      <div className="w-full">
        <PostLoginRedirectMarker />
        <AuthGate>
          <RecordingCardPageContent />
        </AuthGate>
      </div>
    </main>
  );
}

function RecordingCardPageContent() {
  const session = useRecordingCardSession();
  return <RecordingCardManager session={session} />;
}
