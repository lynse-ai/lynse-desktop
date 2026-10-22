import type { LiveAudioSource, LiveTranslationSnapshot } from "./types";

export function recordingLevel(view: Pick<LiveTranslationSnapshot, "audioSources" | "micLevel" | "systemLevel" | "recordingLevel">): number {
  if (view.recordingLevel != null) return view.recordingLevel;
  const sources = view.audioSources ?? ["mic", "system"];
  return Math.max(sources.includes("mic") ? view.micLevel : 0, sources.includes("system") ? view.systemLevel : 0);
}

export function sourceMode(sources: readonly LiveAudioSource[]): "mic" | "system" | "both" {
  return sources.length === 2 ? "both" : sources.includes("mic") ? "mic" : "system";
}
