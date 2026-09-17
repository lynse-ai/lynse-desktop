import type { DesktopLiveTranslationApi, LiveStartRequest } from "./types";
import { usePendingRecordingStore } from "./pending-recording-store";
import { readRecordingDeviceSelection } from "./recording-devices";

/** Merge the persisted device selection into a start request. Explicit ids
 * on the request win; otherwise the persisted pick applies; otherwise the OS
 * defaults are followed. Runs at the single choke point every start entry
 * point (page, tray, quick recording, meeting auto-record) goes through. */
function withDeviceSelection(args: LiveStartRequest): LiveStartRequest {
  const selection = readRecordingDeviceSelection();
  return {
    ...args,
    micDeviceId: args.micDeviceId ?? selection.micDeviceId,
    systemDeviceId: args.systemDeviceId ?? selection.systemDeviceId,
  };
}

/**
 * Wrap the raw bridge api so every recording start/stop entry point (pages,
 * tray, quick recording, meeting auto-record) feeds the pending-recording
 * store: the notes list shows an optimistic card from start until the
 * persisted record replaces it.
 */
function withPendingRecording(api: DesktopLiveTranslationApi): DesktopLiveTranslationApi {
  const wrapped: DesktopLiveTranslationApi = {
    ...api,
    async start(args) {
      const result = await api.start(withDeviceSelection(args));
      usePendingRecordingStore.getState().add({
        sessionId: args.sessionId,
        title: args.title,
        startedAt: new Date().toISOString(),
        phase: "recording",
      });
      return result;
    },
    async stop() {
      // The stop command acks instantly and persists in the background; flip
      // any live card to its saving state now. Sessions stopped from the
      // island window (a separate webview) skip this — the `completed`
      // handler removes the card by session id regardless of phase.
      const { pending, markSaving } = usePendingRecordingStore.getState();
      for (const entry of pending) {
        if (entry.phase === "recording") markSaving(entry.sessionId);
      }
      return api.stop();
    },
  };
  return wrapped;
}

const wrappedApiCache = new WeakMap<DesktopLiveTranslationApi, DesktopLiveTranslationApi>();

export function getDesktopLiveTranslationApi(): DesktopLiveTranslationApi | null {
  if (typeof window === "undefined") return null;
  const raw = (window as Window & {
    desktopAPI?: { liveTranslation?: DesktopLiveTranslationApi };
  }).desktopAPI?.liveTranslation;
  if (!raw) return null;
  let wrapped = wrappedApiCache.get(raw);
  if (!wrapped) {
    wrapped = withPendingRecording(raw);
    wrappedApiCache.set(raw, wrapped);
  }
  return wrapped;
}
