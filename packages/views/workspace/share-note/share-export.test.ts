import { describe, expect, it } from "vitest";
import {
  buildShareFileName,
  cardPngToPdfBytes,
  computePdfLayout,
  countContentWords,
  dataUrlToBytes,
  PDF_A4,
  sanitizeFileName,
  stripMindmapContent,
} from "./share-export";
import { DEFAULT_SHARE_CARD_THEME_ID, getShareCardTheme, SHARE_CARD_THEMES } from "./card-themes";
import type { ShareCardFontId } from "./card-themes";

describe("sanitizeFileName", () => {
  it("strips path-hostile characters and collapses whitespace", () => {
    expect(sanitizeFileName('周会/纪要:Q1\\2026*?"<>|')).toBe("周会 纪要 Q1 2026");
    expect(sanitizeFileName("  多  空格  ")).toBe("多 空格");
  });

  it("caps the length so filenames stay reasonable", () => {
    expect(sanitizeFileName("很长的标题".repeat(30)).length).toBeLessThanOrEqual(60);
  });

  it("keeps ordinary CJK and latin titles intact", () => {
    expect(sanitizeFileName("Product Review 2026-10-31")).toBe("Product Review 2026-10-31");
  });
});

describe("buildShareFileName", () => {
  it("appends the ISO date and extension", () => {
    const date = new Date("2026-10-31T12:00:00Z");
    expect(buildShareFileName("周会纪要", "png", date)).toBe("周会纪要-2026-10-31.png");
    expect(buildShareFileName("周会纪要", "pdf", date)).toBe("周会纪要-2026-10-31.pdf");
  });

  it("falls back to Lynse when the title sanitizes to nothing", () => {
    const date = new Date("2026-10-31T12:00:00Z");
    expect(buildShareFileName("///", "md", date)).toBe("Lynse-2026-10-31.md");
  });
});

describe("computePdfLayout", () => {
  it("fits a short card on one page", () => {
    const layout = computePdfLayout(736, 800);
    expect(layout.pageCount).toBe(1);
    expect(layout.contentWidthMm).toBe(PDF_A4.widthMm - PDF_A4.marginMm * 2);
  });

  it("slices a tall card across several pages", () => {
    const layout = computePdfLayout(736, 8000);
    const expected = Math.ceil(layout.totalHeightMm / layout.contentHeightMm);
    expect(layout.pageCount).toBe(expected);
    expect(layout.pageCount).toBeGreaterThan(1);
  });

  it("scales height proportionally to the fixed content width", () => {
    const layout = computePdfLayout(100, 200);
    expect(layout.totalHeightMm).toBeCloseTo(2 * (PDF_A4.widthMm - PDF_A4.marginMm * 2), 5);
  });
});

describe("dataUrlToBytes", () => {
  it("decodes a base64 data URL", () => {
    // "png" encoded
    const bytes = dataUrlToBytes("data:image/png;base64,cG5n");
    expect(Array.from(bytes)).toEqual([0x70, 0x6e, 0x67]);
  });
});

describe("cardPngToPdfBytes", () => {
  it("produces a PDF header for a one-page card", async () => {
    // 1x1 transparent PNG
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const bytes = await cardPngToPdfBytes({ dataUrl: png, bytes: new Uint8Array(), width: 100, height: 100 });
    const header = String.fromCharCode(...bytes.slice(0, 4));
    expect(header).toBe("%PDF");
  });
});

