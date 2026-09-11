"use client";

import type { LocalTranscriptionRecord } from "../workspace/types";

/** Progress streamed from the Rust side while an ffmpeg job runs. */
export interface AudioEditorProgress {
  jobId: number;
  phase: "processing" | "done" | "error";
  detail?: string | null;
}

export interface DesktopAudioEditorApi {
  /** Whether the shared FFmpeg runtime is already resolvable. */
  status: () => Promise<{ ffmpegAvailable: boolean }>;
  /** Download the shared FFmpeg runtime on first use (no-op when present). */
  ensureRuntime: () => Promise<{ ffmpegAvailable: boolean }>;
  /** `source` is a filesystem path or a `local:<uuid>` record id. */
  trim: (source: string, startSec: number, endSec: number, outName?: string) => Promise<LocalTranscriptionRecord>;
  merge: (sources: string[], outName?: string) => Promise<LocalTranscriptionRecord>;
  removeSilence: (
    source: string,
    options?: { thresholdDb?: number; minSilenceSec?: number; paddingSec?: number },
    outName?: string,
  ) => Promise<LocalTranscriptionRecord>;
  enhanceVoice: (source: string, outName?: string) => Promise<LocalTranscriptionRecord>;
  cancel: () => Promise<void>;
  /** Subscribe to `audio-editor-progress` events; returns an unlisten fn. */
  onProgress: (callback: (progress: AudioEditorProgress) => void) => Promise<() => void>;
}

export function getDesktopAudioEditorApi(): DesktopAudioEditorApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { audioEditor?: DesktopAudioEditorApi };
  };
  return desktopWindow.desktopAPI?.audioEditor ?? null;
}
