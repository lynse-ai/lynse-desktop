"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDesktopInspirationApi } from "./desktop-api";
import type { InspirationVoiceEvent, InspirationVoiceStopResult } from "./types";

export type InspirationVoicePhase =
  | "idle"
  | "connecting"
  | "recording"
  | "stopping";

/**
 * Drives the quick voice-memo capture: start/stop/cancel plus the live level
 * and elapsed time streamed from the Rust side via `inspiration-voice-event`.
 */
export function useInspirationVoice(onError?: (message: string) => void) {
  const [phase, setPhase] = useState<InspirationVoicePhase>("idle");
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const phaseRef = useRef<InspirationVoicePhase>("idle");
  const disposedRef = useRef(false);

  // Read the phase through a function: comparing `phaseRef.current` directly
  // lets TypeScript narrow it to the literal from the last in-scope check,
  // which then rejects later comparisons.
  const getPhase = useCallback(() => phaseRef.current, []);

  const setPhaseSafe = useCallback((next: InspirationVoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const start = useCallback(async () => {
    const api = getDesktopInspirationApi();
    if (!api || getPhase() !== "idle") return;
    setLevel(0);
    setElapsedMs(0);
    setPhaseSafe("connecting");
    try {
      const snapshot = await api.voiceStart();
      // A "ready" event may already have flipped us to recording; only trust
      // the snapshot when we are still in the connecting state.
      if (getPhase() === "connecting" && snapshot.state === "recording") {
        setPhaseSafe("recording");
      }
    } catch (error) {
      setPhaseSafe("idle");
      onError?.(String(error));
    }
  }, [getPhase, onError, setPhaseSafe]);

  /** Stop the capture and hand back the finalized WAV, or null on failure. */
  const stop = useCallback(async (): Promise<InspirationVoiceStopResult | null> => {
    const api = getDesktopInspirationApi();
    if (!api || (getPhase() !== "recording" && getPhase() !== "connecting")) {
      return null;
    }
    setPhaseSafe("stopping");
    try {
      return await api.voiceStop();
    } catch (error) {
      onError?.(String(error));
      return null;
    } finally {
      setPhaseSafe("idle");
      setLevel(0);
    }
  }, [getPhase, onError, setPhaseSafe]);

  /** Abort the capture and discard its audio. */
  const cancel = useCallback(async () => {
    const api = getDesktopInspirationApi();
    const wasActive = getPhase() !== "idle";
    setPhaseSafe("idle");
    setLevel(0);
    setElapsedMs(0);
    if (api && wasActive) {
      try {
        await api.voiceCancel();
      } catch {
        /* the capture is already gone — nothing to surface */
      }
    }
  }, [getPhase, setPhaseSafe]);

  useEffect(() => {
    disposedRef.current = false;
    const api = getDesktopInspirationApi();
    if (!api) return;
    let unlisten: (() => void) | null = null;
    void api.onVoiceEvent((event: InspirationVoiceEvent) => {
      if (disposedRef.current) return;
      if (event.type === "levels") {
        setLevel(event.level);
        setElapsedMs(event.elapsedMs);
      } else if (event.type === "ready") {
        if (getPhase() === "connecting") setPhaseSafe("recording");
      } else if (event.type === "error") {
        onError?.(event.message);
      }
    }).then((fn) => {
      if (disposedRef.current) fn();
      else unlisten = fn;
    });
    return () => {
      disposedRef.current = true;
      unlisten?.();
    };
  }, [getPhase, onError, setPhaseSafe]);

  return { phase, level, elapsedMs, start, stop, cancel };
}

/** `mm:ss` rendering for the memo timer and audio chips. */
export function formatVoiceDuration(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
