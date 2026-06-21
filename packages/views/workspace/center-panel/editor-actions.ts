/**
 * Editor actions for the Markdown toolbar.
 *
 * Dispatches formatting commands through a Milkdown Editor instance
 * using ProseMirror re-exported via @milkdown/kit/prose/*.
 */

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx, commandsCtx } from "@milkdown/kit/core";
import { callCommand } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";

type CommandFn = (ctx: Ctx) => boolean;

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
 *
 * Tolaria-inspired: always focus the editor before dispatching commands
 * to prevent selection loss. Wraps each command in try/catch.
 */
export function executeAction(
  editor: Editor | null,
  action: MarkdownEditorAction,
  payload?: { alt?: string; url?: string },
): void {
  if (!editor) return;

  try {
    // Tolaria pattern: focus editor BEFORE executing any command
    // so ProseMirror can properly dispatch to the active view.
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      (view.dom as HTMLElement).focus();
    });

    editor.action((ctx) => {
      const cmdFn = resolveCommand(action, payload);
      if (cmdFn) {
        const result = cmdFn(ctx);
        console.debug(`[editor-actions] "${action}" → ${result}`);
      }
    });
  } catch (err) {
    console.warn(`[editor-actions] Failed to execute "${action}":`, err);
  }
}

/**
 * Resolve a MarkdownEditorAction to its command function.
 * Returns a (ctx) => boolean function that can be called within editor.action().
 * Returns null for actions that don't map to a command.
 */
export function resolveCommand(
  action: MarkdownEditorAction,
  payload?: { alt?: string; url?: string },
): CommandFn | null {
  switch (action) {
    case "heading-1":
      return callCommand("WrapInHeading", 1);
    case "heading-2":
      return callCommand("WrapInHeading", 2);
    case "heading-3":
      return callCommand("WrapInHeading", 3);
    case "paragraph":
      return callCommand("TurnIntoText");
    case "bold":
      return callCommand("ToggleStrong");
    case "italic":
      return callCommand("ToggleEmphasis");
    case "inline-code":
      return callCommand("ToggleInlineCode");
    case "bullet-list":
      return callCommand("WrapInBulletList");
    case "ordered-list":
      return callCommand("WrapInOrderedList");
    case "task-list":
      return (ctx: Ctx) => {
        try {
          return ctx.get(commandsCtx).call("WrapInTaskList");
        } catch {
          try {
            return ctx.get(commandsCtx).call("WrapInTaskListItem");
          } catch {
            return false;
          }
        }
      };
    case "blockquote":
      return callCommand("WrapInBlockquote");
    case "image":
      if (payload?.url) {
        return callCommand("InsertImage", {
          src: payload.url,
          alt: payload.alt || "",
          title: payload.alt || "",
        });
      }
      return null;
    case "undo":
      return callCommand("Undo");
    case "blur":
      return (ctx: Ctx) => {
        const view = ctx.get(editorViewCtx);
        (view.dom as HTMLElement).blur();
        return true;
      };
    default:
      return null;
  }
}
