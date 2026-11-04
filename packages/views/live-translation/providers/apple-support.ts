import { getDesktopLiveTranslationApi } from "../desktop-api";

/** Whether the Apple on-device live ASR (provider "apple") can run here:
 *  macOS 26+ only — the SpeechAnalyzer APIs and their per-locale assets ship
 *  with it. Resolved by Rust (`sw_vers`), cached for the session: the OS
 *  version never changes under a running app. Unknown/unsupported platforms
 *  (web, Windows, older macOS) hide the provider instead of failing at start. */
let cached: boolean | null = null;

export function isAppleLiveAsrSupported(): boolean {
  return cached === true;
}

export async function refreshAppleLiveAsrSupport(): Promise<boolean> {
  if (cached !== null) return cached;
  const api = getDesktopLiveTranslationApi();
  const version = await api?.macosMajorVersion?.().catch(() => null);
  cached = typeof version === "number" && version >= 26;
  return cached;
}
