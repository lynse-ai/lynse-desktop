"use client";

/**
 * flomo-style `#tag` parsing.
 *
 * A tag starts with `#` — unless glued to a latin word/number/URL path — and
 * runs until whitespace or CJK/fullwidth punctuation. Purely lexical — used
 * for tag chips while composing, tag highlighting in the feed, and the tag
 * filter.
 */

/** Whitespace plus CJK and Western punctuation ends a tag. */
const TAG_STOP = new Set(
  [
    " ",
    "\t",
    "\n",
    "\r",
    "，",
    "。",
    "！",
    "？",
    "、",
    "；",
    "：",
    "“",
    "”",
    "‘",
    "’",
    "（",
    "）",
    "【",
    "】",
    "《",
    "》",
    "…",
    "—",
    ",",
    ".",
    "!",
    "?",
    ";",
    ":",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    "<",
    ">",
    "\"",
    "'",
    "`",
    "~",
    "@",
    "$",
    "%",
    "^",
    "&",
    "*",
    "+",
    "=",
    "|",
    "\\",
    "/",
  ],
);

export type TextSegment = {
  text: string;
  /** The tag name (without `#`) when this segment is a tag, else null. */
  tag: string | null;
};

/**
 * A `#` opens a tag unless it is glued to a latin word, a number, a URL path
 * (`/#section`), or another hash. Whitespace, punctuation, and CJK characters
 * all open tags — Chinese text has no spaces, so `会#会议纪要` must work.
 */
const TAG_BLOCKER = /[a-zA-Z0-9/#]/;

function startsTag(previous: string): boolean {
  return previous === "" ? true : !TAG_BLOCKER.test(previous);
}

export function parseHashtags(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) !== "#" || !startsTag(text.charAt(index - 1))) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && !TAG_STOP.has(text.charAt(end))) end += 1;
    const tag = text.slice(index + 1, end);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
    index = end;
  }
  return tags;
}

/** Split text into plain/tag segments so the feed can highlight tags inline. */
export function splitByHashtags(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let plain = "";
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) !== "#" || !startsTag(text.charAt(index - 1))) {
      plain += text.charAt(index);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && !TAG_STOP.has(text.charAt(end))) end += 1;
    const tag = text.slice(index + 1, end);
    if (!tag) {
      plain += text.charAt(index);
      index += 1;
      continue;
    }
    if (plain) {
      segments.push({ text: plain, tag: null });
      plain = "";
    }
    segments.push({ text: text.slice(index, end), tag });
    index = end;
  }
  if (plain) segments.push({ text: plain, tag: null });
  return segments;
}

/** All tags across a set of records, ordered by first appearance. */
export function collectTags(texts: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const text of texts) {
    for (const tag of parseHashtags(text)) {
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }
  return tags;
}
