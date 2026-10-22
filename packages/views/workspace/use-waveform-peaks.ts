"use client";

import { useCallback, useEffect, useState } from "react";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";

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
  loading: boolean;
  retry: () => void;
}

const BAR_COUNT = 96;
const MAX_DECODE_SECONDS = 20 * 60;
const MAX_DECODE_BYTES = 80 * 1024 * 1024;

export function useWaveformPeaks(src: string | null | undefined, recordId?: string | null): WaveformPeaksResult {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const [result, setResult] = useState<{ src: string; recordId?: string | null; attempt: number; peaks: number[]; skipped: boolean; error: boolean } | null>(null);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const controller = new AbortController();
    const finish = (peaks: number[], skipped = false, error = false) => {
      if (!cancelled) setResult({ src, recordId, attempt, peaks, skipped, error });
    };
    void (async () => {
      try {
        const native = getDesktopLiveTranslationApi()?.waveformPeaks;
        if (native && (recordId || /^(local-media:|https?:\/\/local-media\.localhost)/.test(src))) {
          try {
            const data = await native(src, recordId);
            finish(data.peaks);
            return;
          } catch {
            // Imported compressed audio may require the browser decoder.
          }
        }
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        const length = Number(response.headers.get("content-length"));
        if (length > MAX_DECODE_BYTES) { await response.body?.cancel(); finish([], true); return; }
        const blob = await response.blob();
        if (cancelled) return;
        if (blob.size > MAX_DECODE_BYTES) { finish([], true); return; }
        const arrayBuffer = await blob.arrayBuffer();
        if (cancelled) return;
        const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) { finish([], true); return; }
        const context = new AudioContextCtor();
        try {
          const audio = await context.decodeAudioData(arrayBuffer);
          if (cancelled) return;
          if (audio.duration > MAX_DECODE_SECONDS) { finish([], true); return; }
          finish(computePeaks(audio, BAR_COUNT));
        } finally { void context.close(); }
      } catch { finish([], false, true); }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [src, recordId, attempt]);

  // Derive the empty state immediately on a URL/retry change so the previous
  // file's waveform is never rendered while the new request is pending.
  const current = result && result.src === src && result.recordId === recordId && result.attempt === attempt ? result : null;
  return { peaks: current?.peaks ?? [], skipped: current?.skipped ?? false, error: current?.error ?? false,
    loading: !!src && current === null, retry };
}

/** All channels contribute; true silence stays at zero. */
export function computePeaks(buffer: AudioBuffer, bars: number): number[] {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const channel = channels[0];
  if (!channel || bars < 1) return [];
  const samplesPerBar = Math.max(1, Math.floor(channel.length / bars));
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = i * samplesPerBar;
    const end = i === bars - 1 ? channel.length : start + samplesPerBar;
    let peak = 0;
    for (let j = start; j < end; j++) {
      for (const samples of channels) {
        const value = Math.abs(samples[j] ?? 0);
        if (value > peak) peak = value;
      }
    }
    out.push(Math.min(1, peak * 2.2));
  }
  return out;
}
