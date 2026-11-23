import type { LiveTranslationSegment } from "./types";

/** Pure logic for the subtitle overlay: display preferences, the freeze-and-
 *  scroll final selection, and the translation-lag metric. Kept free of
 *  React/Tauri so the rules are unit-testable. */

export type SubtitleDisplayMode = "bilingual" | "translation" | "original";
export type SubtitleFontScale = "s" | "m" | "l";
export type SubtitlePosition = "bottom" | "top";
export type SubtitlePreset = "meeting" | "listen" | "stage";

export interface SubtitlePrefs {
  mode: SubtitleDisplayMode;
  fontScale: SubtitleFontScale;
  position: SubtitlePosition;
  /** Finals kept on screen (1–5); older finals only resurface via history. */
  visibleLines: number;
  preset: SubtitlePreset;
}

export const DEFAULT_SUBTITLE_PREFS: SubtitlePrefs = {
  mode: "bilingual",
  fontScale: "m",
  position: "bottom",
  visibleLines: 3,
  preset: "meeting",
};

const PREFS_KEY = "lynse_live_subtitle_prefs";
const DISPLAY_MODES: SubtitleDisplayMode[] = ["bilingual", "translation", "original"];
const FONT_SCALES: SubtitleFontScale[] = ["s", "m", "l"];
const PRESETS: SubtitlePreset[] = ["meeting", "listen", "stage"];

/** Scenario presets (Timekettle-style): one tap reconfigures mode + density
 *  instead of exposing raw knobs. Stage additionally grows the window via
 *  the desktop bridge. */
export function applySubtitlePreset(preset: SubtitlePreset, prefs: SubtitlePrefs): SubtitlePrefs {
  switch (preset) {
    case "meeting":
      return { ...prefs, preset, mode: "bilingual", fontScale: "m", visibleLines: 3 };
    case "listen":
      return { ...prefs, preset, mode: "translation", fontScale: "l", visibleLines: 2 };
    case "stage":
      return { ...prefs, preset, mode: "translation", fontScale: "l", visibleLines: 1 };
  }
}

export function loadSubtitlePrefs(raw: string | null): SubtitlePrefs {
  if (!raw) return DEFAULT_SUBTITLE_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<SubtitlePrefs>;
    return {
      mode: DISPLAY_MODES.includes(parsed.mode as SubtitleDisplayMode)
        ? (parsed.mode as SubtitleDisplayMode)
        : DEFAULT_SUBTITLE_PREFS.mode,
      fontScale: FONT_SCALES.includes(parsed.fontScale as SubtitleFontScale)
        ? (parsed.fontScale as SubtitleFontScale)
        : DEFAULT_SUBTITLE_PREFS.fontScale,
      position: parsed.position === "top" ? "top" : "bottom",
      visibleLines: Math.min(5, Math.max(1, Number(parsed.visibleLines) || DEFAULT_SUBTITLE_PREFS.visibleLines)),
      preset: PRESETS.includes(parsed.preset as SubtitlePreset)
        ? (parsed.preset as SubtitlePreset)
        : DEFAULT_SUBTITLE_PREFS.preset,
    };
  } catch {
    return DEFAULT_SUBTITLE_PREFS;
  }
}

export function readSubtitlePrefs(): SubtitlePrefs {
  try {
    return loadSubtitlePrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_SUBTITLE_PREFS;
  }
}

export function saveSubtitlePrefs(prefs: SubtitlePrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode) — prefs just stay ephemeral.
  }
}

/** How far translation trails recognition, in recording-timeline ms (both
 *  stamps come from the Rust session clock). Null when either stamp is
 *  missing — inline providers that final both legs together report ~0. */
export function translationLagMs(
  segment: Pick<LiveTranslationSegment, "recognizedFinalAtMs" | "translatedFinalAtMs">,
): number | null {
  if (segment.recognizedFinalAtMs == null || segment.translatedFinalAtMs == null) return null;
  return Math.max(0, segment.translatedFinalAtMs - segment.recognizedFinalAtMs);
}

export interface OverlayFinalClock {
  id: string;
  seenAtMs: number;
}

/** Which finals stay on the bar. The newest `visibleLines` always render;
 *  additionally the single predecessor final is held while younger than
 *  `holdMs` (the "freeze" — a brand-new sentence must not instantly wipe its
 *  predecessor on a 1-line bar). At most one extra line, so rapid speech
 *  never stacks the bar unboundedly. Returns ids oldest→newest. */
export function selectVisibleFinals(
  finals: OverlayFinalClock[],
  visibleLines: number,
  holdMs: number,
  nowMs: number,
): string[] {
  const recent = finals.slice(-Math.max(visibleLines + 1, 6));
  const last = recent.slice(-visibleLines);
  const lastIds = new Set(last.map((item) => item.id));
  const previous = recent[recent.length - visibleLines - 1];
  const frozen =
    previous && !lastIds.has(previous.id) && nowMs - previous.seenAtMs < holdMs ? [previous] : [];
  return [...frozen.map((item) => item.id), ...last.map((item) => item.id)];
}
