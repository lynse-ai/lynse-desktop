export const RELEASE_NOTE_CATEGORIES = ["features", "improvements", "fixes", "security", "changes"] as const;
export type ReleaseNoteCategory = (typeof RELEASE_NOTE_CATEGORIES)[number];

/** Heading scripts the notes may be authored in; rendered notes pick one. */
export type ReleaseNoteLanguage = "en" | "zh" | "ja" | "ko";

export interface ReleaseNoteSection {
  key: string;
  category?: ReleaseNoteCategory;
  title: string;
  items: string[];
  lang: ReleaseNoteLanguage;
}

export interface ParsedReleaseNotes {
  paragraphs: string[];
  sections: ReleaseNoteSection[];
  count: number;
}

const HEADING_ALIASES: Record<ReleaseNoteCategory, readonly string[]> = {
  features: ["features", "new features", "added", "新功能", "新增功能", "新增", "新機能", "새 기능"],
  improvements: ["improvements", "performance improvements", "performance", "improved", "changed", "改进", "改進", "优化", "優化", "改善", "变更", "變更", "개선"],
  fixes: ["bug fixes", "fixes", "fixed", "错误修复", "錯誤修復", "问题修复", "問題修復", "修复", "修復", "不具合修正", "バグ修正", "버그 수정", "오류 수정"],
  security: ["security", "安全", "セキュリティ", "보안"],
  changes: ["changes", "what's new", "updates", "更新内容", "更新內容", "更新情報", "変更内容", "업데이트 내용", "변경 사항"],
};

function normalizedHeading(value: string): string {
  return value.replace(/^\*\*(.*?)\*\*$/, "$1").replace(/[:：]\s*$/, "").trim();
}

function categoryOf(title: string): ReleaseNoteCategory | undefined {
  const key = title.toLowerCase();
  return RELEASE_NOTE_CATEGORIES.find((category) => HEADING_ALIASES[category].includes(key));
}

// Known headings have a fixed authored language (新機能 is all han yet Japanese),
// so alias lookup decides first; script sniffing only covers custom headings.
const ZH_HEADINGS = new Set(["新功能", "新增功能", "新增", "改进", "改進", "优化", "優化", "变更", "變更", "错误修复", "錯誤修復", "问题修复", "問題修復", "修复", "修復", "安全", "更新内容", "更新內容"]);
const JA_HEADINGS = new Set(["新機能", "改善", "不具合修正", "バグ修正", "セキュリティ", "更新情報", "変更内容"]);
const KO_HEADINGS = new Set(["새 기능", "개선", "버그 수정", "오류 수정", "보안", "업데이트 내용", "변경 사항"]);

function scriptOfHeading(title: string): ReleaseNoteLanguage {
  const key = title.toLowerCase();
  if (JA_HEADINGS.has(key)) return "ja";
  if (KO_HEADINGS.has(key)) return "ko";
  if (ZH_HEADINGS.has(key)) return "zh";
  // Kana and hangul win over han so mixed Japanese/Korean custom headings classify right.
  if (/[\u3040-\u30ff]/.test(title)) return "ja";
  if (/[\uac00-\ud7af]/.test(title)) return "ko";
  if (/[\u4e00-\u9fff]/.test(title)) return "zh";
  return "en";
}

export interface ParseReleaseNotesOptions {
  /** Show only sections authored in this language; falls back to English, then all. */
  language?: ReleaseNoteLanguage;
}

/** Parse authored sections without guessing a change's meaning or rendering HTML. */
export function parseReleaseNotes(notes: string, options: ParseReleaseNotesOptions = {}): ParsedReleaseNotes {
  const paragraphs: string[] = [];
  const sections = new Map<string, ReleaseNoteSection>();
  let current: ReleaseNoteSection | undefined;
  let lastItem: { section: ReleaseNoteSection; index: number } | undefined;
  let paragraph: string[] = [];
  let fence: string | null = null;
  let code: string[] = [];

  const sectionFor = (title: string) => {
    const category = categoryOf(title);
    const lang = scriptOfHeading(title);
    const key = `${category ?? `custom:${title}`}:${lang}`;
    let section = sections.get(key);
    if (!section) {
      section = { key, category, title, items: [], lang };
      sections.set(key, section);
    }
    return section;
  };
  const putParagraph = (text: string) => {
    if (current) current.items.push(text);
    else paragraphs.push(text);
  };
  const flush = () => {
    if (paragraph.length) putParagraph(paragraph.join(" "));
    paragraph = [];
  };

  for (const line of notes.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (fence) {
      code.push(line);
      if (trimmed.startsWith(fence)) {
        putParagraph(code.join("\n"));
        fence = null;
        code = [];
      }
      continue;
    }
    const openingFence = /^(\u0060{3,}|~{3,})/.exec(trimmed);
    if (openingFence) {
      flush();
      lastItem = undefined;
      fence = openingFence[1]!;
      code = [line];
      continue;
    }
    if (!trimmed) {
      flush();
      lastItem = undefined;
      continue;
    }
    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      flush();
      lastItem = undefined;
      continue;
    }
    const markdownHeading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    const title = normalizedHeading(markdownHeading?.[1] ?? trimmed);
    if (markdownHeading || categoryOf(title)) {
      flush();
      lastItem = undefined;
      current = sectionFor(title);
      continue;
    }
    const bullet = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      flush();
      current ??= sectionFor("Changes");
      current.items.push(bullet[1]!.trim());
      lastItem = { section: current, index: current.items.length - 1 };
    } else if (lastItem) {
      lastItem.section.items[lastItem.index] += " " + trimmed;
    } else {
      paragraph.push(trimmed);
    }
  }
  if (fence) putParagraph(code.join("\n"));
  flush();
  const rank = (section: ReleaseNoteSection) => section.category
    ? RELEASE_NOTE_CATEGORIES.indexOf(section.category)
    : RELEASE_NOTE_CATEGORIES.length;
  let result = [...sections.values()].filter((section) => section.items.length).sort((a, b) => rank(a) - rank(b));
  const language = options.language;
  if (language) {
    const exact = result.filter((section) => section.lang === language);
    if (exact.length) result = exact;
    else {
      // Authored notes without this language render their English variant,
      // falling back to everything rather than an empty dialog.
      const english = result.filter((section) => section.lang === "en");
      if (english.length) result = english;
    }
  }
  return { paragraphs, sections: result, count: result.reduce((count, section) => count + section.items.length, 0) };
}
