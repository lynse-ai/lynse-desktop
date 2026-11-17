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
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <RecordingCardManager session={session} />
    </div>
  );
}
