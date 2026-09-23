"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { initI18n } from "@lynse/core/i18n";
import { useTranslation } from "@lynse/core/i18n/react";
import { DynamicIsland } from "./dynamic-island";
import { IslandTranscriptDrawer } from "./island-transcript-drawer";
import { realtimeEngineLabel, requestRealtimeSession } from "./api";
import { RESOURCES } from "../locales";
import { useLiveTranslation } from "./use-live-translation";
import type { LiveConnectionDescriptor, LiveTranslationTrayAction } from "./types";

/** How long the drawer's collapse animation runs before the window shrinks.
    Matches the closing transition in `IslandTranscriptDrawer` (150ms). */
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
  // The island window renders outside CoreProvider, so bootstrap i18n here.
  // The init must happen during render, before useTranslation() below: a
  // passive effect is too late — the hook resolves no i18next instance on
  // the first render, subscribes to nothing, and never re-renders once init
  // completes (raw keys stay on screen). initI18n is idempotent and reads
  // the persisted locale from localStorage.
  useMemo(() => initI18n({ resources: RESOURCES }), []);
  const { api, view } = useLiveTranslation();
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const closeTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);

  // Point the running session's live cloud connections at `targetLanguage` —
  // "none" attaches pure transcription, a language code attaches translation.
  // Same flow as the recording page's switchMode; audio capture is untouched,
  // so switching is seamless. Missing provider config surfaces a hint toast
  // and the session keeps recording.
  const applyLiveMode = useCallback(
    async (targetLanguage: string) => {
      if (!api || !view.sessionId) return;
      const source = view.sourceLanguage ?? "zh";
      try {
        const cfg = await api.getProviderConfig().catch(() => null);
        if (!cfg || !cfg.activeProvider) {
          toast.warning(t("recording_mode.switch_need_provider"));
          return;
        }
        const epoch = (view.epoch ?? 0) + 1;
        const credentials = await requestRealtimeSession(
          { sourceLanguage: source, targetLanguage, sessionId: view.sessionId, epoch },
          cfg,
        );
        await api.setMode({
          sessionId: view.sessionId,
          sourceLanguage: source,
          targetLanguage,
          epoch: credentials.epoch,
          connections: credentials.connections,
        });
        // Confirm the engine actually attached, read from the connection URL.
        const engineUrl = credentials.connections[0]?.url;
        if (engineUrl) {
          toast(t("live_translation.engine_attached", { engine: realtimeEngineLabel(engineUrl) }));
        }
      } catch (error) {
        toast.warning(String(error));
      }
    },
    [api, view.sessionId, view.epoch, view.sourceLanguage, t],
  );

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
    // Opening the drawer only shows the transcript the session is already
    // producing. Attaching recognition here would silently open a cloud
    // stream the user never asked for — the language picker in the drawer is
    // the explicit way in.
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
          if (config?.activeProvider) {
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

  // Tray transport bridge: the island webview is alive exactly as long as a
  // session is, so it — not the main window's recording page — reliably
  // receives tray pause/stop. (Tray start is handled natively in Rust.)
  // `togglePause` is mirrored through a ref so a single subscription stays
  // mounted for the life of the window while always acting on fresh state.
  const trayActionRef = useRef<(action: LiveTranslationTrayAction) => void>(() => {});
  trayActionRef.current = (action) => {
    if (action === "pause") {
      void togglePause();
    } else if (action === "stop") {
      void api?.stop();
    }
  };
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void api.onTrayAction((action) => trayActionRef.current(action)).then((unsub) => {
      if (disposed) unsub();
      else cleanup = unsub;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
    // Deliberately subscribe once per `api` instance.
     
  }, [api]);

  return (
    <div className="flex h-screen w-screen items-stretch justify-center bg-transparent">
      <DynamicIsland
        drawerOpen={drawerOpen}
        onToggleDrawer={toggleDrawer}
        onDismiss={() => void api?.hideIsland()}
        onPause={() => void togglePause()}
        onStop={() => void api?.stop()}
        onExpand={() => void api?.openRecordingPage()}
      >
        {drawerMounted && (
          <IslandTranscriptDrawer
            closing={!drawerOpen}
            onSelectTargetLanguage={(code) => void applyLiveMode(code)}
          />
        )}
      </DynamicIsland>
    </div>
  );
}
