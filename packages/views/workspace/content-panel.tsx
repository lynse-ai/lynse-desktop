"use client";

import { useMemo, useState, useCallback } from "react";
import { Bot, FileText, Sparkles, List, X } from "lucide-react";
import { useWorkspaceStore } from "./store";
import { MilkdownViewer } from "./milkdown-viewer";
import { useFiles, useFileOutline, useFileConclusions, useFileTranscription } from "./hooks/use-files";
import "./content-preview.css";

function extractBody(html: string): { content: string; scopedStyles: string } {
  const styleBlocks: string[] = [];

  // Extract <style> from <head> first (full doc only)
  const headMatch = html.match(/<head[^>]*>([\s\S]*)<\/head>/i);
  if (headMatch?.[1]) {
    headMatch[1].replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
      styleBlocks.push(css);
      return "";
    });
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let content = bodyMatch?.[1] ? bodyMatch[1].trim() : html;

  // Extract <style> from body content
  content = content.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    styleBlocks.push(css);
    return "";
  });
  content = content.replace(/<link[^>]*rel=["']stylesheet["'][^>]*\/?>/gi, "");

  let scopedStyles = "";
  if (styleBlocks.length > 0) {
    const rawCss = styleBlocks.join("\n");
    scopedStyles = scopeCss(rawCss, ".content-preview-inner");
  }

  return { content, scopedStyles };
}

/** Prefix every CSS selector with the given scope. */
function scopeCss(css: string, scope: string): string {
  // Remove CSS comments
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // Split into rule blocks, preserving @-rules as-is
  const parts: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    // Skip whitespace
    while (i < cleaned.length && /\s/.test(cleaned[i] ?? "")) i++;
    if (i >= cleaned.length) break;

    // @-rules: keep as-is
    if (cleaned[i] === "@") {
      const braceStart = cleaned.indexOf("{", i);
      if (braceStart === -1) break;
      // Find matching closing brace
      let depth = 1;
      let j = braceStart + 1;
      while (j < cleaned.length && depth > 0) {
        if (cleaned[j] === "{") depth++;
        else if (cleaned[j] === "}") depth--;
        j++;
      }
      parts.push(cleaned.slice(i, j));
      i = j;
      continue;
    }

    // Regular rule: selector { ... }
    const braceStart = cleaned.indexOf("{", i);
    if (braceStart === -1) break;
    const selectorStr = cleaned.slice(i, braceStart).trim();
    let depth = 1;
    let j = braceStart + 1;
    while (j < cleaned.length && depth > 0) {
      if (cleaned[j] === "{") depth++;
      else if (cleaned[j] === "}") depth--;
      j++;
    }
    const body = cleaned.slice(braceStart, j);
    const scopedSelectors = selectorStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        // Top-level selectors should BE the scope, not descendants
        if (/^(html|body|:root|\*)$/.test(s)) return scope;
        return `${scope} ${s}`;
      })
      .join(", ");
    parts.push(`${scopedSelectors} ${body}`);
    i = j;
  }

  return parts.join("\n");
}

function isHtmlContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<") && /<\/\w+>/.test(trimmed);
}

