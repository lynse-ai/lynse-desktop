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
        editorRef.current = editor;
      });

    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [content]);

  return <div ref={containerRef} className="content-preview-inner" />;
}
