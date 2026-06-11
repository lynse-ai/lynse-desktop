"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { Bot, FileText, FileAudio, Sparkles, List, X } from "../icons";
import { useWorkspaceStore } from "./store";
import { MilkdownViewer } from "./milkdown-viewer";
import { AudioPlayer } from "./audio-player";
import type { AudioPlayerHandle } from "./audio-player";
import { useFiles, useFileOutline, useFileConclusions, useFileTranscription, useFileAudioUrl } from "./hooks/use-files";
import { api } from "@lynse/core/api/client";
import { useTranslation } from "@lynse/core/i18n/react";
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

/** Distinct colors for different speakers — cycles if more speakers than colors. */
const SPEAKER_COLORS = [
  "#4A90E2", // blue
  "#50C878", // green
  "#E67E22", // orange
  "#9B59B6", // purple
  "#E74C3C", // red
  "#1ABC9C", // teal
  "#F39C12", // amber
  "#2980B9", // dark blue
];

/** Simple hash to consistently assign a color to a speaker name. */
function getSpeakerColor(name: string): string {
  if (!name) return SPEAKER_COLORS[0]!;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length]!;
}

export function ContentPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const contentTab = useWorkspaceStore((s) => s.contentTab);
  const setContentTab = useWorkspaceStore((s) => s.setContentTab);
  const outlineSidebarVisible = useWorkspaceStore((s) => s.outlineSidebarVisible);
  const toggleOutlineSidebar = useWorkspaceStore((s) => s.toggleOutlineSidebar);
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);
  const { t } = useTranslation();

  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });
  const { data: outline, isLoading: outlineLoading, error: outlineError } = useFileOutline(selectedItemId);
  const { data: conclusions, isLoading: conclusionsLoading, error: conclusionsError } = useFileConclusions(selectedItemId);
  const { data: transcription, isLoading: transLoading, error: transError } = useFileTranscription(selectedItemId);
  const { data: audioUrl } = useFileAudioUrl(selectedItemId);

  // Debug: log all data
  console.log("[content-panel] selectedItemId:", selectedItemId);
  console.log("[content-panel] outline:", outline, "loading:", outlineLoading, "error:", outlineError);
  console.log("[content-panel] conclusions:", conclusions, "loading:", conclusionsLoading, "error:", conclusionsError);
  console.log("[content-panel] transcription:", transcription, "loading:", transLoading, "error:", transError);

  // Debug: check API client
  try {
    console.log("[content-panel] api client:", !!api());
  } catch (e) {
    console.log("[content-panel] api client NOT initialized:", e);
  }

  // Debug: test API endpoints directly
  useEffect(() => {
    if (!selectedItemId) return;
    const testApis = async () => {
      try {
        const outlineRes = await api().getWithParams("/api/business/file/outline/get", { fileId: selectedItemId });
        console.log("[debug-api] outline response:", JSON.stringify(outlineRes).slice(0, 200));
      } catch (e) {
        console.log("[debug-api] outline ERROR:", e);
      }
      try {
        const transRes = await api().getWithParams("/api/business/file/trans/get", { fileId: selectedItemId });
        console.log("[debug-api] trans response:", JSON.stringify(transRes).slice(0, 200));
      } catch (e) {
        console.log("[debug-api] trans ERROR:", e);
      }
    };
    testApis();
  }, [selectedItemId]);
  const audioPlayerRef = useRef<AudioPlayerHandle>(null);
  const [highlightTimeMs, setHighlightTimeMs] = useState<number | null>(null);

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
    // API may return an array directly, or an object with a nested records array
    let records: unknown[] = [];
    if (Array.isArray(transcription)) {
      records = transcription;
    } else if (transcription && typeof transcription === "object") {
      const obj = transcription as Record<string, unknown>;
      // Try common nested array keys
      for (const key of ["records", "list", "data", "transcriptionRecords", "segments"]) {
        const arr = obj[key];
        if (Array.isArray(arr) && arr.length > 0) {
          records = arr;
          break;
        }
      }
    }
    if (records.length === 0) return null;
    return records.map((seg) => {
      const s = seg as Record<string, unknown>;
      return {
        speaker: String(s.speakerName ?? ""),
        time: String(s.beginTimeStr ?? ""),
        text: String(s.text ?? ""),
        beginTimeMs: typeof s.beginTime === "number" ? s.beginTime : null,
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
            <span>{t("workspace.outline")}</span>
          </TabButton>
          <TabButton
            active={contentTab === "summary"}
            onClick={() => setContentTab("summary")}
          >
            <Sparkles className="size-3.5" />
            <span>{t("workspace.summary")}</span>
          </TabButton>
          <TabButton
            active={contentTab === "transcription"}
            onClick={() => setContentTab("transcription")}
          >
            <FileAudio className="size-3.5" />
            <span>{t("workspace.transcription")}</span>
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
              title={t("workspace.toggle_outline")}
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
            title={t("workspace.ask_ai")}
          >
            <Bot className="size-3.5" />
            <span>{t("workspace.ask_ai")}</span>
          </button>
        </div>
      </div>

      {/* Content area with optional outline sidebar */}
      <div className="flex flex-1 min-h-0">
        {/* Main content */}
        <div className={`flex-1 min-w-0 ${contentTab === "transcription" ? "overflow-hidden" : "overflow-auto"}`}>
          {!selectedItemId ? (
            <EmptyState />
          ) : isLoading ? (
            <LoadingState />
          ) : (
            <div className={`px-6 py-6 ${contentTab === "transcription" ? "flex flex-col h-full" : ""}`}>
              {/* Title */}
              <input
                type="text"
                value={displayTitle ?? ""}
                onChange={(e) => setEditedTitle(e.target.value)}
                placeholder={t("workspace.enter_filename")}
                className="w-full border-none bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground/50 shrink-0"
              />

              {/* Metadata */}
              {selectedCreatedAt && (
                <div className="mt-1 text-[11px] text-muted-foreground shrink-0">
                  {formatDate(selectedCreatedAt)}
                </div>
              )}

              {/* Tab content */}
              <div className={`content-preview mt-2 ${contentTab === "transcription" ? "flex flex-col flex-1 min-h-0" : ""}`}>
                {/* Scoped styles extracted from HTML — only apply inside .content-preview-inner */}
                {outlineStyles && contentTab === "outline" && (
                  <style dangerouslySetInnerHTML={{ __html: outlineStyles }} />
                )}

                {contentTab === "outline" && (
                  outlineBody ? (
                    <div className="content-preview-inner" dangerouslySetInnerHTML={{ __html: outlineBody }} />
                  ) : (
                    <NoContentState label={t("workspace.no_outline")} />
                  )
                )}

                {contentTab === "summary" && (
                  conclusionTexts.length > 0 ? (
                    <div className="space-y-6">
                      {conclusionTexts.map((block, i) => (
                        <div key={block.key}>
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
                    <NoContentState label={t("workspace.no_summary")} />
                  )
                )}

                {contentTab === "transcription" && (
                  transSegments && transSegments.length > 0 ? (
                    <div className="flex flex-col flex-1 min-h-0 space-y-3">
                      {/* Audio Player — fixed at top */}
                      {audioUrl && (
                        <div className="shrink-0">
                          <AudioPlayer
                            ref={audioPlayerRef}
                            src={audioUrl as string}
                            highlightTimeMs={highlightTimeMs}
                          />
                        </div>
                      )}
                      {/* Transcript segments — scrollable */}
                      <div className="flex-1 min-h-0 overflow-y-auto space-y-1 text-sm leading-relaxed pb-4">
                        {transSegments.map((seg, i) => {
                          const color = getSpeakerColor(seg.speaker);
                          return (
                            <button
                              key={i}
                              onClick={() => {
                                if (seg.beginTimeMs != null) {
                                  setHighlightTimeMs(seg.beginTimeMs);
                                }
                              }}
                              className={`block w-full text-left rounded-md px-2 py-1.5 transition-colors ${
                                highlightTimeMs === seg.beginTimeMs && seg.beginTimeMs != null
                                  ? "bg-accent/60"
                                  : "hover:bg-accent/30"
                              } ${seg.beginTimeMs != null ? "cursor-pointer" : ""}`}
                              title={seg.beginTimeMs != null ? "Click to jump to this time" : undefined}
                            >
                              <div className="flex items-baseline gap-2">
                                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                                  {seg.time}
                                </span>
                                <span
                                  className="shrink-0 font-semibold text-xs"
                                  style={{ color }}
                                >
                                  {seg.speaker}
                                </span>
                              </div>
                              <p className="text-foreground mt-0.5">{seg.text}</p>
                            </button>
                          );
                        })}
                        {/* Disclaimer at bottom of scrollable area */}
                        <div className="mt-6 border-t border-border pt-3 text-center">
                          <p className="text-[10px] text-muted-foreground/60">
                            {t("workspace.ai_disclaimer")}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <NoContentState label={t("workspace.no_transcription")} />
                  )
                )}
              </div>

              {/* AI Disclaimer — only shown in non-transcription tabs */}
              {contentTab !== "transcription" && (
              <div className="mt-8 border-t border-border pt-3 text-center shrink-0">
                <p className="text-[10px] text-muted-foreground/60">
                  {t("workspace.ai_disclaimer")}
                </p>
              </div>
              )}
            </div>
          )}
        </div>

        {/* Floating outline sidebar */}
        {outlineSidebarVisible && contentTab === "outline" && selectedItemId && (
          <div className="w-52 shrink-0 border-l border-border bg-background overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("workspace.outline")}
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
                  {t("workspace.no_headings")}
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
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
        <FileText className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium">{t("workspace.no_file_selected")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("workspace.select_file_hint")}
      </p>
    </div>
  );
}

function LoadingState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-xs text-muted-foreground">{t("workspace.loading")}</p>
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
