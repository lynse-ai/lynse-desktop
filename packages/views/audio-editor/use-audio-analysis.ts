"use client";

import { useEffect, useState } from "react";

// ───────────────────────────────────────────────────────────────
// Audio analysis for the editor page.
//
// Fetches the audio at `src` once, decodes it with Web Audio, and derives:
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
  /** Peak amplitudes in [0.05, 1], 10 per second of audio. */
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
  options?: { thresholdDb?: number; minSilenceSec?: number },
): AudioAnalysis {
  const [analysis, setAnalysis] = useState<AudioAnalysis>({
    durationSec: 0,
    peaks: [],
    silenceSegments: [],
    loading: !!src,
    error: false,
    skipped: false,
  });

  useEffect(() => {
    if (!src) {
      setAnalysis({ durationSec: 0, peaks: [], silenceSegments: [], loading: false, error: false, skipped: false });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setAnalysis((prev) => ({ ...prev, loading: true, error: false, skipped: false }));

    (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        if (blob.size > MAX_DECODE_BYTES) {
          setAnalysis({ durationSec: 0, peaks: [], silenceSegments: [], loading: false, error: false, skipped: true });
          return;
        }
        const arrayBuffer = await blob.arrayBuffer();
        if (cancelled) return;
        const AudioContextCtor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) {
          setAnalysis({ durationSec: 0, peaks: [], silenceSegments: [], loading: false, error: false, skipped: true });
          return;
        }
        const context = new AudioContextCtor();
        try {
          const audioBuffer = await context.decodeAudioData(arrayBuffer);
          if (cancelled) return;
          if (audioBuffer.duration > MAX_DECODE_SECONDS) {
            setAnalysis({ durationSec: 0, peaks: [], silenceSegments: [], loading: false, error: false, skipped: true });
            return;
          }
          const channel = audioBuffer.getChannelData(0);
          const barCount = Math.min(MAX_BARS, Math.max(1, Math.ceil(audioBuffer.duration * BARS_PER_SEC)));
          const samplesPerBar = Math.max(1, Math.floor(channel.length / barCount));
          const peaks: number[] = [];
          for (let i = 0; i < barCount; i++) {
            const start = i * samplesPerBar;
            const end = i === barCount - 1 ? channel.length : start + samplesPerBar;
            let peak = 0;
            for (let j = start; j < end; j++) {
              const value = Math.abs(channel[j] ?? 0);
              if (value > peak) peak = value;
            }
            peaks.push(Math.min(1, Math.max(0.05, peak * 2.2)));
          }
          const silenceSegments = detectSilence(
            channel,
            audioBuffer.sampleRate,
            options?.thresholdDb ?? DEFAULT_THRESHOLD_DB,
            options?.minSilenceSec ?? DEFAULT_MIN_SILENCE_SEC,
          );
          setAnalysis({
            durationSec: audioBuffer.duration,
            peaks,
            silenceSegments,
            loading: false,
            error: false,
            skipped: false,
          });
        } finally {
          void context.close();
        }
      } catch (error) {
        if (!cancelled) {
          // installLogger routes console.warn into the app log file, so a
          // user report of "waveform unavailable" carries the actual cause.
          console.warn("[audio-editor] waveform load failed", error);
          setAnalysis({ durationSec: 0, peaks: [], silenceSegments: [], loading: false, error: true, skipped: false });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Re-run only when the source changes; threshold tweaks shouldn't re-decode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return analysis;
}