export function ContentPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const contentTab = useWorkspaceStore((s) => s.contentTab);
  const setContentTab = useWorkspaceStore((s) => s.setContentTab);
  const outlineSidebarVisible = useWorkspaceStore((s) => s.outlineSidebarVisible);
  const toggleOutlineSidebar = useWorkspaceStore((s) => s.toggleOutlineSidebar);
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);

  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });
  const { data: outline, isLoading: outlineLoading } = useFileOutline(selectedItemId);
  const { data: conclusions, isLoading: conclusionsLoading } = useFileConclusions(selectedItemId);
  const { data: transcription, isLoading: transLoading } = useFileTranscription(selectedItemId);

  const selectedTitle = useMemo(() => {
    if (!selectedItemId || !files) return null;
    return files.find((f) => f.id === selectedItemId)?.title ?? null;
  }, [selectedItemId, files]);

  const selectedCreatedAt = useMemo(() => {
    if (!selectedItemId || !files) return null;
    return files.find((f) => f.id === selectedItemId)?.createdAt ?? null;
  }, [selectedItemId, files]);

  const [editedTitle, setEditedTitle] = useState<string | null>(null);
  const displayTitle = editedTitle ?? selectedTitle;

  // Outline: always full HTML doc → extract <body>
  const { outlineBody, outlineStyles } = useMemo(() => {
    const obj = outline as Record<string, unknown> | null;
    if (!obj?.outlineText) return { outlineBody: null, outlineStyles: "" };
    const raw = String(obj.outlineText);
    const { content, scopedStyles } = extractBody(raw);
    return { outlineBody: content, outlineStyles: scopedStyles };
  }, [outline]);

  // Conclusions: plain Markdown text from backend
  const conclusionTexts = useMemo(() => {
    if (!Array.isArray(conclusions)) return [];
    return conclusions
      .map((c, i) => {
        const text = String((c as Record<string, unknown>).conclusionText ?? "");
        return text ? { key: i, text } : null;
      })
      .filter(Boolean) as { key: number; text: string }[];
  }, [conclusions]);

  // Transcription: speaker segments
  const transSegments = useMemo(() => {
    if (!Array.isArray(transcription) || transcription.length === 0) return null;
    return transcription.map((seg) => {
      const s = seg as Record<string, unknown>;
      return {
        speaker: String(s.speakerName ?? ""),
        time: String(s.beginTimeStr ?? ""),
        text: String(s.text ?? ""),
      };
    });
  }, [transcription]);

  // Extract headings from outline for the outline sidebar
  const headings = useMemo(() => {
    if (!outlineBody) return [];
    const div = typeof document !== "undefined" ? document.createElement("div") : null;
    if (!div) return [];
    div.innerHTML = outlineBody;
    const found: { tag: string; text: string; id: string }[] = [];
    div.querySelectorAll("h1, h2, h3, h4").forEach((el, i) => {
      const id = `heading-${i}`;
      el.id = id;
      found.push({ tag: el.tagName, text: el.textContent ?? "", id });
    });
    return found;
  }, [outlineBody]);

  const isLoading = outlineLoading || conclusionsLoading || transLoading;

  const scrollToHeading = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="flex h-full flex-col min-w-0">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center border-b border-border px-4" style={{ height: 42 }}>
        <div className="flex items-center gap-0.5">
          <TabButton
            active={contentTab === "outline"}
            onClick={() => setContentTab("outline")}
          >
            <List className="size-3.5" />
            <span>Outline</span>
          </TabButton>
          <TabButton
            active={contentTab === "summary"}
            onClick={() => setContentTab("summary")}
          >
            <Sparkles className="size-3.5" />
            <span>Summary</span>
          </TabButton>
          <TabButton
            active={contentTab === "transcription"}
            onClick={() => setContentTab("transcription")}
          >
            <FileText className="size-3.5" />
            <span>Transcription</span>
          </TabButton>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          {outlineBody && headings.length > 0 && contentTab === "outline" && (
            <button
              onClick={toggleOutlineSidebar}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                outlineSidebarVisible
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              }`}
              title="Toggle outline sidebar"
            >
              <List className="size-3" />
            </button>
          )}
          <button
            onClick={toggleChatPanel}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              chatPanelVisible
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
            title="Ask AI"
          >
            <Bot className="size-3.5" />
            <span>Ask AI</span>
          </button>
        </div>
      </div>

      {/* Content area with optional outline sidebar */}
      <div className="flex flex-1 min-h-0">
        {/* Main content */}
        <div className="flex-1 min-w-0 overflow-auto">
          {!selectedItemId ? (
            <EmptyState />
          ) : isLoading ? (
            <LoadingState />
          ) : (
            <div className="px-6 py-6">
              {/* Title */}
              <input
                type="text"
                value={displayTitle ?? ""}
                onChange={(e) => setEditedTitle(e.target.value)}
                placeholder="Enter file name..."
                className="w-full border-none bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground/50"
              />

              {/* Metadata */}
              {selectedCreatedAt && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {formatDate(selectedCreatedAt)}
                </div>
              )}

              {/* Tab content */}
              <div className="content-preview mt-4">
                {/* Scoped styles extracted from HTML — only apply inside .content-preview-inner */}
                {outlineStyles && contentTab === "outline" && (
                  <style dangerouslySetInnerHTML={{ __html: outlineStyles }} />
                )}

                {contentTab === "outline" && (
                  outlineBody ? (
                    <div className="content-preview-inner" dangerouslySetInnerHTML={{ __html: outlineBody }} />
                  ) : (
                    <NoContentState label="No outline available" />
                  )
                )}

                {contentTab === "summary" && (
                  conclusionTexts.length > 0 ? (
                    <div className="space-y-6">
                      {conclusionTexts.map((block, i) => (
                        <div key={block.key}>
                          <SectionLabel>Conclusion {conclusionTexts.length > 1 ? i + 1 : ""}</SectionLabel>
                          {isHtmlContent(block.text) ? (
                            (() => {
                              const { content, scopedStyles } = extractBody(block.text);
                              return (
                                <>
                                  {scopedStyles && <style dangerouslySetInnerHTML={{ __html: scopedStyles }} />}
                                  <div className="content-preview-inner" dangerouslySetInnerHTML={{ __html: content }} />
                                </>
                              );
                            })()
                          ) : (
                            <MilkdownViewer content={block.text} />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <NoContentState label="No summary available" />
                  )
                )}

                {contentTab === "transcription" && (
                  transSegments && transSegments.length > 0 ? (
                    <div className="space-y-1 text-sm leading-relaxed">
                      {transSegments.map((seg, i) => (
                        <div key={i} className="flex gap-2">
                          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums pt-px w-14 text-right">
                            {seg.time}
                          </span>
                          <span className="shrink-0 font-medium text-primary text-xs pt-px w-20 truncate">
                            {seg.speaker}
                          </span>
                          <span className="text-foreground">{seg.text}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <NoContentState label="No transcription available" />
                  )
                )}
              </div>

              {/* AI Disclaimer */}
              <div className="mt-8 border-t border-border pt-3 text-center">
                <p className="text-[10px] text-muted-foreground/60">
                  Content generated by AI, for reference only
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Floating outline sidebar */}
        {outlineSidebarVisible && contentTab === "outline" && selectedItemId && (
          <div className="w-52 shrink-0 border-l border-border bg-background overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Outline
              </span>
              <button
                onClick={toggleOutlineSidebar}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
            <div className="p-2">
              {headings.map((h) => (
                <button
                  key={h.id}
                  onClick={() => scrollToHeading(h.id)}
                  className={`block w-full text-left rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors ${
                    h.tag === "H1" ? "font-semibold" :
                    h.tag === "H2" ? "pl-3" :
                    "pl-5"
                  }`}
                >
                  {h.text}
                </button>
              ))}
              {headings.length === 0 && (
                <p className="px-2 py-3 text-[11px] text-muted-foreground">
                  No headings found
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 inline-block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
        <FileText className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium">No file selected</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Select a file from the sidebar to view its content
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-xs text-muted-foreground">Loading content...</p>
    </div>
  );
}

function NoContentState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return dateStr;
  }
}
