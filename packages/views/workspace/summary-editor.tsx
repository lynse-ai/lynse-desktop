"use client";

import { useEffect, useRef } from "react";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewOptionsCtx,
  editorViewCtx,
  serializerCtx,
  remarkPluginsCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { replaceAll } from "@milkdown/kit/utils";
import remarkBreaks from "remark-breaks";
import { api } from "@lynse/core/api/client";

import "@milkdown/kit/prose/view/style/prosemirror.css";

const PROXY_PREFIX = "/api/proxy";

/** Fetch an image through the authenticated proxy and return a blob URL. */
async function fetchImageAsBlob(src: string): Promise<string> {
  try {
    const client = api() as unknown as {
      backendUrl: string;
      token: string | null;
      apiKey: string | null;
    };
    const { backendUrl, token, apiKey } = client;

    // Build proxy URL
    let proxyUrl: string;
    if (src.startsWith(backendUrl)) {
      proxyUrl = PROXY_PREFIX + src.slice(backendUrl.length);
    } else if (src.startsWith("/")) {
      proxyUrl = PROXY_PREFIX + src;
    } else if (src.startsWith("http")) {
      // External URL — try direct fetch, no proxy
      const res = await fetch(src, { mode: "cors" });
      if (!res.ok) return src;
      return URL.createObjectURL(await res.blob());
    } else {
      return src;
    }

    // Fetch through proxy with auth headers
    const headers: Record<string, string> = {
      "X-Lynse-Api-Url": backendUrl,
    };
    if (token) headers["Authorization"] = token;
    if (apiKey) headers["X-API-Key"] = apiKey;

    const res = await fetch(proxyUrl, { headers });
    if (!res.ok) return src;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return src;
  }
}

/** Scan an element for <img> tags and replace their src with authenticated blob URLs. */
function proxyImages(root: HTMLElement) {
  const imgs = root.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("blob:") || src.startsWith("data:") || img.dataset.proxying) continue;
    img.dataset.proxying = "1";
    fetchImageAsBlob(src).then((blobUrl) => {
      if (blobUrl !== src) img.src = blobUrl;
      delete img.dataset.proxying;
    });
  }
}

interface SummaryMarkdownEditorProps {
  content: string;
  onChange?: (markdown: string) => void;
  /** Called when the internal editor instance is ready or destroyed. */
  onEditorReady?: (editor: Editor | null) => void;
}

export function SummaryMarkdownEditor({ content, onChange, onEditorReady }: SummaryMarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  const onEditorReadyRef = useRef(onEditorReady);
  const isInternalUpdate = useRef(false);

  onChangeRef.current = onChange;
  onEditorReadyRef.current = onEditorReady;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    let currentMarkdown = "";
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const serializer = ctx.get(serializerCtx);
      currentMarkdown = serializer(view.state.doc);
    });

    if (currentMarkdown !== content) {
      isInternalUpdate.current = true;
      editor.action(replaceAll(content));
      requestAnimationFrame(() => {
        isInternalUpdate.current = false;
      });
    }
  }, [content]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, content);
        ctx.set(remarkPluginsCtx, [{ plugin: remarkBreaks, options: undefined as unknown as Record<string, unknown> }]);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => true,
        }));
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          if (!isInternalUpdate.current) {
            onChangeRef.current?.(markdown);
          }
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(clipboard)
      .create()
      .then((editor) => {
        editorRef.current = editor;
        onEditorReadyRef.current?.(editor);
        requestAnimationFrame(() => proxyImages(root));
      });

    return () => {
      onEditorReadyRef.current?.(null);
      editorRef.current?.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Observe DOM mutations to proxy newly rendered images
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const observer = new MutationObserver(() => proxyImages(root));
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="summary-editor content-preview-inner"
    />
  );
}
