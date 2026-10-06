"use client";

import { useEffect, useRef } from "react";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewOptionsCtx,
  prosePluginsCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";

import "@milkdown/kit/prose/view/style/prosemirror.css";
import { cjkSpacingPlugin } from "./cjk-spacing";

interface MilkdownViewerProps {
  content: string;
}

export function MilkdownViewer({ content }: MilkdownViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    // create() is async: without `disposed` a content change tears down the
    // previous effect while its editor is still in flight, so the resolved
    // instance is never destroyed and keeps its DOM alive.
    let disposed = false;
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, content);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => false,
        }));
        ctx.update(prosePluginsCtx, (plugins) => [...plugins, cjkSpacingPlugin()]);
      })
      .use(commonmark)
      .use(gfm)
      .create()
      .then((editor) => {
        if (disposed) {
          editor.destroy();
          return;
        }
        editorRef.current = editor;
      });

    return () => {
      disposed = true;
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [content]);

  return <div ref={containerRef} className="content-preview-inner" />;
}
