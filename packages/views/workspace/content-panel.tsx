"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { Bot, FileText, FileAudio, Sparkles, List, X, Plus } from "../icons";
import { useWorkspaceStore } from "./store";
import { TAB_BAR_HEIGHT } from "./layout-constants";
import { api } from "@lynse/core/api/client";
import { SummaryMarkdownEditor } from "./summary-editor";
import { FloatingMarkdownToolbar } from "./center-panel/markdown-toolbar";
import { AudioPlayer } from "./audio-player";
import type { AudioPlayerHandle } from "./audio-player";
import { useFiles, useFileOutline, useFileConclusions, useFileTranscription, useFileAudioUrl, useUpdateConclusion } from "./hooks/use-files";
import { useTranslation } from "@lynse/core/i18n/react";
import "./content-preview.css";

function extractBody(html: string): { content: string; scopedStyles: string } {
  const styleBlocks: string[] = [];

  const headMatch = html.match(/<head[^>]*>([\s\S]*)<\/head>/i);
  if (headMatch?.[1]) {
    headMatch[1].replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
      styleBlocks.push(css);
      return "";
    });
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let content = bodyMatch?.[1] ? bodyMatch[1].trim() : html;

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

function scopeCss(css: string, scope: string): string {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const parts: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    while (i < cleaned.length && /\s/.test(cleaned[i] ?? "")) i++;
    if (i >= cleaned.length) break;
    if (cleaned[i] === "@") {
      const braceStart = cleaned.indexOf("{", i);
      if (braceStart === -1) break;
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

const SPEAKER_COLORS = [
  "var(--speaker-1)", "var(--speaker-2)", "var(--speaker-3)", "var(--speaker-4)",
  "var(--speaker-5)", "var(--speaker-6)", "var(--speaker-7)", "var(--speaker-8)",
];

function getSpeakerColor(name: string): string {
  if (!name) return SPEAKER_COLORS[0]!;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length]!;
}

const NOTE_STORAGE_PREFIX = "lynse_note_";

export function ContentPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const contentTab = useWorkspaceStore((s) => s.contentTab);
  const setContentTab = useWorkspaceStore((s) => s.setContentTab);
  const outlineSidebarVisible = useWorkspaceStore((s) => s.outlineSidebarVisible);
  const toggleOutlineSidebar = useWorkspaceStore((s) => s.toggleOutlineSidebar);
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);
  const noteTabs = useWorkspaceStore((s) => s.noteTabs);
  const addNoteTab = useWorkspaceStore((s) => s.addNoteTab);
  const removeNoteTab = useWorkspaceStore((s) => s.removeNoteTab);
  const { t } = useTranslation();

  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });
  const { data: outline, isLoading: outlineLoading } = useFileOutline(selectedItemId);
  const { data: conclusions, isLoading: conclusionsLoading } = useFileConclusions(selectedItemId);
  const { data: transcription, isLoading: transLoading } = useFileTranscription(selectedItemId);
  const { data: audioUrl } = useFileAudioUrl(selectedItemId);
  const updateConclusion = useUpdateConclusion();

  const audioPlayerRef = useRef<AudioPlayerHandle>(null);
  const [highlightTimeMs, setHighlightTimeMs] = useState<number | null>(null);
  const [summaryEditor, setSummaryEditor] = useState<import("@milkdown/kit/core").Editor | null>(null);

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

  // Conclusions — each FileConclusionVO has a `templateName` field for the conclusion template name
  const conclusionTexts = useMemo(() => {
    if (!Array.isArray(conclusions)) return [];
    return conclusions
      .map((c, i) => {
        const obj = c as Record<string, unknown>;
        const text = String(obj.conclusionText ?? "");
        const id = String(obj.id ?? "");
        // templateName is the conclusion template name from the API
        const name = String(obj.templateName ?? obj.conclusionName ?? obj.title ?? obj.name ?? "").trim();
        return text ? { key: i, text, id, name } : null;
      })
      .filter(Boolean) as { key: number; text: string; id: string; name: string }[];
  }, [conclusions]);

  // Outline
  const { outlineBody, outlineStyles } = useMemo(() => {
    const obj = outline as Record<string, unknown> | null;
    if (!obj?.outlineText) return { outlineBody: null, outlineStyles: "" };
    const raw = String(obj.outlineText);
    const { content, scopedStyles } = extractBody(raw);
    return { outlineBody: content, outlineStyles: scopedStyles };
  }, [outline]);

  // Transcription
  const transSegments = useMemo(() => {
    let records: unknown[] = [];
    if (Array.isArray(transcription)) {
      records = transcription;
    } else if (transcription && typeof transcription === "object") {
      const obj = transcription as Record<string, unknown>;
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

  // Headings
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

  // Debounced save for conclusion edits
  const conclusionSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const handleConclusionChange = useCallback((conclusionId: string, markdown: string) => {
    const existing = conclusionSaveTimers.current.get(conclusionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      updateConclusion.mutate({ conclusionId, conclusionText: markdown });
      conclusionSaveTimers.current.delete(conclusionId);
    }, 1500);
    conclusionSaveTimers.current.set(conclusionId, timer);
  }, [updateConclusion]);

  const scrollToHeading = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Post-render: replace <img> src with blob URLs for authenticated image loading
  const contentPreviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = contentPreviewRef.current;
    if (!root) return;
    const imgs = root.querySelectorAll<HTMLImageElement>("img");
    if (imgs.length === 0) return;

    let client: { backendUrl: string; token: string | null; apiKey: string | null } | null = null;
    try { client = api() as unknown as typeof client; } catch { return; }

    for (const img of imgs) {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("blob:") || src.startsWith("data:") || img.dataset.proxying) continue;
      img.dataset.proxying = "1";

      let proxyUrl: string;
      if (src.startsWith(client!.backendUrl)) {
        proxyUrl = "/api/proxy" + src.slice(client!.backendUrl.length);
      } else if (src.startsWith("/")) {
        proxyUrl = "/api/proxy" + src;
      } else {
        delete img.dataset.proxying;
        continue;
      }

      const headers: Record<string, string> = { "X-Lynse-Api-Url": client!.backendUrl };
      if (client!.token) headers["Authorization"] = client!.token;
      if (client!.apiKey) headers["X-API-Key"] = client!.apiKey;

      fetch(proxyUrl, { headers })
        .then((res) => res.ok ? res.blob() : null)
        .then((blob) => {
          if (blob) img.src = URL.createObjectURL(blob);
          delete img.dataset.proxying;
        })
        .catch(() => { delete img.dataset.proxying; });
    }
  }, [contentTab, outlineBody, conclusionTexts]);

  // Parse current tab
  const activeSummaryIdx = contentTab.startsWith("summary-") ? parseInt(contentTab.slice(8), 10) : -1;
  const activeNoteId = contentTab.startsWith("note-") ? contentTab.slice(5) : null;

  return (
    <div className="flex h-full flex-col min-w-0">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center border-b border-stroke-secondary px-4" style={{ height: TAB_BAR_HEIGHT }}>
        <div className="flex items-center gap-0.5 overflow-x-auto">
          <TabButton
            active={contentTab === "outline"}
            onClick={() => setContentTab("outline")}
          >
            <List className="size-3.5" />
            <span>{t("workspace.outline")}</span>
          </TabButton>
          <TabButton
            active={contentTab === "transcription"}
            onClick={() => setContentTab("transcription")}
          >
            <FileAudio className="size-3.5" />
            <span>{t("workspace.transcription")}</span>
          </TabButton>
          {conclusionTexts.map((block, idx) => (
            <TabButton
              key={block.key}
              active={contentTab === `summary-${idx}`}
              onClick={() => setContentTab(`summary-${idx}`)}
            >
              <Sparkles className="size-3.5" />
              <span>{block.name || t("workspace.summary")}</span>
            </TabButton>
          ))}
          {noteTabs.map((note) => (
            <TabButton
              key={note.id}
              active={contentTab === `note-${note.id}`}
              onClick={() => setContentTab(`note-${note.id}`)}
            >
              <span>{note.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeNoteTab(note.id); }}
                className="ml-0.5 rounded p-0.5 hover:bg-accent/50"
              >
                <X className="size-3" />
              </button>
            </TabButton>
          ))}
          <button
            onClick={addNoteTab}
            className="flex items-center justify-center rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
            title={t("workspace.notes")}
          >
            <Plus className="size-3.5" />
          </button>
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

      {/* Content area */}
      <div className="flex flex-1 min-h-0">
        <div className={`flex-1 min-w-0 ${contentTab === "transcription" ? "overflow-hidden" : "overflow-auto"}`}>
          {!selectedItemId ? (
            <EmptyState />
          ) : isLoading ? (
            <LoadingState />
          ) : (
            <div className={`px-6 py-6 ${contentTab === "transcription" ? "flex flex-col h-full" : ""}`}>
              <input
                type="text"
                value={displayTitle ?? ""}
                onChange={(e) => setEditedTitle(e.target.value)}
                placeholder={t("workspace.enter_filename")}
                className="w-full border-none bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground/50 shrink-0"
              />
              {selectedCreatedAt && (
                <div className="mt-1 text-[11px] text-muted-foreground shrink-0">
                  {formatDate(selectedCreatedAt)}
                </div>
              )}

              <div ref={contentPreviewRef} className={`content-preview mt-2 ${contentTab === "transcription" ? "flex flex-col flex-1 min-h-0" : ""}`}>
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

                {contentTab === "transcription" && (
                  <div className="flex flex-col flex-1 min-h-0 space-y-3">
                    {/* Audio player — always visible when audio URL exists */}
                    {audioUrl && (
                      <div className="shrink-0">
                        <AudioPlayer
                          ref={audioPlayerRef}
                          src={audioUrl as string}
                          highlightTimeMs={highlightTimeMs}
                        />
                      </div>
                    )}
                    {/* Transcription segments or empty state */}
                    {transSegments && transSegments.length > 0 ? (
                      <div className="flex-1 min-h-0 overflow-y-auto space-y-1 text-sm leading-relaxed pb-4">
                        {transSegments.map((seg, i) => {
                          const color = getSpeakerColor(seg.speaker);
                          return (
                            <button
                              key={i}
                              onClick={() => {
                                if (seg.beginTimeMs != null) setHighlightTimeMs(seg.beginTimeMs);
                              }}
                              className={`block w-full text-left rounded-md px-2 py-1.5 transition-colors ${
                                highlightTimeMs === seg.beginTimeMs && seg.beginTimeMs != null
                                  ? "bg-accent/60"
                                  : "hover:bg-accent/30"
                              } ${seg.beginTimeMs != null ? "cursor-pointer" : ""}`}
                            >
                              <div className="flex items-baseline gap-2">
                                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{seg.time}</span>
                                <span className="shrink-0 font-semibold text-xs" style={{ color }}>{seg.speaker}</span>
                              </div>
                              <p className="text-foreground mt-0.5">{seg.text}</p>
                            </button>
                          );
                        })}
                        <div className="mt-6 border-t border-border pt-3 text-center">
                          <p className="text-[10px] text-muted-foreground/60">{t("workspace.ai_disclaimer")}</p>
                        </div>
                      </div>
                    ) : (
                      <NoContentState label={t("workspace.no_transcription")} />
                    )}
                  </div>
                )}

                {/* Single summary tab */}
                {activeSummaryIdx >= 0 && conclusionTexts[activeSummaryIdx] && (() => {
                  const block = conclusionTexts[activeSummaryIdx]!;
                  return isHtmlContent(block.text) ? (() => {
                    const { content, scopedStyles } = extractBody(block.text);
                    return (
                      <>
                        {scopedStyles && <style dangerouslySetInnerHTML={{ __html: scopedStyles }} />}
                        <div className="content-preview-inner" dangerouslySetInnerHTML={{ __html: content }} />
                      </>
                    );
                  })() : (
                    <>
                      <SummaryMarkdownEditor
                        content={block.text}
                        onChange={(markdown) => handleConclusionChange(block.id, markdown)}
                        onEditorReady={setSummaryEditor}
                      />
                      <FloatingMarkdownToolbar editor={summaryEditor} />
                    </>
                  );
                })()}

                {/* Note tab */}
                {activeNoteId && (
                  <NoteContent key={activeNoteId} fileId={selectedItemId} noteId={activeNoteId} />
                )}
              </div>

              {contentTab !== "transcription" && (
                <div className="mt-8 border-t border-stroke-quaternary pt-3 text-center shrink-0">
                  <p className="text-[10px] text-muted-foreground/60">{t("workspace.ai_disclaimer")}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Floating outline sidebar */}
        {outlineSidebarVisible && contentTab === "outline" && selectedItemId && (
          <div className="w-52 shrink-0 border-l border-stroke-tertiary bg-background overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b border-stroke-tertiary">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("workspace.outline")}</span>
              <button onClick={toggleOutlineSidebar} className="text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            </div>
            <div className="p-2">
              {headings.map((h) => (
                <button
                  key={h.id}
                  onClick={() => scrollToHeading(h.id)}
                  className={`block w-full text-left rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors ${
                    h.tag === "H1" ? "font-semibold" : h.tag === "H2" ? "pl-3" : "pl-5"
                  }`}
                >
                  {h.text}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Separate component per note so each gets its own editor instance. */
function NoteContent({ fileId, noteId }: { fileId: string | null; noteId: string }) {
  const storageKey = `${NOTE_STORAGE_PREFIX}${fileId}_${noteId}`;
  const [content, setContent] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(storageKey) ?? "";
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback((markdown: string) => {
    setContent(markdown);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(storageKey, markdown);
    }, 500);
  }, [storageKey]);

  return <SummaryMarkdownEditor content={content} onChange={handleChange} />;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-accent-brand-strong text-accent-brand-text"
          : "text-muted-foreground hover:bg-accent-brand hover:text-foreground"
      }`}
    >
      {children}
    </button>
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
      <p className="mt-1 text-xs text-muted-foreground">{t("workspace.select_file_hint")}</p>
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
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return dateStr; }
}
