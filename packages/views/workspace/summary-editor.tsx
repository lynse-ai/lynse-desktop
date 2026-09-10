"use client";

import { useEffect, useMemo, useRef } from "react";
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

/** Backend templates occasionally prefix data URIs with a marker scheme
 *  ("mindmap:data:image/png;base64,...") that no browser can load. */
const BOGUS_DATA_URI_SCHEME = /^[a-z][a-z0-9+.-]*:data:image\//i;

/** Sanitize base64 image data URIs — strip bogus scheme prefixes and whitespace
 *  that would otherwise break markdown parsing. Kept as Markdown image syntax:
 *  Milkdown renders raw inline HTML as literal text (htmlSchema), only the
 *  image node produces a real <img>. */
function sanitizeBase64Images(markdown: string): string {
  // Walk each ![alt](url) and rewrite the URL when needed
  let result = "";
  let pos = 0;

  while (pos < markdown.length) {
    const imgStart = markdown.indexOf("![", pos);
    if (imgStart === -1) {
      result += markdown.slice(pos);
      break;
    }

    result += markdown.slice(pos, imgStart);

    // Parse ![alt](url)
    const altEnd = markdown.indexOf("](", imgStart + 2);
    if (altEnd === -1) {
      result += markdown.slice(imgStart);
      break;
    }

    const alt = markdown.slice(imgStart + 2, altEnd);
    const urlStart = altEnd + 2;

    // Find the matching closing paren — for data URIs, scan for the last ) on the line or after base64 data
    let urlEnd = urlStart;
    let parenDepth = 1;
    while (urlEnd < markdown.length && parenDepth > 0) {
      if (markdown[urlEnd] === "(") parenDepth++;
      else if (markdown[urlEnd] === ")") parenDepth--;
      if (parenDepth > 0) urlEnd++;
    }

    let url = markdown.slice(urlStart, urlEnd).trim();
    // Repair scheme-prefixed data URIs ("mindmap:data:image/png;...")
    url = url.replace(BOGUS_DATA_URI_SCHEME, "data:image/");
    // Base64 payloads may contain line wraps — remark truncates URLs at
    // whitespace, which would cut the image off mid-data.
    if (url.startsWith("data:image/")) {
      url = url.replace(/\s+/g, "");
    }

    result += `![${alt}](${url})`;

    pos = urlEnd + 1; // skip past the closing )
  }

  return result;
}

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

/** Scan an element for <img> tags and replace their src with authenticated blob URLs. Also fixes broken data: URIs. */
function proxyImages(root: HTMLElement) {
  const imgs = root.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    let src = img.getAttribute("src");
    if (!src || img.dataset.proxying) continue;

    // Repair scheme-prefixed data URIs that slipped through as raw HTML
    const normalizedSrc = src.replace(BOGUS_DATA_URI_SCHEME, "data:image/");
    if (normalizedSrc !== src) {
      img.src = normalizedSrc;
      src = normalizedSrc;
    }

    // Fix data: URIs that might have whitespace
    if (src.startsWith("data:image/")) {
      const commaIdx = src.indexOf(",");
      if (commaIdx > -1) {
        const prefix = src.slice(0, commaIdx + 1);
        const b64data = src.slice(commaIdx + 1);
        const cleaned = b64data.replace(/\s+/g, "");
        if (cleaned !== b64data) {
          img.src = `${prefix}${cleaned}`;
        }
      }
      continue;
    }

    if (src.startsWith("blob:")) continue;
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

  // Sanitize base64 images in content to prevent parsing issues
  const sanitizedContent = useMemo(() => sanitizeBase64Images(content), [content]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    let currentMarkdown = "";
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const serializer = ctx.get(serializerCtx);
      currentMarkdown = serializer(view.state.doc);
    });

    if (currentMarkdown !== sanitizedContent) {
      isInternalUpdate.current = true;
      editor.action(replaceAll(sanitizedContent));
      requestAnimationFrame(() => {
        isInternalUpdate.current = false;
      });
    }
  }, [sanitizedContent]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, sanitizedContent);
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
