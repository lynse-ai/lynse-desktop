import { describe, expect, it } from "vitest";
import {
  applySubtitlePreset,
  DEFAULT_SUBTITLE_PREFS,
  loadSubtitlePrefs,
  selectVisibleFinals,
  translationLagMs,
} from "./overlay-logic";

describe("loadSubtitlePrefs", () => {
  it("falls back to defaults on null or corrupt storage", () => {
    expect(loadSubtitlePrefs(null)).toEqual(DEFAULT_SUBTITLE_PREFS);
    expect(loadSubtitlePrefs("not json {")).toEqual(DEFAULT_SUBTITLE_PREFS);
  });

  it("clamps out-of-range and unknown values instead of rejecting", () => {
    const prefs = loadSubtitlePrefs(
      JSON.stringify({ mode: "weird", fontScale: "xxl", position: "sideways", visibleLines: 99 }),
    );
    expect(prefs.mode).toBe(DEFAULT_SUBTITLE_PREFS.mode);
    expect(prefs.fontScale).toBe(DEFAULT_SUBTITLE_PREFS.fontScale);
    expect(prefs.position).toBe("bottom");
    expect(prefs.visibleLines).toBe(5);
  });

  it("keeps a valid persisted blob", () => {
    const prefs = loadSubtitlePrefs(
      JSON.stringify({ mode: "translation", fontScale: "l", position: "top", visibleLines: 2, preset: "stage" }),
    );
    expect(prefs).toEqual({ mode: "translation", fontScale: "l", position: "top", visibleLines: 2, preset: "stage" });
  });
});

describe("applySubtitlePreset", () => {
  it("configures meeting as bilingual, medium, 3 lines", () => {
    const prefs = applySubtitlePreset("meeting", { ...DEFAULT_SUBTITLE_PREFS, mode: "translation", visibleLines: 1 });
    expect(prefs).toMatchObject({ preset: "meeting", mode: "bilingual", fontScale: "m", visibleLines: 3 });
  });

  it("configures listen and stage as translation-only with progressively fewer lines", () => {
    expect(applySubtitlePreset("listen", DEFAULT_SUBTITLE_PREFS)).toMatchObject({
      preset: "listen", mode: "translation", fontScale: "l", visibleLines: 2,
    });
    expect(applySubtitlePreset("stage", DEFAULT_SUBTITLE_PREFS)).toMatchObject({
      preset: "stage", mode: "translation", fontScale: "l", visibleLines: 1,
    });
  });
});

describe("selectVisibleFinals", () => {
  const finals = [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, seenAtMs: n * 1000 }));

  it("shows the newest N finals", () => {
    expect(selectVisibleFinals(finals, 2, 2500, 999_999)).toEqual(["s4", "s5"]);
    expect(selectVisibleFinals(finals, 1, 2500, 999_999)).toEqual(["s5"]);
  });

  it("holds a fresh final on a 1-line bar until the freeze expires", () => {
    // s5 just arrived (0 ms ago) while s4 is still inside the 2.5 s hold —
    // the bar must run one line longer instead of instantly wiping s4.
    expect(selectVisibleFinals(finals, 1, 2500, 5_000)).toEqual(["s4", "s5"]);
    // Once the hold lapses, only the newest line stays.
    expect(selectVisibleFinals(finals, 1, 2500, 5_000 + 2500)).toEqual(["s5"]);
  });
});

describe("translationLagMs", () => {
  it("measures the gap between recognition and translation finals", () => {
    expect(translationLagMs({ recognizedFinalAtMs: 10_000, translatedFinalAtMs: 11_800 })).toBe(1800);
  });

  it("is null until both stamps exist and never goes negative", () => {
    expect(translationLagMs({})).toBeNull();
    expect(translationLagMs({ recognizedFinalAtMs: 5_000 })).toBeNull();
    expect(translationLagMs({ recognizedFinalAtMs: 10_000, translatedFinalAtMs: 9_000 })).toBe(0);
  });
});
