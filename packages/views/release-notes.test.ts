import { describe, expect, it } from "vitest";
import { parseReleaseNotes } from "./release-notes";

describe("authored release notes", () => {
  it("groups authored categories in a stable order and counts displayed items", () => {
    const parsed = parseReleaseNotes("### Fixes\n- Kept the draft.\n\n### New features\n- Added chapters.\n- Added on-device recognition.\n\n### Improvements\n- Clearer timestamps.");
    expect(parsed.sections.map((section) => [section.category, section.items.length]))
      .toEqual([["features", 2], ["improvements", 1], ["fixes", 1]]);
    expect(parsed.count).toBe(4);
  });

  it("supports existing plain-text bullets and preserves wrapped lines and introductions", () => {
    const parsed = parseReleaseNotes("A quieter update.\r\n\r\n更新内容\r\n\r\n• 第一项\r\n  继续说明。\r\n2. 第二项");
    expect(parsed.paragraphs).toEqual(["A quieter update."]);
    expect(parsed.sections).toMatchObject([{ category: "changes", items: ["第一项 继续说明。", "第二项"] }]);
    expect(parsed.count).toBe(2);
  });

  it.each([
    ["新功能", "改进", "错误修复"],
    ["新功能", "改進", "錯誤修復"],
    ["新機能", "改善", "不具合修正"],
    ["새 기능", "개선", "오류 수정"],
  ])("recognizes the authored locale headings %s", (features, improvements, fixes) => {
    const parsed = parseReleaseNotes(`### ${features}\n- A\n### ${improvements}\n- B\n### ${fixes}\n- C`);
    expect(parsed.sections.map((section) => section.category)).toEqual(["features", "improvements", "fixes"]);
  });

  it("folds legacy Changed/Bug Fixes/Performance headings into the three authored groups", () => {
    const parsed = parseReleaseNotes(
      "### New Features\n- A\n\n### Changed\n- B\n\n### Bug Fixes\n- C\n\n### Performance\n- D\n\n### 变更\n- E",
    );
    // Sections split per heading language; category order ranks ahead of language.
    expect(parsed.sections.map((section) => [section.category, section.items, section.lang]))
      .toEqual([["features", ["A"], "en"], ["improvements", ["B", "D"], "en"], ["improvements", ["E"], "zh"], ["fixes", ["C"], "en"]]);
  });

  it("renders a single language when one is requested, falling back to English", () => {
    const notes = "### New Features\n- English feature.\n\n### Improvements\n- English improvement.\n\n### 新功能\n- 中文功能。\n\n### 改进\n- 中文改进。";
    const zh = parseReleaseNotes(notes, { language: "zh" });
    expect(zh.sections.map((section) => section.items)).toEqual([["中文功能。"], ["中文改进。"]]);
    expect(zh.count).toBe(2);
    const en = parseReleaseNotes(notes, { language: "en" });
    expect(en.sections.map((section) => section.items)).toEqual([["English feature."], ["English improvement."]]);
    // No Japanese content authored: English variant renders instead of an empty dialog.
    const ja = parseReleaseNotes(notes, { language: "ja" });
    expect(ja.sections.map((section) => section.lang)).toEqual(["en", "en"]);
    // A Japanese-authored note serves the Japanese dialog directly.
    const jaNotes = "### 新機能\n- 日本語の機能。\n\n### New Features\n- English feature.";
    expect(parseReleaseNotes(jaNotes, { language: "ja" }).sections.map((section) => section.items))
      .toEqual([["日本語の機能。"]]);
  });

  it("keeps custom sections and unstructured legacy text instead of discarding them", () => {
    expect(parseReleaseNotes("Legacy text\ncontinued here.\n\nAnother paragraph.")).toEqual({
      paragraphs: ["Legacy text continued here.", "Another paragraph."], sections: [], count: 0,
    });
    expect(parseReleaseNotes("## Compatibility\nA platform-specific change.").sections)
      .toMatchObject([{ title: "Compatibility", items: ["A platform-specific change."] }]);
  });

  it("does not interpret fenced examples as update categories", () => {
    const example = "\u0060\u0060\u0060text\n### Fixes\n- example only\n\u0060\u0060\u0060";
    const parsed = parseReleaseNotes(example);
    expect(parsed.paragraphs).toEqual([example]);
    expect(parsed.sections).toEqual([]);
  });
});
