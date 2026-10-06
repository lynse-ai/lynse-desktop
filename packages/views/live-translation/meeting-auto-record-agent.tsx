"use client";

/**
 * Headless meeting auto-record agent living in the main window.
 *
 * The Rust detector polls OS audio sessions for whitelisted meeting apps and
 * emits `meeting_started` / `meeting_ended` here. On start the agent runs the
 * same flow as every other recording entry point (permission precheck, then a
 * pure recording session — live transcription stays attachable from the page)
 * and remembers the session it started; when the meeting ends, only that
 * auto-started session is stopped, so manual recordings always outlive it.
 *
 * Recording state remains visible throughout: the float dock flips to its
 * runway pill on content pages and the recording island takes over whenever
 * the main window is hidden — the "silent" in silent auto-start refers to not
 * interrupting the meeting, never to hidden recording.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { featureFlags } from "../feature-flags";
import { findCalendarEventForDetection } from "../connections";
import { useTranslation } from "@lynse/core/i18n/react";
import { useLiveTranslation } from "./use-live-translation";
import {
  decideAutoRecordAction,
  getDesktopMeetingDetectorApi,
  loadMeetingAutoRecordConfig,
  resolveEventAppName,
  toDetectorConfigPayload,
  autoRecordAudioSources,
  type MeetingDetectorEvent,
} from "./meeting-auto-record";

export function MeetingAutoRecordAgent() {
  const { api } = useLiveTranslation();
  const { t } = useTranslation();
  const busyRef = useRef(false);
  const agentStartedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!api) return;
    const detector = getDesktopMeetingDetectorApi();
    if (!detector) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    // Mirror the persisted config into the Rust detector: on every app launch
    // here, and again on every settings change (the settings card pushes too,
    // this only covers the config that exists before this effect runs).
    void detector
      .setConfig(toDetectorConfigPayload(loadMeetingAutoRecordConfig(), (key) => t(key)))
      .then(() => {
        // Warn-level on purpose: installLogger only forwards warn/error to the
        // log file, and "agent mounted + config reached Rust" is the first link
        // in the auto-record chain we need visible there.
        console.warn("[meeting-auto-record] agent ready (config pushed, listening for meetings)");
      })
      .catch((error) => {
        logWarn("failed to push config", error);
      });

    const startAutoRecording = async (event: MeetingDetectorEvent): Promise<string | null> => {
      const current = await api.getState().catch(() => null);
      if (!current || current.sessionId) {
        console.warn(
          `[meeting-auto-record] skip start: session already active (${current?.sessionId ?? "unknown"})`,
        );
        return null;
      }

      const config = loadMeetingAutoRecordConfig();
      const cfg = await api.getProviderConfig().catch(() => null);
      const perms = await api.permissions().catch(() => null);
      if (!perms) {
        console.warn("[meeting-auto-record] skip start: permission query failed");
        return null;
      }
      if (perms.restartRequired) {
        console.warn("[meeting-auto-record] skip start: permission restart required");
        toast.warning(t("auto_record.permission_restart"));
        return null;
      }
      const droppedSystemAudio =
        cfg?.audioSource !== "mic" &&
        perms.systemAudioRequired &&
        perms.systemAudio !== "granted";
      const sources = autoRecordAudioSources(cfg?.audioSource, perms);
      if (!sources) {
        console.warn("[meeting-auto-record] skip start: microphone permission missing");
        toast.warning(t("auto_record.permission_missing_mic"));
        return null;
      }

      const appName = resolveEventAppName(event, config, (key) => t(key));
      const sessionId = crypto.randomUUID();
      await api.start({
        sessionId,
        title: `${t("auto_record.session_title", { app: appName })} · ${new Date(event.detectedAt).toLocaleString()}`,
        sourceLanguage: cfg?.sourceLanguage || "zh",
        targetLanguage: cfg?.sourceLanguage || "zh",
        epoch: 0,
        connections: [],
        audioSources: sources,
      });
      console.warn(
        `[meeting-auto-record] recording started: session=${sessionId} sources=[${sources.join(",")}]`,
      );

      // Calendar attribution (PRD FR-1). Log-only until the backend gains
      // `file.calendar_event_id` — the association has nowhere to be stored
      // yet, and inventing a local one would be a second source of truth.
      if (featureFlags.connections) {
        void findCalendarEventForDetection(Date.parse(event.detectedAt)).then((matched) => {
          if (!matched) return;
          console.warn(
            `[meeting-auto-record] calendar match: event=${matched.id} "${matched.title}" start=${matched.start_time} session=${sessionId}`,
          );
        });
      }
      if (droppedSystemAudio) {
        toast.warning(t("auto_record.permission_missing_system"));
      }
      return sessionId;
    };

    void detector.onEvent((event) => {
      if (busyRef.current) return;
      // Read fresh per event so settings changes apply without remounting.
      const enabled = loadMeetingAutoRecordConfig().enabled;
      busyRef.current = true;
      void (async () => {
        const current = await api.getState().catch(() => null);
        const decision = decideAutoRecordAction({
          event,
          enabled,
          currentSessionId: current?.sessionId ?? null,
          agentStartedSessionId: agentStartedSessionIdRef.current,
        });
        console.warn(
          `[meeting-auto-record] event=${event.type} app=${event.appId ?? "-"} enabled=${enabled} currentSession=${current?.sessionId ?? "-"} agentSession=${agentStartedSessionIdRef.current ?? "-"} action=${decision.action}`,
        );
        if (decision.action === "start") {
          const sessionId = await startAutoRecording(event).catch((error) => {
            logWarn("auto start failed", error);
            return null;
          });
          if (sessionId) agentStartedSessionIdRef.current = sessionId;
        } else if (decision.action === "stop") {
          agentStartedSessionIdRef.current = null;
          // Stop acks immediately; the finished session reaches the
          // completion dialog through the existing `completed` pipeline.
          await api.stop().catch((error) => {
            toast.error(String(error));
          });
        }
      })().finally(() => {
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
    // Deliberately subscribe once per `api` instance; config is re-read per
    // event, so subscribe-once stays correct across settings changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  return null;
}

function logWarn(message: string, error: unknown): void {
  console.warn(`[meeting-auto-record] ${message}:`, error);
}
