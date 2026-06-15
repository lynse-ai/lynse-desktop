/**
 * Editor actions for the Markdown toolbar.
 *
 * Dispatches formatting commands through a Milkdown Editor instance
 * using ProseMirror re-exported via @milkdown/kit/prose/*.
 */

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { callCommand } from "@milkdown/kit/utils";

// ── Types ─────────────────────────────────────────────────

export type MarkdownEditorAction =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "paragraph"
  | "bold"
  | "italic"
  | "inline-code"
  | "bullet-list"
  | "ordered-list"
  | "task-list"
  | "blockquote"
  | "image"
  | "undo"
  | "blur";

// ── Core action executor ──────────────────────────────────

/**
 * Execute a formatting action on the active Milkdown editor.
 * For the "image" action, pass payload { url, alt? }.
 */
export function executeAction(
  editor: Editor | null,
  action: MarkdownEditorAction,
  payload?: { alt?: string; url?: string },
): void {
  if (!editor) return;

  switch (action) {
    case "heading-1":
      editor.action(callCommand("WrapInHeading", 1));
      break;
    case "heading-2":
      editor.action(callCommand("WrapInHeading", 2));
      break;
    case "heading-3":
      editor.action(callCommand("WrapInHeading", 3));
      break;
    case "paragraph":
      editor.action(callCommand("TurnIntoText"));
      break;
    case "bold":
      editor.action(callCommand("ToggleBold"));
      break;
    case "italic":
      editor.action(callCommand("ToggleItalic"));
      break;
    case "inline-code":
      editor.action(callCommand("ToggleInlineCode"));
      break;
    case "bullet-list":
      editor.action(callCommand("WrapInBulletList"));
      break;
    case "ordered-list":
      editor.action(callCommand("WrapInOrderedList"));
      break;
    case "task-list":
      // GFM task list — command name may vary
      tryCmd(editor, "WrapInTaskList", "WrapInTaskListItem");
      break;
    case "blockquote":
      editor.action(callCommand("WrapInBlockquote"));
      break;
    case "image":
      if (payload?.url) {
        editor.action(
          callCommand("InsertImage", {
            src: payload.url,
            alt: payload.alt || "",
            title: payload.alt || "",
          }),
        );
      }
      break;
    case "undo":
      editor.action(callCommand("Undo"));
      break;
    case "blur": {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        (view.dom as HTMLElement).blur();
      });
      break;
    }
  }
}

/** Try multiple command names, stopping at the first that succeeds. */
function tryCmd(editor: Editor, ...names: string[]): void {
  for (const name of names) {
    try {
      editor.action(callCommand(name));
      return;
    } catch {
      // Try next name
    }
  }
}
