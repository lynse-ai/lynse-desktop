"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { audioModeSources, requestRealtimeSession } from "./api";
import { useLiveTranslation } from "./use-live-translation";
import type {
  DesktopLiveTranslationApi,
  LivePermissionStatus,
  LiveTranslationProviderConfig,
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

/**
 * Headless tray-action agent living in the main window.
 *
 * The tray menu's "start live recording" item needs a receiver that exists no
 * matter which page is open (or that the window is merely hidden): this
 * component mounts for the whole app lifetime and answers the "start" action
 * with the full frontend flow — permission checks, then a recording session,
 * then an immediate live-transcription attachment (zh → none) so the session
 * is genuinely transcribing, not a bare recording.
 *
 * The trailing "pause"/"stop" actions are consumed by the recording island,
 * which is alive exactly as long as a session is (see `RecordingIslandWindow`).
 */
export function RecordingTrayAgent() {
  const { api } = useLiveTranslation();
  const { t } = useTranslation();
  const busyRef = useRef(false);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    const startLiveTranscription = async () => {
      // A session is already running (or is winding down) — nothing to start.
      const current = await api.getState().catch(() => null);
      if (!current || current.sessionId) return;

      const cfg = await api.getProviderConfig().catch(() => null);
      // Live transcription needs a provider; without one the session would
      // silently degrade into the plain recording the user did not ask for.
      if (!cfg || !cfg.provider) {
        toast.warning(t("recording_mode.switch_need_provider"));
        return;
      }

      const audioSources = audioModeSources(cfg.audioSource);
      const perms = await ensurePermissions(api);
      if (!perms || (audioSources.includes("mic") && perms.microphone !== "granted")) {
        toast.warning(t("live_translation.start_hint_mic"));
        return;
      }
      if (perms.restartRequired) {
        toast.warning(t("live_translation.start_hint_restart"));
        return;
      }

      const sourceLanguage = "zh";
      const sessionId = crypto.randomUUID();
      await api.start({
        sessionId,
        title: `${t("recording_mode.record_title")} ${new Date().toLocaleString()}`,
        sourceLanguage,
        targetLanguage: sourceLanguage,
        epoch: 0,
        connections: [],
        audioSources,
      });

      // Attach live transcription. On failure the session keeps running as a
      // plain recording — the user can still switch modes from the page.
      try {
        const credentials = await requestRealtimeSession(
          { sourceLanguage, targetLanguage: "none", sessionId, epoch: 1 },
          cfg as LiveTranslationProviderConfig,
        );
        await api.setMode({
          sessionId,
          sourceLanguage,
          targetLanguage: "none",
          epoch: credentials.epoch,
          connections: credentials.connections,
        });
      } catch (error) {
        toast.warning(String(error));
      }
    };

    void api.onTrayAction((action) => {
      if (action !== "start" || busyRef.current) return;
      busyRef.current = true;
      void startLiveTranscription().finally(() => {
        busyRef.current = false;
      });
    }).then((unsub) => {
      if (disposed) unsub();
      else cleanup = unsub;
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
    // Deliberately subscribe once per `api` instance; fresh provider config is
    // read per invocation, not captured here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, t]);

  return null;
}
