"use client";

import { RecordingCardManager } from "./recording-card-manager";
import { useRecordingCardSessionDesktop } from "./use-recording-card-session-desktop";

/**
 * In-app device-file-management page (desktop only). Uses the native Rust
 * USB backend; no AuthGate wrapper because the desktop shell already gates
 * at the app root. Reaches here from the sidebar USB icon once the recording
 * card plugin is enabled.
 */
export function RecordingCardDesktopPage() {
  const session = useRecordingCardSessionDesktop();
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* DashboardLayout clips the shell, so this page owns its scroll area.
          Keep the scrollbar at the content edge while centering the content. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          <RecordingCardManager session={session} />
        </div>
      </div>
    </div>
  );
}
