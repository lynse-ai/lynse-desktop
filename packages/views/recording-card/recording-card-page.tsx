"use client";

import { AuthGate } from "../auth/auth-gate";
import { PostLoginRedirectMarker } from "../auth/post-login-redirect";
import { RecordingCardManager } from "./recording-card-manager";

/**
 * Standalone (shell-free) web page for managing a recording card over USB.
 * The AuthGate renders the login page in place for logged-out visitors, so
 * in-page login channels land back here automatically; the marker parks the
 * path for the WeChat/Apple full-page redirect channels to return to.
 */
export function RecordingCardPage() {
  return (
    <main className="flex min-h-screen justify-center bg-background px-4 py-10">
      <div className="w-full">
        <PostLoginRedirectMarker />
        <AuthGate>
          <RecordingCardManager />
        </AuthGate>
      </div>
    </main>
  );
}
