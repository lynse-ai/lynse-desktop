import type { LiveAudioSource, LiveAudioSourceMode } from "../types";

/** Expand the capture-source mode into the connection source list. Unused
 * sources get no websocket, so a "system"-only session pays for one stream
 * instead of two. */
export function audioModeSources(mode: LiveAudioSourceMode | undefined): LiveAudioSource[] {
  if (mode === "mic") return ["mic"];
  if (mode === "system") return ["system"];
  return ["mic", "system"];
}

/** Human-readable identity of the endpoint a session is actually about to
 * dial: the `model` query parameter when present (Qwen realtime), otherwise
 * the host. Derived from the connection URL itself — never from the saved
 * config — so the confirmation shown to the user is what will really run. */
export function realtimeEngineLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("model") ?? parsed.host;
  } catch {
    return url;
  }
}

/** Clamp the speaker-count setting to the documented range: 2..5, or 0 = off. */
export function normalizeMaxSpeakers(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  const rounded = Math.trunc(value);
  if (rounded < 2) return 0;
  return Math.min(5, rounded);
}
