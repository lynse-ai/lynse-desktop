import { describe, expect, it } from "vitest";
import { normalizeReleaseNotesLocales, selectReleaseNotes } from "./index";

const notes = { en: "English", "zh-Hans": "简体", "zh-Hant": "繁體", ja: "日本語", ko: "한국어" };

describe("localized release notes", () => {
  it.each([
    ["en-US", "English"], ["zh-CN", "简体"], ["zh-TW", "繁體"],
    ["zh-Hant-HK", "繁體"], ["ja-JP", "日本語"], ["ko-KR", "한국어"],
  ])("selects the application language %s", (language, expected) => {
    expect(selectReleaseNotes("legacy", notes, language)).toBe(expected);
  });

  it("validates untrusted manifest values and never picks an unrelated translation", () => {
    expect(normalizeReleaseNotesLocales({ en: " English ", "zh-CN": "简体", ja: 12, ko: " ", fr: "French" }))
      .toEqual({ en: "English", "zh-Hans": "简体" });
    expect(normalizeReleaseNotesLocales(["invalid"])).toEqual({});
    expect(selectReleaseNotes("legacy", { "zh-Hans": "简体" }, "ja")).toBe("legacy");
    expect(selectReleaseNotes(null, { "zh-Hans": "简体" }, "ja")).toBeNull();
  });

  it("uses English when a translation is unavailable, then the legacy notes field", () => {
    expect(selectReleaseNotes("legacy", notes, "fr-FR")).toBe("English");
    expect(selectReleaseNotes("legacy", { en: "English" }, "ja")).toBe("English");
    expect(selectReleaseNotes(" old release ", null, "zh-CN")).toBe("old release");
    expect(selectReleaseNotes(12, null, "en")).toBeNull();
  });
});
