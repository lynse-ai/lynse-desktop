import * as chrono from "chrono-node";

/**
 * Natural-language due-date extraction for quick-add surfaces ("周五下午3点
 * 交周报" → title 交周报, due Fri 15:00). Powered by chrono-node — the zh
 * casual parser runs first with `forwardDate` so bare weekday phrases ("周五")
 * resolve to the upcoming occurrence rather than the past one; the default
 * (English) parser handles latin input. Recurrence phrasing ("每周一") parses
 * to the next occurrence as a plain date — real recurring todos are a
 * separate feature.
 */

export interface NaturalWhen {
  /** Input with the date phrase stripped and stray separators tidied. */
  title: string;
  /** Local ISO due value: `YYYY-MM-DDTHH:mm:00` when the phrase carried a
   *  time of day, otherwise the bare `YYYY-MM-DD` (matches the date-only
   *  shape the rest of the todo layer uses for day-level deadlines). */
  dueDate: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toLocalDateTime(d: Date): string {
  return `${toLocalDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
}

interface Match {
  index: number;
  text: string;
  date: Date;
  certainHour: boolean;
}

function firstMatch(text: string, ref: Date): Match | null {
  for (const parser of [chrono.zh.casual, chrono.casual]) {
    const results = parser.parse(text, ref, { forwardDate: true });
    const found = results[0];
    // Ignore degenerate single-character matches (chrono can latch onto a
    // lone number in some locales) — a date phrase is always ≥ 2 chars.
    if (found && found.text.trim().length >= 2) {
      return {
        index: found.index,
        text: found.text,
        date: new Date(found.date().getTime()),
        certainHour: found.start.isCertain("hour"),
      };
    }
  }
  return null;
}

/** Leftover glue around the stripped span — CJK or latin separators plus
 *  whitespace, including the "的" that glues 时间短语 to the task ("周五的任务"). */
const EDGE_NOISE = /^[\s,，、;；:：.。!！?？的-]+|[\s,，、;；:：.。!！?？的-]+$/g;

export function parseNaturalWhen(input: string, ref: Date = new Date()): NaturalWhen | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = firstMatch(trimmed, ref);
  if (!match) return null;

  const before = trimmed.slice(0, match.index);
  const after = trimmed.slice(match.index + match.text.length);
  const title = `${before}${after}`.replace(EDGE_NOISE, "").trim();
  // The whole input was a date phrase — nothing left to make a todo from.
  if (!title) return null;

  const dueDate = match.certainHour ? toLocalDateTime(match.date) : toLocalDate(match.date);
  return { title, dueDate };
}
