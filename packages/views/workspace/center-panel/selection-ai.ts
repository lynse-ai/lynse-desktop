/**
 * Selection AI actions for the note editor toolbar: pure helpers shared by
 * the toolbar UI and its tests. A picked action becomes a chat prompt whose
 * payload quotes the selected text so the assistant acts on the exact passage.
 */

export type SelectionAiActionId = "explain" | "polish" | "shorten" | "translate";

/** Toolbar menu order. */
export const SELECTION_AI_ACTIONS: readonly SelectionAiActionId[] = [
  "explain",
  "polish",
  "shorten",
  "translate",
];

/**
 * Upper bound for the quoted passage — a runaway whole-note selection should
 * not flood the chat turn.
 */
const MAX_SELECTION_CHARS = 8000;

/**
 * Build the chat prompt for a selection action: the localized instruction on
 * its own line, then the passage as a markdown blockquote (preserves line
 * breaks and keeps the source visually distinct from the ask).
 */
export function buildSelectionPrompt(instruction: string, selection: string): string {
  const ask = instruction.trim();
  const passage = selection.trim().slice(0, MAX_SELECTION_CHARS);
  if (!passage) return ask;
  const quoted = passage
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${ask}\n\n${quoted}`;
}
