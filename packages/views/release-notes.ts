export const RELEASE_NOTE_CATEGORIES = ["features", "improvements", "fixes", "security", "changes"] as const;
export type ReleaseNoteCategory = (typeof RELEASE_NOTE_CATEGORIES)[number];

export interface ReleaseNoteSection {
  key: string;
  category?: ReleaseNoteCategory;
  title: string;
  items: string[];
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

/** Parse authored sections without guessing a change's meaning or rendering HTML. */
export function parseReleaseNotes(notes: string): ParsedReleaseNotes {
  const paragraphs: string[] = [];
  const sections = new Map<string, ReleaseNoteSection>();
  let current: ReleaseNoteSection | undefined;
  let lastItem: { section: ReleaseNoteSection; index: number } | undefined;
  let paragraph: string[] = [];
  let fence: string | null = null;
  let code: string[] = [];

  const sectionFor = (title: string) => {
    const category = categoryOf(title);
    const key = category ?? `custom:${title}`;
    let section = sections.get(key);
    if (!section) {
      section = { key, category, title, items: [] };
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
  const result = [...sections.values()].filter((section) => section.items.length).sort((a, b) => rank(a) - rank(b));
  return { paragraphs, sections: result, count: result.reduce((count, section) => count + section.items.length, 0) };
}
