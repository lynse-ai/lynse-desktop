"use client";

import { useEffect, useRef } from "react";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, remarkPluginsCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import remarkBreaks from "remark-breaks";

import "@milkdown/kit/prose/view/style/prosemirror.css";

interface InspirationMarkdownEditorProps {
  initialContent: string;
  onChange?: (markdown: string) => void;
  /** Move the keyboard focus into the ProseMirror view once created. */
  autoFocus?: boolean;
}

/**
 * Markdown editor for the inspiration detail dialog, built on the same
 * Milkdown stack as the workspace editor (`workspace/center-panel/
 * milkdown-editor.tsx`). Unlike that one it keeps the instance in a component
 * ref instead of a module-level singleton, so the workspace editor and the
 * inspiration editor can be mounted at the same time without destroying each
 * other.
 */
export function InspirationMarkdownEditor({ initialContent, onChange, autoFocus }: InspirationMarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    let instance: Editor | null = null;
    let disposed = false;

    void Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialContent);
        ctx.set(remarkPluginsCtx, [{ plugin: remarkBreaks, options: undefined as unknown as Record<string, unknown> }]);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChangeRef.current?.(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(clipboard)
      .create()
      .then((editor) => {
        if (disposed) {
          void editor.destroy();
          return;
        }
        instance = editor;
        if (autoFocus) {
          editor.action((ctx) => {
            ctx.get(editorViewCtx).focus();
          });
        }
      });

    return () => {
      disposed = true;
      void instance?.destroy();
      instance = null;
    };
    // The editor is created once per dialog session; content changes flow
    // through onChange back to the parent, not through re-creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="inspiration-markdown-editor min-h-[140px] max-h-[46vh] overflow-y-auto rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm [&_.ProseMirror]:outline-none"
      onClick={(event) => {
        // Clicking padding focuses the editable area so typing works anywhere
        // inside the box. ProseMirror handles its own caret placement.
        const target = event.currentTarget.querySelector<HTMLElement>(".ProseMirror");
        target?.focus();
      }}
    />
  );
}
