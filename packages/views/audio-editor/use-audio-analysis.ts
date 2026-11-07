"use client";

import { useEffect, useState } from "react";
import { getDesktopAudioEditorApi } from "./api";
import { computePeaks, createWaveformDecodeContext } from "../workspace/use-waveform-peaks";

// ───────────────────────────────────────────────────────────────
// Audio analysis for the editor page.
//
// Decodes the audio afresh on entry, natively for cached cloud media when
// FFmpeg is available and otherwise through Web Audio, and derives:
//  · dense peaks (10 bars / second) for the editor waveform,
//  · silence segments ([startSec, endSec]) using an RMS threshold — the
//    same definition of silence the Rust `silenceremove` filter applies,
//    so the highlighted "will be removed" regions match the export.
// ───────────────────────────────────────────────────────────────

export interface SilenceSegment {
  startSec: number;
  endSec: number;
}

export interface AudioAnalysis {
  /** Decoded duration in seconds (0 while loading). */
  durationSec: number;
  /** Peak amplitudes in [0, 1], normally 10 per second of audio. */
  peaks: number[];
  /** Silent spans that `remove_silence` would cut. */
  silenceSegments: SilenceSegment[];
  loading: boolean;
  error: boolean;
  /** Long files are intentionally not decoded (memory). */
  skipped: boolean;
}

const BARS_PER_SEC = 10;
// Keep 10 bars/s for the full 2 h decode window (~72 k floats) so long
// meetings stay dense when the editor zooms in; zoomed-out views bucket
// them down to a fixed display pitch instead.
const MAX_BARS = 72000;
const MAX_DECODE_SECONDS = 2 * 60 * 60;
const MAX_DECODE_BYTES = 400 * 1024 * 1024;

const DEFAULT_THRESHOLD_DB = -35;
const DEFAULT_MIN_SILENCE_SEC = 0.6;
const EMPTY_ANALYSIS: AudioAnalysis = {
  durationSec: 0,
  peaks: [],
  silenceSegments: [],
  loading: false,
  error: false,
  skipped: false,
};
const LOADING_ANALYSIS: AudioAnalysis = { ...EMPTY_ANALYSIS, loading: true };

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** RMS-based silence detection mirroring ffmpeg `silenceremove`. */
function detectSilence(
  channel: Float32Array,
  sampleRate: number,
  thresholdDb: number,
  minSilenceSec: number,
): SilenceSegment[] {
  const threshold = dbToLinear(thresholdDb);
  // Analyze in 50 ms windows — fine enough to align cuts to speech onsets.
  const windowSamples = Math.max(1, Math.floor(sampleRate * 0.05));
  const windows = Math.floor(channel.length / windowSamples);
  const loud: boolean[] = new Array(windows);
  for (let i = 0; i < windows; i++) {
    let sum = 0;
    const start = i * windowSamples;
    for (let j = start; j < start + windowSamples; j++) {
      const sample = channel[j] ?? 0;
      sum += sample * sample;
    }
    loud[i] = Math.sqrt(sum / windowSamples) > threshold;
  }
  const segments: SilenceSegment[] = [];
  let silentStart: number | null = null;
  const windowSec = windowSamples / sampleRate;
  for (let i = 0; i <= windows; i++) {
    const isSilent = i < windows && !loud[i];
    if (isSilent && silentStart === null) {
      silentStart = i * windowSec;
    } else if (!isSilent && silentStart !== null) {
      const endSec = i * windowSec;
      if (endSec - silentStart >= minSilenceSec) {
        segments.push({ startSec: silentStart, endSec });
      }
      silentStart = null;
    }
  }
  return segments;
}

export function useAudioAnalysis(
  src: string | null | undefined,
  options?: { cloudId?: string; attempt?: number; thresholdDb?: number; minSilenceSec?: number },
): AudioAnalysis {
  const cloudId = options?.cloudId;
  const attempt = options?.attempt;
  const [result, setResult] = useState<{
    src: string;
    cloudId?: string;
    attempt?: number;
    analysis: AudioAnalysis;
  } | null>(null);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const controller = new AbortController();
    const finish = (analysis: Partial<Omit<AudioAnalysis, "loading">>) => {
      if (!cancelled) setResult({ src, cloudId, attempt, analysis: { ...EMPTY_ANALYSIS, ...analysis } });
    };

    (async () => {
      try {
        if (cloudId) {
          try {
            const native = await getDesktopAudioEditorApi()?.analyzeCloudAudio?.(cloudId);
            if (cancelled) return;
            if (native) {
              finish(native);
              return;
            }
          } catch {
            if (cancelled) return;
            // Web Audio still works when the editor runtime is absent.
          }
        }
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        if (Number(response.headers.get("content-length")) > MAX_DECODE_BYTES) {
          await response.body?.cancel();
          finish({ skipped: true });
          return;
        }
        const blob = await response.blob();
        if (cancelled) return;
        if (blob.size > MAX_DECODE_BYTES) {
          finish({ skipped: true });
          return;
        }
        const arrayBuffer = await blob.arrayBuffer();
        if (cancelled) return;
        const context = createWaveformDecodeContext(!!cloudId);
        if (!context) {
          finish({ skipped: true });
          return;
        }
        try {
          const audioBuffer = await context.decodeAudioData(arrayBuffer);
          if (cancelled) return;
          if (audioBuffer.duration > MAX_DECODE_SECONDS) {
            finish({ skipped: true });
            return;
          }
          const channel = audioBuffer.getChannelData(0);
          const barCount = Math.min(MAX_BARS, Math.max(1, Math.ceil(audioBuffer.duration * BARS_PER_SEC)));
          const peaks = computePeaks(audioBuffer, barCount);
          const silenceSegments = detectSilence(
            channel,
            audioBuffer.sampleRate,
            options?.thresholdDb ?? DEFAULT_THRESHOLD_DB,
            options?.minSilenceSec ?? DEFAULT_MIN_SILENCE_SEC,
          );
          finish({
            durationSec: audioBuffer.duration,
            peaks,
            silenceSegments,
          });
        } finally {
          if ("close" in context) void context.close();
        }
      } catch (error) {
        if (!cancelled) {
          // installLogger routes console.warn into the app log file, so a
          // user report of "waveform unavailable" carries the actual cause.
          console.warn("[audio-editor] waveform load failed", error);
          finish({ error: true });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Threshold tweaks shouldn't re-decode the audio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, cloudId, attempt]);

  // Keep the loading surface on screen until the current source has a result.
  if (!src) return EMPTY_ANALYSIS;
  if (result?.src === src && result.cloudId === cloudId && result.attempt === attempt) return result.analysis;
  return LOADING_ANALYSIS;
}
