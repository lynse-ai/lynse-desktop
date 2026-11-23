/**
 * Extract todo items from an assistant chat message's markdown, powering the
 * message-level 转为待办 action. Deliberately conservative — the button must
 * not appear on every list-shaped answer:
 *
 *  1. Open checkbox items (`- [ ] …`) anywhere in the message win outright.
 *  2. Otherwise a bulleted/numbered block directly under a todo-ish line
 *     (heading or plain line naming 待办/任务/todo/…) is collected; any
 *     non-list paragraph ends the section.
 */

const CHECKBOX_OPEN = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s*(.+)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const HEADING = /^\s*#{1,6}\s*(.*)$/;
const TODOISH = /(待办|任务清单|任务列表|跟进事项|行动项|action\s*items?|to-?dos?|checklist)/i;

/** Strip emphasis/code fences and squeeze whitespace from a candidate title. */
function cleanTitle(text: string): string {
  return text
    .replace(/^[*_`~\s]+|[*_`~\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractChatTodoTitles(content: string): string[] {
  const lines = content.split(/\r?\n/);

  const checked = lines
    .map((line) => line.match(CHECKBOX_OPEN)?.[1])
    .filter((text): text is string => Boolean(text && text.trim()))
    .map(cleanTitle)
    .filter(Boolean);
  if (checked.length > 0) return checked;

  let todoish = false;
  const items: string[] = [];
  for (const line of lines) {
    const heading = line.match(HEADING);
    const plain = heading ? heading[1] : line.trim();
    if (plain && TODOISH.test(plain) && !BULLET.test(line)) {
      todoish = true;
      items.length = 0; // a keyword after a list restarts collection
      continue;
    }
    const bullet = line.match(BULLET);
    if (bullet) {
      if (todoish) {
        const title = cleanTitle(bullet[1] ?? "");
        if (title) items.push(title);
      }
      continue;
    }
    if (line.trim()) todoish = false; // non-list prose ends the section
  }
  return items;
}
