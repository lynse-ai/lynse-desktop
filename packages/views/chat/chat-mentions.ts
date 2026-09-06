import type { WorkspaceItem } from "../workspace/types";
import { filterWorkspaceFilesByFolder } from "../workspace/middle-panel/file-list-filter";

/**
 * @/# mention support for the chat composer.
 *
 * Typing `@` lets the user reference a single note; `#` references a whole
 * note group (folder). Both are picked from a small autocomplete popover;
 * selection inserts a plain-text token (`@Title` / `#Name`) into the message
 * AND records a structured {@link ChatMention}. On send, the structured
 * mentions are expanded to `fileIds` (groups expand to their member notes)
 * so the backend can scope retrieval — the same channel the workspace chat
 * panel already uses for a selected file.
 */

export type MentionTrigger = "@" | "#";
export type MentionKind = "note" | "group";

export interface MentionDetection {
  trigger: MentionTrigger;
  /** Query typed after the trigger character (may be empty). */
  query: string;
  /** Index of the trigger character within the input. */
  start: number;
  /** End of the typed query (usually the caret). */
  end: number;
}

export interface ChatMention {
  kind: MentionKind;
  id: string;
  title: string;
}

/** A mention entry as shown in the autocomplete list (adds a count for groups). */
export interface MentionOption {
  kind: MentionKind;
  id: string;
  title: string;
  /** Member-note count (groups only). */
  count?: number;
}

/** Trigger char + non-space query, anchored to word start, right before the caret. */
const MENTION_QUERY_RE = /(^|\s)([@#])([^\s@#]*)$/u;

/**
 * Detect an in-progress mention right before `caret`.
 * Returns null when the caret is not inside a `@…`/`#…` token.
 */
export function detectMentionTrigger(text: string, caret: number): MentionDetection | null {
  const before = text.slice(0, caret);
  const match = MENTION_QUERY_RE.exec(before);
  if (!match) return null;
  const trigger = match[2] as MentionTrigger;
  const start = (match.index ?? 0) + (match[1]?.length ?? 0);
  return { trigger, query: match[3] ?? "", start, end: caret };
}

/** Case-insensitive substring filter over option titles. */
export function filterMentionOptions<T extends { title: string }>(options: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((option) => option.title.toLowerCase().includes(q));
}

/** Replace the in-progress token with the picked mention's plain-text form. */
export function insertMentionText({
  text,
  detection,
  title,
}: {
  text: string;
  detection: MentionDetection;
  title: string;
}): { text: string; caret: number } {
  const token = `${detection.trigger}${title} `;
  const next = text.slice(0, detection.start) + token + text.slice(detection.end);
  return { text: next, caret: detection.start + token.length };
}

/** The plain-text token a mention occupies inside the message. */
export function mentionToken(mention: ChatMention): string {
  return `${mention.kind === "note" ? "@" : "#"}${mention.title}`;
}

/**
 * Mentions whose token is still present in the message text. Deleting the
 * `@Title` text by hand therefore also drops the chip (and its fileIds),
 * while picking a mention twice stays deduplicated via the structured list.
 */
export function activeMentions(mentions: ChatMention[], text: string): ChatMention[] {
  return mentions.filter((mention) => text.includes(mentionToken(mention)));
}

/** Remove a mention's token (plus one trailing space) from the message. */
export function removeMentionText(text: string, mention: ChatMention): string {
  const token = mentionToken(mention);
  const index = text.indexOf(token);
  if (index === -1) return text;
  let end = index + token.length;
  if (text[end] === " ") end += 1;
  return text.slice(0, index) + text.slice(end);
}

/**
 * Expand the active mentions into a deduplicated list of file ids the chat
 * backend understands. Notes contribute their own id; groups contribute every
 * note currently in that group (same filter the notes page uses).
 */
export function collectMentionFileIds(
  mentions: ChatMention[],
  notes: WorkspaceItem[],
): string[] {
  const ids = new Set<string>();
  for (const mention of mentions) {
    if (mention.kind === "note") {
      ids.add(mention.id);
      continue;
    }
    for (const note of filterWorkspaceFilesByFolder(notes, mention.id)) {
      ids.add(note.id);
    }
  }
  return [...ids];
}
