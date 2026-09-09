"use client";

import { useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { useLiveTranslation } from "./use-live-translation";
import { audioModeSources, requestRealtimeSession } from "./api";
import type {
  LiveConnectionDescriptor,
  LivePermissionStatus,
  LiveTranslationProviderConfig,
  LiveTranslationSegment,
} from "./types";

export type RecordMode = "record" | "live";

/** Format elapsed ms into `HH:MM:SS` like iOS Voice Memos. */
export function formatTimer(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hh = Math.floor(total / 3600).toString().padStart(2, "0");
  const mm = Math.floor((total % 3600) / 60).toString().padStart(2, "0");
  const ss = (total % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// ───────────────────────────────────────────────────────────────
// Centralised recording session hook.
//
// Owns all mutable state and business logic for the recording page
// so that child components stay pure presentational. The return
// value is a stable object that can be destructured by any number
// of consumers without causing re-renders on unrelated changes.
// ───────────────────────────────────────────────────────────────

export interface UseRecordingSessionReturn {
  // ── derived (stable references via useMemo) ──
  readonly recording: boolean;
  readonly paused: boolean;
  readonly activeMode: RecordMode;
  readonly formattedTime: string;
  /** True while a stop has been registered but the background finalization
   *  (sidecar drain + persistence) has not landed yet. */
  readonly stopping: boolean;

  // ── local UI state ──
  mode: RecordMode;
  busy: boolean;
  blocked: string | null;
  bookmarked: boolean;
  /** Whether live translation (target-language output) is enabled inside live mode. */
  translationEnabled: boolean;

  // ── view snapshot shortcuts ──
  sessionId: string | undefined;
  elapsedMs: number;
  micLevel: number;
  /** When the current session started recording (undefined while idle). */
  startedAt: string | undefined;
  segmentCount: number;
  recentSegments: readonly LiveTranslationSegment[];
  /** Full, de-duplicated transcript (echo segments removed) for the detail view. */
  segments: readonly LiveTranslationSegment[];
  /** Current translation direction, mirrored from the live snapshot when recording. */
  sourceLanguage: string;
  targetLanguage: string;

  // ── actions ──
  toggleRecording: () => Promise<void>;
  togglePause: () => Promise<void>;
  selectMode: (next: RecordMode) => Promise<void>;
  setBookmarked: (v: boolean) => void;
  /** Turn live translation on/off. Applied live via `setMode` while a session runs. */
  setTranslationEnabled: (enabled: boolean) => Promise<void>;
  /** Re-point the translation direction (source/target). Applies live via
   *  setMode when a session is running; otherwise stores the intent. */
  setDirection: (source: string, target: string) => Promise<boolean>;
}

export function useRecordingSession(): UseRecordingSessionReturn {
  const { t } = useTranslation();
  const { api, view } = useLiveTranslation();

  const [mode, setMode] = useState<RecordMode>("record");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [bookmarked, setBookmarked] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState(view.sourceLanguage ?? "zh");
  const [targetLanguage, setTargetLanguage] = useState(
    view.targetLanguage && view.targetLanguage !== "none" ? view.targetLanguage : "en",
  );
  const [translationEnabled, setTranslationFlag] = useState(
    Boolean(view.targetLanguage && view.targetLanguage !== "none"),
  );

  // ── derived values ──
  // Treat any non-idle, non-stopping session as "recording" so the Start button
  // never shows while a session is actually active (e.g. during the brief
  // "connecting" window before the audio sidecar reports "ready"). Otherwise a
  // second Start click would hit the Rust guard and fail with
  // "a live translation session is already active".
  const recording = view.sessionId != null && view.state !== "stopping";
  const paused = view.state === "paused";

  const activeMode: RecordMode = useMemo(() => {
    if (!recording) return mode;
    if (view.targetLanguage === view.sourceLanguage) return "record";
    return "live";
  }, [recording, mode, view.targetLanguage, view.sourceLanguage]);

  const formattedTime = useMemo(() => formatTimer(view.elapsedMs), [view.elapsedMs]);

  const recentSegments = useMemo(
    () =>
      [...view.segments]
        .filter((s) => !s.echoOf)
        .slice(-4)
        .reverse(),
    [view.segments],
  );

  const segments = useMemo(
    () => view.segments.filter((s) => !s.echoOf),
    [view.segments],
  );

  // ── permissions -------------------------------------------------
  const ensurePermissions = useCallback(async (): Promise<LivePermissionStatus | null> => {
    if (!api) return null;
    try {
      let perms = await api.permissions();
      if (perms.microphone !== "granted") perms = await api.requestPermission("microphone");
      return perms;
    } catch {
      return null;
    }
  }, [api]);

  // ── attach / detach transcription or translation live ------------
  const switchMode = useCallback(async (
    next: RecordMode,
    opts?: { sessionId?: string; translation?: boolean },
  ): Promise<boolean> => {
    if (!api) return false;
    const sid = opts?.sessionId ?? view.sessionId;
    if (!sid) return false;
    const source = view.sourceLanguage ?? "zh";

    // Pure recording: detach any cloud connection.
    if (next === "record") {
      await api.setMode({
        sessionId: sid,
        sourceLanguage: source,
        targetLanguage: source,
        epoch: (view.epoch ?? 0) + 1,
        connections: [],
      });
      setMode("record");
      return true;
    }

    // Live mode: transcription is always attached; translation only when the
    // switch is on (target = user-selected language, otherwise none).
    const target = (opts?.translation ?? translationEnabled) ? targetLanguage : "none";
    try {
      const cfg = await api.getProviderConfig().catch(() => null);
      if (!cfg || !cfg.provider) {
        toast.warning(t("recording_mode.switch_need_provider"));
        return false;
      }
      const credentials = await requestRealtimeSession(
        { sourceLanguage: source, targetLanguage: target, sessionId: sid, epoch: (view.epoch ?? 0) + 1 },
        cfg as LiveTranslationProviderConfig,
      );
      await api.setMode({
        sessionId: sid,
        sourceLanguage: source,
        targetLanguage: target,
        epoch: credentials.epoch,
        connections: credentials.connections,
      });
      setMode("live");
      return true;
    } catch (error) {
      toast.warning(String(error));
      return false;
    }
  }, [api, view.sessionId, view.sourceLanguage, view.epoch, translationEnabled, targetLanguage, t]);

  // ── toggle record / stop ----------------------------------------
  const toggleRecording = useCallback(async () => {
    if (!api) {
      toast.error(t("live_translation.start_hint_desktop"));
      return;
    }
    // A stop was registered but the background finalization has not landed —
    // neither start nor a second stop makes sense until it does.
    if (view.state === "stopping") return;
    if (recording) {
      setBusy(true);
      try {
        // Acks immediately: the Rust side drains the sidecar and persists the
        // record in the background. The finished session reaches the
        // completion dialog through the `completed` event (routed into the
        // recording-complete store by the tray agent), so the UI never
        // freezes on the stop click.
        await api.stop();
      } catch (error) {
        toast.error(String(error));
      } finally {
        setBusy(false);
        setMode("record");
      }
      return;
    }

    setBusy(true);
    setBlocked(null);
    try {
      const cfg = await api.getProviderConfig().catch(() => null);
      const audioSources = audioModeSources(cfg?.audioSource);
      const perms = await ensurePermissions();
      // Microphone permission only matters when the mic is actually captured;
      // a system-only session (transcribing a playing video) skips it.
      if (!perms || (audioSources.includes("mic") && perms.microphone !== "granted")) {
        const msg = t("live_translation.start_hint_mic");
        setBlocked(msg);
        toast.warning(msg);
        return;
      }
      if (perms.restartRequired) {
        const msg = t("live_translation.start_hint_restart");
        setBlocked(msg);
        toast.warning(msg);
        return;
      }

      // Start in pure recording mode — no provider or API key required.
      const sourceLanguage = "zh";
      const started = await api.start({
        sessionId: crypto.randomUUID(),
        title: `${t("recording_mode.record_title")} ${new Date().toLocaleString()}`,
        sourceLanguage,
        targetLanguage: sourceLanguage,
        epoch: 0,
        connections: [],
        audioSources,
      });

      // If the user picked live mode before starting, attempt to switch
      // immediately; fall back to pure recording on failure.
      if (mode !== "record") {
        const ok = await switchMode(mode, { sessionId: started.sessionId });
        if (!ok) setMode("record");
      } else {
        setMode("record");
      }
    } catch (error) {
      const msg = String(error);
      setBlocked(msg);
      toast.error(t("live_translation.start_failed"), { description: msg });
    } finally {
      setBusy(false);
    }
  }, [api, recording, ensurePermissions, mode, switchMode, t, view.state]);

  // ── pause / resume ----------------------------------------------
  const togglePause = useCallback(async () => {
    if (!api || !view.sessionId) return;
    setBusy(true);
    try {
      if (view.state === "paused") {
        const epoch = (view.epoch ?? 0) + 1;
        let connections: LiveConnectionDescriptor[] = [];
        if (activeMode !== "record") {
          const cfg = await api.getProviderConfig().catch(() => null);
          if (cfg && cfg.provider) {
            const target = translationEnabled ? targetLanguage : "none";
            connections =
              (await requestRealtimeSession(
                {
                  sourceLanguage: view.sourceLanguage ?? "zh",
                  targetLanguage: target,
                  sessionId: view.sessionId,
                  epoch,
                },
                cfg as LiveTranslationProviderConfig,
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
      setBusy(false);
    }
  }, [api, view.sessionId, view.state, view.epoch, view.sourceLanguage, activeMode, translationEnabled, targetLanguage]);

  // ── mode selector -----------------------------------------------
  const selectMode = useCallback(async (next: RecordMode) => {
    if (!recording) {
      setMode(next);
      return;
    }
    if (next !== activeMode) await switchMode(next);
  }, [recording, activeMode, switchMode]);

  // ── translation direction ---------------------------------------
  const setDirection = useCallback(async (source: string, target: string): Promise<boolean> => {
    if (!api) return false;
    setSourceLanguage(source);
    setTargetLanguage(target);
    setTranslationFlag(target !== "none");
    if (!recording) {
      return true;
    }
    const sid = view.sessionId;
    if (!sid) return false;
    try {
      const cfg = await api.getProviderConfig().catch(() => null);
      if (!cfg || !cfg.provider) {
        toast.warning(t("recording_mode.switch_need_provider"));
        return false;
      }
      const credentials = await requestRealtimeSession(
        { sourceLanguage: source, targetLanguage: target, sessionId: sid, epoch: (view.epoch ?? 0) + 1 },
        cfg as LiveTranslationProviderConfig,
      );
      await api.setMode({
        sessionId: sid,
        sourceLanguage: source,
        targetLanguage: target,
        epoch: credentials.epoch,
        connections: credentials.connections,
      });
      return true;
    } catch (error) {
      toast.warning(String(error));
      return false;
    }
  }, [api, recording, view.sessionId, view.epoch, t]);

  // ── translation switch ------------------------------------------
  const setTranslationEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    setTranslationFlag(enabled);
    // Re-apply live mode with the new target while a session runs; the flag
    // override avoids reading a stale closure inside switchMode.
    if (!recording || activeMode === "record") return;
    await switchMode("live", { translation: enabled });
  }, [recording, activeMode, switchMode]);

  // Tray transport (pause/stop) is consumed by the recording island window,
  // which stays alive exactly as long as a session does — see
  // `RecordingIslandWindow`. Tray start is handled natively in Rust.

  return {
    recording,
    paused,
    activeMode,
    formattedTime,
    stopping: view.state === "stopping",
    mode,
    busy,
    blocked,
    bookmarked,
    translationEnabled,
    sessionId: view.sessionId,
    elapsedMs: view.elapsedMs,
    micLevel: view.micLevel,
    startedAt: view.startedAt,
    segmentCount: view.segments.filter((s) => !s.echoOf).length,
    recentSegments,
    segments,
    sourceLanguage,
    targetLanguage,
    toggleRecording,
    togglePause,
    selectMode,
    setBookmarked,
    setTranslationEnabled,
    setDirection,
  };
}
