"use client";

import { useEffect, useRef } from "react";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewOptionsCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";

import "@milkdown/kit/prose/view/style/prosemirror.css";

interface MilkdownViewerProps {
  content: string;
}

export function MilkdownViewer({ content }: MilkdownViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, content);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => false,
        }));
      })
      .use(commonmark)
      .use(gfm)
      .create()
      .then((editor) => {
        editorRef.current = editor;
      });

    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [content]);

  return <div ref={containerRef} className="content-preview-inner" />;
}
