"use client";

/**
 * One-click recording control for the in-app float dock
 * (`RecordingFloatDock`, the circular button / runway bar over content pages).
 *
 * Mirrors the recording page's start flow: pure recording first — no provider
 * or API key required — with live transcription attachable later. Recording
 * runs in the native capture sidecar, so the session keeps running while the
 * user browses anywhere; when the main window is hidden the recording island
 * takes over as the on-screen control surface.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { audioModeSources, requestRealtimeSession } from "./api";
import { useLiveTranslation } from "./use-live-translation";
import type {
  DesktopLiveTranslationApi,
  LiveConnectionDescriptor,
  LivePermissionStatus,
  LiveTranslationProviderConfig,
  LiveTranslationSnapshot,
} from "./types";

async function ensurePermissions(
  api: DesktopLiveTranslationApi,
): Promise<LivePermissionStatus | null> {
  try {
    let perms = await api.permissions();
    if (perms.microphone !== "granted") perms = await api.requestPermission("microphone");
    return perms;
  } catch {
    return null;
  }
}

export function useQuickRecording() {
  const { api, view } = useLiveTranslation();
  const { t } = useTranslation();
  const { push } = useNavigation();
  const busyRef = useRef(false);
  const stoppingRef = useRef(false);
  /** True while a session is live (recording or paused), so the entry can
   * flip between a start and a stop affordance. Only `state` events update
   * it — the high-frequency level/segment streams never re-render callers. */
  const [recording, setRecording] = useState(false);
  /** Mirrors the sidecar's paused flag so the transport can offer 继续/暂停. */
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const applySnapshot = (snapshot: LiveTranslationSnapshot): void => {
      // Same rule as the recording page's Start button: a session that is
      // still winding down ("stopping") counts as active.
      setRecording(snapshot.sessionId != null && snapshot.state !== "stopping");
      setPaused(snapshot.state === "paused");
    };

    void api
      .getState()
      .then((snapshot) => {
        if (!disposed) applySnapshot(snapshot);
      })
      .catch(() => undefined);
    void api
      .onEvent((event) => {
        if (event.type === "state") applySnapshot(event.snapshot);
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [api]);

  const start = useCallback(async (): Promise<boolean> => {
    // Web (no desktop bridge): the recording page doesn't exist — do nothing.
    if (!api || busyRef.current) return false;
    // A previous session is still being finalized in the background (stop
    // acks immediately); refuse a new start until it lands.
    if (view.state === "stopping") return false;
    busyRef.current = true;
    try {
      // A session is already running (or winding down) — just surface it.
      const current = await api.getState().catch(() => null);
      if (current?.sessionId) {
        push("/recording");
        return true;
      }

      const cfg = await api.getProviderConfig().catch(() => null);
      const audioSources = audioModeSources(cfg?.audioSource);
      const perms = await ensurePermissions(api);
      // Microphone permission only matters when the mic is actually captured.
      if (!perms || (audioSources.includes("mic") && perms.microphone !== "granted")) {
        toast.warning(t("live_translation.start_hint_mic"));
        return false;
      }
      if (perms.restartRequired) {
        toast.warning(t("live_translation.start_hint_restart"));
        return false;
      }

      // Start in pure recording mode — no provider or API key required.
      // No navigation here: the float dock stretches into its runway bar
      // first and then lands on the recording page. Recording itself stays
      // decoupled from the page — the island answers while the main window
      // is hidden, so the user can browse anywhere afterwards.
      const sourceLanguage = "zh";
      await api.start({
        sessionId: crypto.randomUUID(),
        title: `${t("recording_mode.record_title")} ${new Date().toLocaleString()}`,
        sourceLanguage,
        targetLanguage: sourceLanguage,
        epoch: 0,
        connections: [],
        audioSources,
      });
      return true;
    } catch (error) {
      // Surface the failure on the recording page, where the full session UI
      // offers retry / diagnostics.
      toast.error(String(error));
      push("/recording");
      return false;
    } finally {
      busyRef.current = false;
    }
  }, [api, t, push, view.state]);

  /** Pause / resume the live session. Resume mirrors the island's
   * `togglePause`: when the session targets a real translation language, the
   * translation stream is re-attached (replacing the one pause dropped); if
   * no provider answers we resume with plain audio capture. */
  const togglePause = useCallback(async () => {
    if (!api || !view.sessionId || busyRef.current) return;
    busyRef.current = true;
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
                config as LiveTranslationProviderConfig,
              ).catch(() => null))?.connections ?? [];
          }
        }
        await api.resume({ sessionId: view.sessionId, epoch, connections });
      } else {
        await api.pause();
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      busyRef.current = false;
    }
  }, [api, view.sessionId, view.state, view.epoch, view.sourceLanguage, view.targetLanguage]);

  /** Stop the live session from outside the recording page. Mirrors the
   *  page's stop contract: the command acks immediately, the Rust side
   *  finalizes in the background, and the finished session reaches the
   *  completion dialog through the `completed` event (routed into the
   *  recording-complete store by the always-mounted tray agent). */
  const stop = useCallback(async (): Promise<void> => {
    if (!api || stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      await api.stop();
    } catch (error) {
      toast.error(String(error));
    } finally {
      stoppingRef.current = false;
    }
  }, [api]);

  /** Desktop-only signal so non-desktop shells can hide the entry. */
  const available = Boolean(api);

  return {
    start,
    stop,
    togglePause,
    recording,
    paused,
    available,
    /** True while a stop has been registered but the background finalization
     *  (sidecar drain + persistence) has not landed yet. */
    stopping: view.state === "stopping",
  };
}
