"use client";

import { useEffect, useRef } from "react";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, remarkPluginsCtx } from "@milkdown/kit/core";
import { DOMSerializer } from "@milkdown/kit/prose/model";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { replaceAll } from "@milkdown/kit/utils";
import remarkBreaks from "remark-breaks";

import "@milkdown/kit/prose/view/style/prosemirror.css";

interface MilkdownEditorProps {
  initialContent?: string;
  onChange?: (markdown: string) => void;
  /** Called when the internal editor instance is ready or destroyed. */
  onEditorReady?: (editor: Editor | null) => void;
}

let editorInstance: Editor | null = null;

export function MilkdownEditor({ initialContent, onChange, onEditorReady }: MilkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const onEditorReadyRef = useRef(onEditorReady);
  onChangeRef.current = onChange;
  onEditorReadyRef.current = onEditorReady;

  useEffect(() => {
    const root = containerRef.current;
    if (!root || editorInstance) return;

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialContent ?? "");
        ctx.set(remarkPluginsCtx, [{ plugin: remarkBreaks, options: undefined as unknown as Record<string, unknown> }]);
        if (onChangeRef.current) {
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onChangeRef.current?.(markdown);
          });
        }
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(clipboard)
      .create()
      .then((editor) => {
        editorInstance = editor;
        onEditorReadyRef.current?.(editor);
      });

    return () => {
      onEditorReadyRef.current?.(null);
      editorInstance?.destroy();
      editorInstance = null;
    };
  }, [initialContent]);

  return <div ref={containerRef} className="milkdown-editor flex-1 overflow-auto px-6 py-4" />;
}

/** Get the current active editor instance (may be null). */
export function getEditorInstance(): Editor | null {
  return editorInstance;
}

export function setMarkdown(content: string): void {
  if (!editorInstance) return;
  editorInstance.action(replaceAll(content));
}

export function getHTML(): string {
  if (!editorInstance) return "";
  let html = "";
  editorInstance.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const div = document.createElement("div");
    const fragment = DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.content);
    div.appendChild(fragment);
    html = div.innerHTML;
  });
  return html;
}
