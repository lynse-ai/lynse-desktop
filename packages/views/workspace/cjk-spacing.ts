/**
 * CJK letter spacing — ported from vmark's cjkLetterSpacing plugin
 * (github.com/xiaolai/vmark, ISC license).
 *
 * Applies a subtle letter-spacing to CJK character runs for readability
 * without modifying the document. Two entry points:
 *
 * - `cjkSpacingPlugin()` — ProseMirror decorations for Milkdown editors
 * - `wrapCjkSpacing(html)` — wraps CJK runs in <span class="cjk-spacing">
 *   for read-only HTML previews
 *
 * The visual spacing itself lives in content-preview.css, scoped to the
 * vmark-* editor themes and disabled inside code (where spacing would
 * break alignment).
 */

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";

// CJK Unicode ranges:
// - CJK Unified Ideographs: U+4E00-U+9FFF (+ Extension A: U+3400-U+4DBF)
// - CJK Compatibility Ideographs: U+F900-U+FAFF
// - Hiragana: U+3040-U+309F, Katakana: U+30A0-U+30FF
// - Hangul Syllables: U+AC00-U+D7AF, Bopomofo: U+3100-U+312F
const CJK_REGEX =
  /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u3100-\u312f]+/g;

const CJK_SPACING_CLASS = "cjk-spacing";

const cjkSpacingKey = new PluginKey("cjkLetterSpacing");

function createCjkDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: PMNode, pos: number) => {
    if (!node.isText || !node.text) return;

    CJK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CJK_REGEX.exec(node.text)) !== null) {
      const from = pos + match.index;
      decorations.push(
        Decoration.inline(from, from + match[0].length, { class: CJK_SPACING_CLASS }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

/** ProseMirror plugin that decorates CJK text runs with .cjk-spacing. */
export function cjkSpacingPlugin(): Plugin {
  return new Plugin({
    key: cjkSpacingKey,
    state: {
      init(_, { doc }): DecorationSet {
        return createCjkDecorations(doc);
      },
      apply(tr, oldDecorations: DecorationSet): DecorationSet {
        if (!tr.docChanged) return oldDecorations.map(tr.mapping, tr.doc);
        return createCjkDecorations(tr.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state) as DecorationSet | null;
      },
    },
  });
}

const SKIP_TAGS = new Set(["pre", "code", "script", "style", "textarea"]);

/**
 * Wrap CJK runs in an HTML string with <span class="cjk-spacing">.
 * Text inside pre/code/script/style is left untouched (code alignment).
 */
export function wrapCjkSpacing(html: string): string {
  if (!html || !hasCjk(html)) return html;

  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  let result = "";
  let cursor = 0;
  const openTags: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(html)) !== null) {
    // Text segment before this tag
    if (match.index > cursor) {
      result += wrapTextSegment(html.slice(cursor, match.index), openTags);
    }
    result += match[0];
    cursor = match.index + match[0].length;

    const tag = (match[1] ?? "").toLowerCase();
    if (match[0].startsWith("</")) {
      const idx = openTags.lastIndexOf(tag);
      if (idx !== -1) openTags.splice(idx, 1);
    } else if (!match[0].endsWith("/>")) {
      openTags.push(tag);
    }
  }
  if (cursor < html.length) {
    result += wrapTextSegment(html.slice(cursor), openTags);
  }
  return result;
}

function inSkipContext(openTags: string[]): boolean {
  return openTags.some((tag) => SKIP_TAGS.has(tag));
}

function wrapTextSegment(text: string, openTags: string[]): string {
  if (inSkipContext(openTags)) return text;
  CJK_REGEX.lastIndex = 0;
  return text.replace(new RegExp(CJK_REGEX.source, "g"), (run) =>
    `<span class="${CJK_SPACING_CLASS}">${run}</span>`,
  );
}

function hasCjk(text: string): boolean {
  CJK_REGEX.lastIndex = 0;
  return CJK_REGEX.test(text);
}
