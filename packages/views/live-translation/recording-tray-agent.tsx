"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { audioModeSources, requestRealtimeSession } from "./api";
import { useLiveTranslation } from "./use-live-translation";
import { useRecordingCompleteStore } from "./recording-complete-store";
import {
  refreshUntilRecordingVisible,
  usePendingRecordingStore,
} from "./pending-recording-store";
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
  const { push } = useNavigation();
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
      // Land on the recording page like every other start entry point. When
      // the main window is hidden this is a no-op on screen (the webview
      // navigates while hidden); restoring the window then shows the session.
      push("/recording");

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
    // read per invocation, not captured here. `push` may be stale between
    // renders but only wraps the stable pathname setter, so subscribe-once is
    // still correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, t]);

  // The stop command acks immediately and finalizes in the background, so a
  // stop can originate anywhere (page, float dock, island, tray) while the
  // user is on any page. This always-mounted listener is what turns the
  // resulting `completed` event into the completion dialog: the session is
  // parked in the hand-off store and the recording page picks it up (now or
  // on its next visit). It also retires the optimistic pending card and
  // refreshes the notes lists until the persisted record shows up.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void api
      .onEvent((event) => {
        if (event.type === "completed") {
          usePendingRecordingStore.getState().remove(event.session.sessionId);
          void refreshUntilRecordingVisible(queryClient, event.session.sessionId);
          useRecordingCompleteStore.getState().open(event.session);
        } else if (event.type === "error") {
          // Persist failures arrive as session-less errors after the stop
          // ack; drop the card that was promising the save. Errors while a
          // session is still recording keep the card.
          const { pending, remove } = usePendingRecordingStore.getState();
          for (const entry of pending) {
            if (entry.phase === "saving") remove(entry.sessionId);
          }
        }
      })
      .then((unsub) => {
        if (disposed) unsub();
        else cleanup = unsub;
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [api, queryClient]);

  return null;
}
