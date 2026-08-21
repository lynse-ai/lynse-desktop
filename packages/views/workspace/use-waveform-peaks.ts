"use client";

import { useEffect, useState } from "react";

// ───────────────────────────────────────────────────────────────
// Waveform peak extraction.
//
// Fetches the audio at `src`, decodes it with Web Audio and reduces the
// first channel to a fixed number of peak bars (0..1) that the shared
// `Waveform` component can render — the ElevenLabs UI "waveform + scrub"
// pattern, self-contained (no extra dependency).
//
// Long files are skipped (decode of a full meeting WAV would eat hundreds
// of MB of floats), in which case callers fall back to a plain progress
// bar. Failures are reported as `error` so the UI degrades gracefully.
// ───────────────────────────────────────────────────────────────

export interface WaveformPeaksResult {
  /** Peak amplitudes per bar, in [0.05, 1]. Empty while loading / on failure. */
  peaks: number[];
  /** True when decoding was intentionally skipped (file too long / large). */
  skipped: boolean;
  /** True when fetch or decode failed (e.g. CORS on a remote URL). */
  error: boolean;
}

const BAR_COUNT = 96;
const MAX_DECODE_SECONDS = 20 * 60;
const MAX_DECODE_BYTES = 80 * 1024 * 1024;

export function useWaveformPeaks(src: string | null | undefined): WaveformPeaksResult {
  const [peaks, setPeaks] = useState<number[]>([]);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        if (blob.size > MAX_DECODE_BYTES) {
          setSkipped(true);
          return;
        }
        const arrayBuffer = await blob.arrayBuffer();
        if (cancelled) return;

        const AudioContextCtor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) {
          setSkipped(true);
          return;
        }
        const context = new AudioContextCtor();
        try {
          const audioBuffer = await context.decodeAudioData(arrayBuffer);
          if (cancelled) return;
          if (audioBuffer.duration > MAX_DECODE_SECONDS) {
            setSkipped(true);
            return;
          }
          setPeaks(computePeaks(audioBuffer, BAR_COUNT));
        } finally {
          void context.close();
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [src]);

  return { peaks, skipped, error };
}

/** Reduce the first channel to `bars` peak amplitudes in [0.05, 1]. */
function computePeaks(buffer: AudioBuffer, bars: number): number[] {
  const channel = buffer.getChannelData(0);
  const samplesPerBar = Math.max(1, Math.floor(channel.length / bars));
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = i * samplesPerBar;
    const end = i === bars - 1 ? channel.length : start + samplesPerBar;
    let peak = 0;
    for (let j = start; j < end; j++) {
      const value = Math.abs(channel[j] ?? 0);
      if (value > peak) peak = value;
    }
    // Boost quiet speech so the waveform reads clearly, keep a floor so
    // silence still renders as a subtle baseline instead of gaps.
    out.push(Math.min(1, Math.max(0.05, peak * 2.2)));
  }
  return out;
}
