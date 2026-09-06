"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { initI18n } from "@lynse/core/i18n";
import { DynamicIsland } from "./dynamic-island";
import { IslandTranscriptDrawer } from "./island-transcript-drawer";
import { requestRealtimeSession } from "./api";
import { RESOURCES } from "../locales";
import { useLiveTranslation } from "./use-live-translation";
import type { LiveConnectionDescriptor } from "./types";

/** How long the drawer's collapse animation runs before the window shrinks.
    Matches `animate-island-drawer-out` in globals.css. */
const DRAWER_CLOSE_ANIMATION_MS = 150;

/**
 * Recording-island mini window — the collapsed form of the recording page.
 *
 * Runs in its own always-on-top Tauri window (see `set_recording_island_visible`
 * on the Rust side, which shows it on session start and hides it on stop).
 * The DynamicIsland capsule provides the visuals; pause/resume/stop call the
 * same live-translation commands as the main page, so recording keeps full
 * control while the main window is hidden.
 *
 * The capsule is genuinely frosted: Rust installs native vibrancy behind the
 * webview when the window is created. Tapping the captions toggle unfolds a
 * live-transcript drawer — the window itself grows downward
 * (`live_translation_expand_island`) while the drawer slides in.
 */
export function RecordingIslandWindow() {
  const { api, view } = useLiveTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const closeTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);

  // The island window renders outside CoreProvider, so bootstrap i18n here;
  // initI18n is idempotent and reads the persisted locale from localStorage.
  useEffect(() => {
    initI18n({ resources: RESOURCES });
  }, []);

  const collapseDrawer = useCallback(() => {
    setDrawerOpen(false);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setDrawerMounted(false);
      void api?.setIslandExpanded(false).catch(() => {});
    }, DRAWER_CLOSE_ANIMATION_MS);
  }, [api]);

  const toggleDrawer = useCallback(() => {
    if (drawerOpen) {
      collapseDrawer();
      return;
    }
    if (closeTimer.current) clearTimeout(closeTimer.current);
    // Grow the window first so the drawer animates into real space.
    void api?.setIslandExpanded(true).catch(() => {});
    setDrawerMounted(true);
    setDrawerOpen(true);
  }, [api, drawerOpen, collapseDrawer]);

  // Fold the drawer back up when the session winds down.
  useEffect(() => {
    if (view.state === "idle" || view.state === "stopping" || view.state === "failed") {
      collapseDrawer();
    }
  }, [view.state, collapseDrawer]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

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
    <div className="flex h-screen w-screen items-stretch justify-center bg-transparent">
      <DynamicIsland
        drawerOpen={drawerOpen}
        onToggleDrawer={toggleDrawer}
        onDismiss={() => void api?.hideIsland()}
        onPause={() => void togglePause()}
        onStop={() => void api?.stop()}
        onExpand={() => void api?.showMainWindow()}
      >
        {drawerMounted && <IslandTranscriptDrawer closing={!drawerOpen} />}
      </DynamicIsland>
    </div>
  );
}