describe("stripMindmapContent", () => {
  it("removes markdown mindmap images including their alt text", () => {
    const text = "前言文字\n\n![思维导图](mindmap:data:image/png;base64,AAAA)\n\n后续文字";
    expect(stripMindmapContent(text)).toBe("前言文字\n\n\n\n后续文字");
    expect(stripMindmapContent(text)).not.toContain("思维导图");
  });

  it("removes the 「思维导图」 heading that introduces the image", () => {
    const text = "## 总结\n\n正文内容\n\n## 思维导图\n\n![思维导图](mindmap:data:image/png;base64,AAAA)\n\n| A | B |\n";
    const stripped = stripMindmapContent(text);
    expect(stripped).not.toContain("思维导图");
    expect(stripped).toContain("## 总结");
    expect(stripped).toContain("正文内容");
    expect(stripped).toContain("| A | B |");
  });

  it("removes HTML mindmap images and headings", () => {
    const html =
      '<h2>思维导图</h2><img src="mindmap:data:image/png;base64,AAAA" alt="导图" /><img src=\'mindmap:data:image/png;base64,BBBB\' /><p>内容</p>';
    const stripped = stripMindmapContent(html);
    expect(stripped).toBe("<p>内容</p>");
  });

  it("keeps ordinary images and headings untouched", () => {
    const text = "## 大纲\n![配图](data:image/png;base64,CCCC) ![外链](https://example.com/a.png)";
    expect(stripMindmapContent(text)).toBe(text);
  });
});

describe("countContentWords", () => {
  it("counts CJK characters individually", () => {
    expect(countContentWords(["你好世界"])).toBe(4);
  });

  it("counts latin runs as single words", () => {
    expect(countContentWords(["hello world"])).toBe(2);
  });

  it("handles mixed CJK/latin content", () => {
    expect(countContentWords(["会议记录 meeting notes 2026"])).toBe(4 + 3);
  });

  it("strips HTML markup and code blocks before counting", () => {
    const withMarkup = ["<p>正文内容</p>", "```\ncode ignore\n```", "`inline` 文字"];
    // 正文内容 (4) + 文字 (2) — markup and code excluded
    expect(countContentWords(withMarkup)).toBe(6);
  });

  it("ignores null/undefined sections", () => {
    expect(countContentWords([null, undefined, "文本"])).toBe(2);
    expect(countContentWords([])).toBe(0);
  });
});

describe("card themes", () => {
  it("has ten presets with unique ids and an i18n key each", () => {
    expect(SHARE_CARD_THEMES).toHaveLength(10);
    const ids = SHARE_CARD_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(10);
    for (const theme of SHARE_CARD_THEMES) {
      expect(theme.nameKey).toMatch(/^share\.theme_/);
      expect(theme.background).toBeTruthy();
      expect(theme.swatch).toBeTruthy();
    }
  });

  it("covers light, dark, gradient and textured styles", () => {
    const ids = SHARE_CARD_THEMES.map((theme) => theme.id);
    expect(ids).toContain("minimal");
    expect(ids).toContain("aurora");
    // sspai-reference palettes; ink (black & gold) mirrors the visual summary
    expect(ids).toContain("ink");
    expect(ids).toContain("sage");
    expect(ids).toContain("navy");
    // slimmed-down set: no near-duplicates
    expect(ids).not.toContain("midnight");
    expect(ids).not.toContain("mint");
    expect(ids).not.toContain("sunset");
    expect(ids).not.toContain("ocean");
  });

  it("gives each theme a valid typeface (themes are designs, not recolors)", () => {
    const validFonts: ShareCardFontId[] = ["sans", "serif", "kai", "round"];
    for (const theme of SHARE_CARD_THEMES) {
      expect(validFonts).toContain(theme.font);
    }
    expect(getShareCardTheme("paper").font).toBe("kai");
    expect(getShareCardTheme("sakura").font).toBe("round");
    expect(getShareCardTheme("aurora").font).toBe("round");
    expect(getShareCardTheme("dusk").font).toBe("serif");
    expect(getShareCardTheme("coffee").font).toBe("serif");
    expect(getShareCardTheme("newsprint").font).toBe("serif");
  });

  it("falls back to the default theme for unknown ids", () => {
    expect(getShareCardTheme("nope").id).toBe(DEFAULT_SHARE_CARD_THEME_ID);
  });

  it("gradient themes declare an inner surface for content", () => {
    for (const id of ["aurora", "navy"]) {
      expect(getShareCardTheme(id).surface).toBeTruthy();
    }
    expect(getShareCardTheme("minimal").surface).toBeUndefined();
  });
});
