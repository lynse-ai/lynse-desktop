"use client";

import { useCallback } from "react";
import { DynamicIsland } from "./dynamic-island";
import { requestRealtimeSession } from "./api";
import { useLiveTranslation } from "./use-live-translation";
import type { LiveConnectionDescriptor } from "./types";

/**
 * Recording-island mini window — the collapsed form of the recording page.
 *
 * Runs in its own always-on-top Tauri window (see `set_recording_island_visible`
 * on the Rust side, which shows it on session start and hides it on stop).
 * The DynamicIsland pill provides the visuals; pause/resume/stop call the
 * same live-translation commands as the main page, so recording keeps full
 * control while the main window is hidden.
 */
export function RecordingIslandWindow() {
  const { api, view } = useLiveTranslation();

  // Mirrors the resume branch of useRecordingSession.togglePause: when the
  // session targets a non-"none" language, re-attach the translation stream
  // (replacing the one dropped by pause). If no provider answers we resume
  // with plain audio capture — the capture sidecar itself never stops.
  const togglePause = useCallback(async () => {
    if (!api || !view.sessionId) return;
    try {
      if (view.state === "paused") {
        const epoch = (view.epoch ?? 0) + 1;
        const target =
          view.targetLanguage && view.targetLanguage !== "none"
            ? view.targetLanguage
            : "none";
        let connections: LiveConnectionDescriptor[] = [];
        if (target !== "none") {
          const config = await api.getProviderConfig().catch(() => null);
          if (config?.provider) {
            connections =
              (await requestRealtimeSession(
                {
                  sourceLanguage: view.sourceLanguage ?? "zh",
                  targetLanguage: target,
                  sessionId: view.sessionId,
                  epoch,
                },
                config,
              ).catch(() => null))?.connections ?? [];
          }
        }
        await api.resume({ sessionId: view.sessionId, epoch, connections });
      } else {
        await api.pause();
      }
    } catch (error) {
      console.error("recording island: pause toggle failed", error);
    }
  }, [api, view.sessionId, view.state, view.epoch, view.sourceLanguage, view.targetLanguage]);

  return (
    <div
      className="flex h-screen w-screen items-start justify-center bg-transparent pt-2"
      data-tauri-drag-region
    >
      <DynamicIsland
        onPause={() => void togglePause()}
        onStop={() => void api?.stop()}
        onExpand={() => void api?.showMainWindow()}
      />
    </div>
  );
}
