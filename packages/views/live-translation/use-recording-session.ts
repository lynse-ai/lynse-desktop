"use client";

import { useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { useLiveTranslation } from "./use-live-translation";
import { requestRealtimeSession } from "./api";
import type {
  CompletedLiveSession,
  LiveConnectionDescriptor,
  LivePermissionStatus,
  LiveTranslationProviderConfig,
  LiveTranslationSegment,
} from "./types";

export type RecordMode = "record" | "transcribe" | "translate";

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

  // ── local UI state ──
  mode: RecordMode;
  busy: boolean;
  blocked: string | null;
  bookmarked: boolean;

  // ── complete dialog state ──
  /** The most recently completed session (set when stop resolves). */
  completedSession: CompletedLiveSession | null;
  /** Whether the recording-complete dialog is currently visible. */
  showCompleteDialog: boolean;

  // ── view snapshot shortcuts ──
  sessionId: string | undefined;
  elapsedMs: number;
  micLevel: number;
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
  /** Re-point the translation direction (source/target). Applies live via
   *  setMode when a session is running; otherwise stores the intent. */
  setDirection: (source: string, target: string) => Promise<boolean>;
  dismissCompleteDialog: () => void;
}

export function useRecordingSession(): UseRecordingSessionReturn {
  const { t } = useTranslation();
  const { api, view } = useLiveTranslation();

  const [mode, setMode] = useState<RecordMode>("record");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [bookmarked, setBookmarked] = useState(false);
  const [completedSession, setCompletedSession] = useState<CompletedLiveSession | null>(null);
  const [showCompleteDialog, setShowCompleteDialog] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState(view.sourceLanguage ?? "zh");
  const [targetLanguage, setTargetLanguage] = useState(view.targetLanguage ?? "none");

  // ── derived values ──
  const recording = view.state === "recording" || view.state === "paused";
  const paused = view.state === "paused";

  const activeMode: RecordMode = useMemo(() => {
    if (!recording) return mode;
    if (view.targetLanguage === view.sourceLanguage) return "record";
    if (view.targetLanguage === "none") return "transcribe";
    return "translate";
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
  const switchMode = useCallback(async (next: RecordMode, sessionId?: string): Promise<boolean> => {
    if (!api) return false;
    const sid = sessionId ?? view.sessionId;
    if (!sid) return false;
    const sourceLanguage = view.sourceLanguage ?? "zh";

    // Pure recording: detach any cloud connection.
    if (next === "record") {
      await api.setMode({
        sessionId: sid,
        sourceLanguage,
        targetLanguage: sourceLanguage,
        epoch: (view.epoch ?? 0) + 1,
        connections: [],
      });
      setMode("record");
      return true;
    }

    // Transcribe / translate need a provider + credentials.
    const targetLanguage = next === "transcribe" ? "none" : "en";
    try {
      const cfg = await api.getProviderConfig().catch(() => null);
      if (!cfg || !cfg.provider) {
        toast.warning(t("recording_mode.switch_need_provider"));
        return false;
      }
      const credentials = await requestRealtimeSession(
        { sourceLanguage, targetLanguage, sessionId: sid, epoch: (view.epoch ?? 0) + 1 },
        cfg as LiveTranslationProviderConfig,
      );
      await api.setMode({
        sessionId: sid,
        sourceLanguage,
        targetLanguage,
        epoch: credentials.epoch,
        connections: credentials.connections,
      });
      setMode(next);
      return true;
    } catch (error) {
      toast.warning(String(error));
      return false;
    }
  }, [api, view.sessionId, view.sourceLanguage, view.epoch, t]);

  // ── toggle record / stop ----------------------------------------
  const toggleRecording = useCallback(async () => {
    if (!api) {
      toast.error(t("live_translation.start_hint_desktop"));
      return;
    }
    if (recording) {
      setBusy(true);
      try {
        const result = await api.stop();
        setCompletedSession(result);
        setShowCompleteDialog(true);
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
      const perms = await ensurePermissions();
      if (!perms || perms.microphone !== "granted") {
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
      });

      // If the user picked transcribe/translate before starting, attempt to
      // switch immediately; fall back to pure recording on failure.
      if (mode !== "record") {
        const ok = await switchMode(mode, started.sessionId);
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
  }, [api, recording, ensurePermissions, mode, switchMode, t]);

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
            const target = activeMode === "translate" ? "en" : "none";
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
  }, [api, view.sessionId, view.state, view.epoch, view.sourceLanguage, activeMode]);

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
    if (!recording) {
      setSourceLanguage(source);
      setTargetLanguage(target);
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
      setSourceLanguage(source);
      setTargetLanguage(target);
      return true;
    } catch (error) {
      toast.warning(String(error));
      return false;
    }
  }, [api, recording, view.sessionId, view.epoch, t]);

  // ── complete dialog ----------------------------------------------
  const dismissCompleteDialog = useCallback(() => {
    setShowCompleteDialog(false);
  }, []);

  return {
    recording,
    paused,
    activeMode,
    formattedTime,
    mode,
    busy,
    blocked,
    bookmarked,
    completedSession,
    showCompleteDialog,
    sessionId: view.sessionId,
    elapsedMs: view.elapsedMs,
    micLevel: view.micLevel,
    segmentCount: view.segments.filter((s) => !s.echoOf).length,
    recentSegments,
    segments,
    sourceLanguage,
    targetLanguage,
    toggleRecording,
    togglePause,
    selectMode,
    setBookmarked,
    setDirection,
    dismissCompleteDialog,
  };
}
