/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  buildNoteMarkdown,
  isHtmlContent,
  VAULT_DEFAULT_SECTION_LABELS,
} from "./note-vault";

const baseInput = {
  fileId: "file-1",
  title: "产品评审会",
};

describe("isHtmlContent", () => {
  it("detects html documents and rejects markdown", () => {
    expect(isHtmlContent("<html><body><p>hi</p></body></html>")).toBe(true);
    expect(isHtmlContent("<p>hi</p>")).toBe(true);
    expect(isHtmlContent("# heading\n\ntext")).toBe(false);
    expect(isHtmlContent("plain < text")).toBe(false);
  });
});

describe("buildNoteMarkdown", () => {
  it("returns null when the note has no outline and no conclusions", () => {
    expect(buildNoteMarkdown(baseInput)).toBeNull();
    expect(buildNoteMarkdown({ ...baseInput, conclusions: [{ id: "c1", text: "  " }] })).toBeNull();
  });

  it("emits frontmatter with id, title, source tag and dates", () => {
    const payload = buildNoteMarkdown({
      ...baseInput,
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-09-05T18:00:00Z",
      conclusions: [{ id: "c1", name: "纪要", text: "内容" }],
    });
    expect(payload).not.toBeNull();
    expect(payload!.markdown).toContain('id: "file-1"');
    expect(payload!.markdown).toContain('title: "产品评审会"');
    expect(payload!.markdown).toContain('created: "2026-08-01T10:00:00Z"');
    expect(payload!.markdown).toContain('updated: "2026-09-05T18:00:00Z"');
    expect(payload!.markdown).toContain("source: lynse");
    expect(payload!.markdown).toMatch(/tags:\n  - lynse/);
  });

  it("keeps markdown conclusions verbatim under a heading", () => {
    const payload = buildNoteMarkdown({
      ...baseInput,
      conclusions: [{ id: "c1", name: "会议纪要", text: "- 要点一\n- 要点二" }],
    });
    expect(payload!.markdown).toContain("## 会议纪要\n\n- 要点一\n- 要点二");
    expect(payload!.markdown).toContain("# 产品评审会");
  });

  it("converts html conclusions to markdown", () => {
    const payload = buildNoteMarkdown({
      ...baseInput,
      conclusions: [{ id: "c1", text: "<h1>结论</h1><p>正文内容</p>" }],
    });
    expect(payload!.markdown).toContain("## Summary 1");
    expect(payload!.markdown).toContain("# 结论");
    expect(payload!.markdown).toContain("正文内容");
    expect(payload!.markdown).not.toContain("<p>");
  });

  it("strips style/script blocks from full html outline documents", () => {
    const payload = buildNoteMarkdown({
      ...baseInput,
      outlineText:
        "<html><head><style>body { color: red; }</style></head><body><h2>第一章</h2><ul><li>条目</li></ul></body></html>",
    });
    expect(payload!.markdown).toContain("## Outline");
    expect(payload!.markdown).toContain("## 第一章");
    expect(payload!.markdown).toMatch(/-\s+条目/);
    expect(payload!.markdown).not.toContain("color: red");
    expect(payload!.markdown).not.toContain("<style>");
  });

  it("deduplicates identical summary section names", () => {
    const payload = buildNoteMarkdown({
      ...baseInput,
      conclusions: [
        { id: "c1", name: "纪要", text: "第一份" },
        { id: "c2", name: "纪要", text: "第二份" },
      ],
    });
    expect(payload!.markdown).toContain("## 纪要\n\n第一份");
    expect(payload!.markdown).toContain("## 纪要 (2)\n\n第二份");
  });

  it("honors localized section labels", () => {
    const payload = buildNoteMarkdown({
      ...baseInput,
      outlineText: "大纲正文",
      conclusions: [{ id: "c1", text: "总结正文" }],
      labels: { outline: "大纲", summary: "总结" },
    });
    expect(payload!.markdown).toContain("## 大纲\n\n大纲正文");
    expect(payload!.markdown).toContain("## 总结 1\n\n总结正文");
    expect(VAULT_DEFAULT_SECTION_LABELS.outline).toBe("Outline");
  });
});
