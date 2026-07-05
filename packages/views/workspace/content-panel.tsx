"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  ChevronDown,
  FileText,
  FileAudio,
  Sparkles,
  List,
  MoreHorizontal,
  X,
  Plus,
  RefreshCw,
  Loader2,
  Trash2,
} from "../icons";
import { useWorkspaceStore } from "./store";
import { TAB_BAR_HEIGHT } from "./layout-constants";
import { api } from "@lynse/core/api/client";
import { SummaryMarkdownEditor } from "./summary-editor";
import { FloatingMarkdownToolbar } from "./center-panel/markdown-toolbar";
import { AudioPlayer } from "./audio-player";
import type { AudioPlayerHandle } from "./audio-player";
import { getDisplayTitle, type EditedTitleState } from "./title-edit-state";
import {
  mergePendingSummaryTab,
  useDeleteConclusion,
  useFiles,
  useFileOutline,
  useFileConclusions,
  useFileTranscription,
  useFileAudioUrl,
  useUpdateConclusion,
} from "./hooks/use-files";
import type { SummaryTabModel } from "./hooks/use-files";
import { useTranslation } from "@lynse/core/i18n/react";
import { useQueryClient } from "@tanstack/react-query";
import { ResummarizeDialog, type SummaryTemplateDialogMode } from "./resummarize-dialog";
import {
  getDesktopLocalTranscriptionApi,
  isLocalFileId,
} from "./local-transcription";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
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

  // Desktop override: neutralize mobile-first fixed widths from backend templates
  // Also strip borders/backgrounds that leaked from body/html scoping
  const desktopOverride = `
.content-preview-inner {
  border: none !important;
  background: transparent !important;
  padding: 0 !important;
  margin: 0 !important;
}
.content-preview-inner,
.content-preview-inner > *,
.content-preview-inner * {
  max-width: 100% !important;
}
.content-preview-inner img {
  max-width: 100% !important;
  height: auto !important;
}
.content-preview-inner table {
  width: 100% !important;
  table-layout: auto !important;
}
`;
  scopedStyles += desktopOverride;

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
      const atHeader = cleaned.slice(i, braceStart).trim();
      const atBody = cleaned.slice(braceStart + 1, j - 1);

      // Strip @page rules (page-specific styles should not leak)
      if (/^@page\b/i.test(atHeader)) {
        i = j;
        continue;
      }

      // Recursively scope selectors inside @media blocks
      if (/^@media\b/i.test(atHeader)) {
        const scopedInner = scopeCss(atBody, scope);
        parts.push(`${atHeader} { ${scopedInner} }`);
        i = j;
        continue;
      }

      // Pass through @keyframes, @supports, etc. as-is
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
        // Replace global selectors with scope
        if (/^(html|body|:root|\*)$/.test(s)) return scope;
        // Scope each selector
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

const SUMMARY_TAB_FALLBACK_TEXT = {
  en: {
    replaceTemplate: "Change summary template",
    delete: "Delete summary",
    deleteConfirm: "Delete this summary permanently?",
  },
  "zh-Hans": {
    replaceTemplate: "更换总结模板",
    delete: "删除总结",
    deleteConfirm: "永久删除这条总结？",
  },
  ja: {
    replaceTemplate: "要約テンプレートを変更",
    delete: "要約を削除",
    deleteConfirm: "この要約を完全に削除しますか？",
  },
} as const;

function getSummaryTabFallbackLanguage(language: string | undefined): keyof typeof SUMMARY_TAB_FALLBACK_TEXT {
  if (language?.startsWith("zh")) return "zh-Hans";
  if (language?.startsWith("ja")) return "ja";
  return "en";
}

export function ContentPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const contentTab = useWorkspaceStore((s) => s.contentTab);
  const setContentTab = useWorkspaceStore((s) => s.setContentTab);
  const outlineSidebarVisible = useWorkspaceStore((s) => s.outlineSidebarVisible);
  const toggleOutlineSidebar = useWorkspaceStore((s) => s.toggleOutlineSidebar);
  const sourceViewVisible = useWorkspaceStore((s) => s.sourceViewVisible);
  const noteTabs = useWorkspaceStore((s) => s.noteTabs);
  const removeNoteTab = useWorkspaceStore((s) => s.removeNoteTab);
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const summarizingFileIds = useWorkspaceStore((s) => s.summarizingFileIds);
  const setFileSummarizing = useWorkspaceStore((s) => s.setFileSummarizing);
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const summaryTabFallback = SUMMARY_TAB_FALLBACK_TEXT[getSummaryTabFallbackLanguage(i18n.language)];
  const text = useCallback(
    (key: string, fallbackValue: string) => {
      const translated = t(key);
      return translated === key ? fallbackValue : translated;
    },
    [t],
  );

  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });
  const { data: outline, isLoading: outlineLoading } = useFileOutline(selectedItemId);
  const { data: conclusions, isLoading: conclusionsLoading } = useFileConclusions(selectedItemId);
  const { data: transcription, isLoading: transLoading } = useFileTranscription(selectedItemId);
  const { data: audioUrl } = useFileAudioUrl(selectedItemId);
  const updateConclusion = useUpdateConclusion();
  const deleteConclusion = useDeleteConclusion();

  const audioPlayerRef = useRef<AudioPlayerHandle>(null);
  const [highlightTimeMs, setHighlightTimeMs] = useState<number | null>(null);
  const [summaryEditor, setSummaryEditor] = useState<import("@milkdown/kit/core").Editor | null>(null);
  const [resummarizeOpen, setResummarizeOpen] = useState(false);
  const [summaryDialogMode, setSummaryDialogMode] = useState<SummaryTemplateDialogMode>("add");
  const [selectedConclusionIdForTemplate, setSelectedConclusionIdForTemplate] = useState<string | null>(null);
  const [resummaryErrorFileId, setResummaryErrorFileId] = useState<string | null>(null);
  const [clearedSummaryFileIds, setClearedSummaryFileIds] = useState<Set<string>>(() => new Set());
  const [pendingSummaryTabsByFile, setPendingSummaryTabsByFile] = useState<Record<string, SummaryTabModel[]>>({});
  const summaryCountBeforeResummary = useRef(0);

  const selectedTitle = useMemo(() => {
    if (!selectedItemId || !files) return null;
    return files.find((f) => f.id === selectedItemId)?.title ?? null;
  }, [selectedItemId, files]);

  const selectedFile = useMemo(() => {
    if (!selectedItemId || !files) return null;
    return files.find((f) => f.id === selectedItemId) ?? null;
  }, [selectedItemId, files]);

  const isLocalSelectedItem = isLocalFileId(selectedItemId);
  const localStatusTag = selectedFile?.tags?.find((tag) => ["排队中", "转写中", "失败", "已完成"].includes(tag));

  const selectedCreatedAt = useMemo(() => {
    if (!selectedItemId || !files) return null;
    return files.find((f) => f.id === selectedItemId)?.createdAt ?? null;
  }, [selectedItemId, files]);

  const [editedTitle, setEditedTitle] = useState<EditedTitleState | null>(null);
  const displayTitle = getDisplayTitle(selectedItemId, selectedTitle, editedTitle);

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
        return text ? { key: id || `summary-${i}`, text, id, name, status: "ready" as const } : null;
      })
      .filter(Boolean) as SummaryTabModel[];
  }, [conclusions]);
  const currentFileSummariesCleared = !!selectedItemId && clearedSummaryFileIds.has(selectedItemId);
  const pendingSummaryTabs = selectedItemId ? (pendingSummaryTabsByFile[selectedItemId] ?? []) : [];
  const visibleConclusionTexts = currentFileSummariesCleared ? [] : [...conclusionTexts, ...pendingSummaryTabs];

  useEffect(() => {
    if (!selectedItemId || pendingSummaryTabs.length === 0 || conclusionTexts.length === 0) return;
    const conclusionIds = new Set(conclusionTexts.map((tab) => tab.id).filter(Boolean));
    const nextPendingTabs = pendingSummaryTabs.filter((tab) => !tab.id || !conclusionIds.has(tab.id));
    if (nextPendingTabs.length === pendingSummaryTabs.length) return;
    setPendingSummaryTabsByFile((current) => ({ ...current, [selectedItemId]: nextPendingTabs }));
  }, [conclusionTexts, pendingSummaryTabs, selectedItemId]);

  // Outline — keep raw text for source view
  const { outlineBody, outlineStyles, outlineRaw } = useMemo(() => {
    const obj = outline as Record<string, unknown> | null;
    if (!obj?.outlineText) return { outlineBody: null, outlineStyles: "", outlineRaw: null };
    const raw = String(obj.outlineText);
    const { content, scopedStyles } = extractBody(raw);
    return { outlineBody: content, outlineStyles: scopedStyles, outlineRaw: raw };
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
        id: String(s.id ?? ""),
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

  const refreshLocalQueries = useCallback((fileId?: string | null) => {
    qc.invalidateQueries({ queryKey: ["files"] });
    if (fileId) {
      qc.invalidateQueries({ queryKey: ["file-transcription", fileId] });
      qc.invalidateQueries({ queryKey: ["file-audio-url", fileId] });
    }
  }, [qc]);

  const handleRetryLocalTranscription = useCallback(async () => {
    if (!selectedItemId) return;
    await getDesktopLocalTranscriptionApi()?.retry(selectedItemId);
    refreshLocalQueries(selectedItemId);
  }, [refreshLocalQueries, selectedItemId]);

  const handleDeleteLocalTranscription = useCallback(async () => {
    if (!selectedItemId) return;
    await getDesktopLocalTranscriptionApi()?.delete(selectedItemId);
    refreshLocalQueries(selectedItemId);
    selectItem(null, null);
  }, [refreshLocalQueries, selectItem, selectedItemId]);

  const handleCreateVoiceprint = useCallback(async (segmentId: string, speakerName: string) => {
    if (!selectedItemId || !segmentId) return;
    const name = window.prompt("保存声纹名称", speakerName || "发言人");
    if (!name?.trim()) return;
    await getDesktopLocalTranscriptionApi()?.createVoiceprint({
      name: name.trim(),
      sampleRecordId: selectedItemId,
      sampleSegmentIds: [segmentId],
    });
  }, [selectedItemId]);

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
  }, [contentTab, outlineBody, visibleConclusionTexts]);

  // Parse current tab
  const activeSummaryIdx = contentTab.startsWith("summary-") ? parseInt(contentTab.slice(8), 10) : -1;
  const activeNoteId = contentTab.startsWith("note-") ? contentTab.slice(5) : null;
  const activeSummary = activeSummaryIdx >= 0 ? visibleConclusionTexts[activeSummaryIdx] : undefined;

  useEffect(() => {
    if (!selectedItemId || summarizingFileIds.has(selectedItemId)) return;
    const previousCount = summaryCountBeforeResummary.current;
    if (previousCount === 0 || visibleConclusionTexts.length <= previousCount) return;
    setContentTab(`summary-${visibleConclusionTexts.length - 1}`);
    summaryCountBeforeResummary.current = 0;
  }, [visibleConclusionTexts.length, selectedItemId, setContentTab, summarizingFileIds]);

  const currentFileSummarizing = !!selectedItemId && summarizingFileIds.has(selectedItemId);
  const currentFileRerunning = currentFileSummarizing && currentFileSummariesCleared;
  const currentFileResummaryError = !!selectedItemId && resummaryErrorFileId === selectedItemId;

  const handleResummaryStarted = useCallback((
    fileId: string,
    mode: SummaryTemplateDialogMode,
    options?: { pendingId?: string; templateName?: string },
  ) => {
    summaryCountBeforeResummary.current = mode === "add" ? visibleConclusionTexts.length : 0;
    setResummaryErrorFileId(null);
    if (mode === "add" && options?.pendingId) {
      const pendingTab: SummaryTabModel = {
        key: options.pendingId,
        id: "",
        name: options.templateName || t("workspace.summary"),
        text: "",
        status: "pending",
        pendingId: options.pendingId,
      };
      setPendingSummaryTabsByFile((current) => ({
        ...current,
        [fileId]: [...(current[fileId] ?? []), pendingTab],
      }));
      setContentTab(`summary-${visibleConclusionTexts.length}`);
    }
    if (mode === "rerun") {
      setClearedSummaryFileIds((current) => {
        const next = new Set(current);
        next.add(fileId);
        return next;
      });
      setContentTab("outline");
    }
    setFileSummarizing(fileId, true);
  }, [setContentTab, setFileSummarizing, t, visibleConclusionTexts.length]);

  const handleResummaryFinished = useCallback((
    fileId: string,
    success: boolean,
    mode: SummaryTemplateDialogMode,
    options?: { pendingId?: string; conclusion?: import("./types").FileConclusion },
  ) => {
    setFileSummarizing(fileId, false);
    setResummaryErrorFileId(success ? null : fileId);
    if (mode === "add" && options?.pendingId) {
      setPendingSummaryTabsByFile((current) => {
        const tabs = current[fileId] ?? [];
        const nextTabs =
          success && options.conclusion
            ? mergePendingSummaryTab({ tabs, pendingId: options.pendingId!, conclusion: options.conclusion })
            : tabs.map((tab) => tab.pendingId === options.pendingId ? { ...tab, status: "error" as const } : tab);
        return { ...current, [fileId]: nextTabs };
      });
    }
    if (mode === "rerun" && success) {
      setClearedSummaryFileIds((current) => {
        const next = new Set(current);
        next.delete(fileId);
        return next;
      });
      setContentTab("summary-0");
    }
  }, [setContentTab, setFileSummarizing]);

  const handleDeleteSummary = useCallback((conclusionId: string, idx: number) => {
    if (!selectedItemId || !window.confirm(text("summary_tab.delete_confirm", summaryTabFallback.deleteConfirm))) return;
    deleteConclusion.mutate(conclusionId, {
      onSuccess: () => {
        if (contentTab === `summary-${idx}`) {
          const nextIdx = idx > 0 ? idx - 1 : 0;
          setContentTab(visibleConclusionTexts.length > 1 ? `summary-${nextIdx}` : "outline");
        }
      },
    });
  }, [contentTab, deleteConclusion, selectedItemId, setContentTab, text, summaryTabFallback.deleteConfirm, visibleConclusionTexts.length]);

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
          {visibleConclusionTexts.length > 0 && (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="flex max-w-60 shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground"
                >
                  <Sparkles className="size-3.5 shrink-0" />
                  <span className="shrink-0">{t("workspace.summary")}:</span>
                  <span className="min-w-0 truncate text-foreground">
                    {activeSummary?.name || t("workspace.summary")}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  {visibleConclusionTexts.map((block, idx) => (
                    <DropdownMenuCheckboxItem
                      key={block.key}
                      checked={contentTab === `summary-${idx}`}
                      onClick={() => setContentTab(`summary-${idx}`)}
                      className="pr-8 pl-1.5 [&>span:first-child]:right-2 [&>span:first-child]:left-auto"
                    >
                      <Sparkles className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {block.name || t("workspace.summary")}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
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
            onClick={() => {
              setSelectedConclusionIdForTemplate(null);
              setSummaryDialogMode("add");
              setResummarizeOpen(true);
            }}
            disabled={!selectedItemId || currentFileSummarizing}
            className="flex items-center justify-center rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors disabled:pointer-events-none disabled:opacity-50"
            title={t("add_summary.button")}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="flex-1" />
        {selectedItemId && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground"
              title="More actions"
            >
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                onClick={() => {
                  if (!activeSummary?.id) return;
                  setSelectedConclusionIdForTemplate(activeSummary.id);
                  setSummaryDialogMode("replace");
                  setResummarizeOpen(true);
                }}
                disabled={currentFileSummarizing || !activeSummary?.id}
              >
                <RefreshCw className="size-3.5" />
                <span>{text("summary_tab.replace_template", summaryTabFallback.replaceTemplate)}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  if (!activeSummary?.id || activeSummaryIdx < 0) return;
                  handleDeleteSummary(activeSummary.id, activeSummaryIdx);
                }}
                disabled={deleteConclusion.isPending || !activeSummary?.id}
              >
                <Trash2 className="size-3.5" />
                <span>{text("summary_tab.delete", summaryTabFallback.delete)}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setSelectedConclusionIdForTemplate(null);
                  setSummaryDialogMode("rerun");
                  setResummarizeOpen(true);
                }}
                disabled={currentFileSummarizing}
              >
                <RefreshCw className="size-3.5" />
                <span>{t("resummarize.button")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Content area */}
      <div className="flex flex-1 min-h-0">
        <div className={`flex-1 min-w-0 ${contentTab === "transcription" ? "overflow-hidden" : "overflow-auto"}`}>
          {!selectedItemId ? (
            <EmptyState />
          ) : isLoading ? (
            <LoadingState />
          ) : (
            <div className={`px-6 py-6 ${contentTab === "transcription" ? "flex flex-col h-full" : "min-h-full flex flex-col"}`}>
              <input
                type="text"
                value={displayTitle ?? ""}
                onChange={(e) => {
                  if (!selectedItemId) return;
                  setEditedTitle({ itemId: selectedItemId, title: e.target.value });
                }}
                placeholder={t("workspace.enter_filename")}
                className="w-full border-none bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground/50 shrink-0"
              />
              {isLocalSelectedItem && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {localStatusTag && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                      {localStatusTag}
                    </span>
                  )}
                  {localStatusTag === "失败" && (
                    <button
                      type="button"
                      onClick={handleRetryLocalTranscription}
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <RefreshCw className="size-3" />
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleDeleteLocalTranscription}
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Trash2 className="size-3" />
                    删除
                  </button>
                </div>
              )}
              {selectedCreatedAt && (
                <div className="mt-1 text-[11px] text-muted-foreground shrink-0">
                  {formatDate(selectedCreatedAt)}
                </div>
              )}

              <div ref={contentPreviewRef} className={`content-preview mt-2 flex-1 min-h-0 ${contentTab === "transcription" ? "flex flex-col flex-1 min-h-0" : ""}`}>
                {currentFileRerunning ? (
                  <ResummaryPendingState />
                ) : currentFileResummaryError ? (
                  <ResummaryErrorState />
                ) : (
                  <>
                    {outlineStyles && contentTab === "outline" && (
                      <style dangerouslySetInnerHTML={{ __html: outlineStyles }} />
                    )}

                    {contentTab === "outline" && (
                      outlineBody ? (
                        sourceViewVisible ? (
                          <SourceView code={outlineRaw ?? outlineBody} language="html" />
                        ) : (
                          <div className="content-preview-inner" dangerouslySetInnerHTML={{ __html: outlineBody }} />
                        )
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
                                <div
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
                                  {isLocalSelectedItem && seg.id && (
                                    <div className="mt-1">
                                      <button
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          handleCreateVoiceprint(seg.id, seg.speaker);
                                        }}
                                        className="inline-flex rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                                      >
                                        保存声纹
                                      </button>
                                    </div>
                                  )}
                                </div>
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
                    {activeSummaryIdx >= 0 && visibleConclusionTexts[activeSummaryIdx] && (() => {
                      const block = visibleConclusionTexts[activeSummaryIdx]!;
                      if (block.status === "pending") return <SummaryTabPendingState />;
                      if (block.status === "error") return <SummaryTabErrorState />;
                      if (sourceViewVisible) {
                        return <SourceView code={block.text} language={isHtmlContent(block.text) ? "html" : "markdown"} />;
                      }
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
                  </>
                )}
              </div>

              {contentTab !== "transcription" && (
                <div className="mt-2 border-t border-stroke-quaternary pt-1.5 pb-1 text-center shrink-0">
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

      <ResummarizeDialog
        open={resummarizeOpen}
        onOpenChange={setResummarizeOpen}
        fileId={selectedItemId}
        conclusionId={selectedConclusionIdForTemplate}
        mode={summaryDialogMode}
        onStarted={handleResummaryStarted}
        onFinished={handleResummaryFinished}
      />
    </div>
  );
}

function ResummaryPendingState() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 text-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-foreground">{t("resummarize.generating_title")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("resummarize.generating_description")}</p>
      </div>
    </div>
  );
}

function ResummaryErrorState() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 text-center">
      <p className="text-sm font-medium text-foreground">{t("resummarize.error_title")}</p>
      <p className="text-xs text-muted-foreground">{t("resummarize.error_description")}</p>
    </div>
  );
}

function SummaryTabPendingState() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 text-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-foreground">{t("resummarize.generating_title")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("resummarize.generating_description")}</p>
      </div>
    </div>
  );
}

function SummaryTabErrorState() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 text-center">
      <p className="text-sm font-medium text-foreground">{t("resummarize.error_title")}</p>
      <p className="text-xs text-muted-foreground">{t("resummarize.error_description")}</p>
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

  const sourceViewVisible = useWorkspaceStore((s) => s.sourceViewVisible);

  if (sourceViewVisible) {
    return <SourceView code={content} language="markdown" />;
  }

  return <SummaryMarkdownEditor content={content} onChange={handleChange} />;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// ── Syntax highlighting for source viewer (rich GitHub-like palette) ──
const SH_COLORS = {
  // HTML
  tag: "#6B5CE7",         // purple — HTML tags
  tagSpecial: "#af52de",  // magenta — DOCTYPE, special tags
  attr: "#ff9500",        // orange — attribute names
  string: "#34c759",      // green — strings / attr values
  comment: "#6e6e73",     // gray — comments
  punctuation: "#888888", // muted — brackets, angle brackets
  // Markdown
  keyword: "#ff7b72",     // red — bold markers, list markers
  heading: "#79c0ff",     // cyan — markdown headings
  code: "#ffa657",        // orange — inline code
  link: "#d2a8ff",        // purple — links
  // CSS (inside <style>)
  cssProp: "#61dafb",     // light blue — CSS property names
  cssValue: "#e5e5e7",    // light gray — CSS property values
  cssVar: "#888888",      // gray — CSS variable declarations
  cssVarRef: "#00bfff",   // cyan — var(--xxx) references
  cssSelector: "#ff9500", // orange — CSS selectors
  // Shared
  plain: "#e5e5e7",       // default text
};

function highlightHtml(code: string): string {
  let result = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Comments: <!-- ... -->
  result = result.replace(/(&lt;!--[\s\S]*?--&gt;)/g, `<span style="color:${SH_COLORS.comment};font-style:italic">$1</span>`);

  // DOCTYPE and special declarations
  result = result.replace(/(&lt;!)(DOCTYPE)(\s+html)(&gt;)/gi, (_, open, kw, rest, close) =>
    `<span style="color:${SH_COLORS.punctuation}">${open}</span><span style="color:${SH_COLORS.tagSpecial};font-weight:600">${kw}</span><span style="color:${SH_COLORS.plain}">${rest}</span><span style="color:${SH_COLORS.punctuation}">${close}</span>`
  );

  // CSS inside <style> blocks — highlight property names, values, variables, selectors
  result = result.replace(/(&lt;style[^&]*?&gt;)([\s\S]*?)(&lt;\/style&gt;)/gi, (_, openTag, cssBody, _closeTag) => {
    // Color the style tags themselves
    let out = `<span style="color:${SH_COLORS.tag}">${openTag.replace(/(&lt;\/?)(\w+)/g, `$1<span style="color:${SH_COLORS.tag}">$2</span>`)}</span>`;
    // Highlight CSS content
    let css = cssBody
      // CSS variable declarations --xxx:
      .replace(/(--[a-zA-Z0-9_-]+)(\s*:)/g, `<span style="color:${SH_COLORS.cssVar}">$1</span>$2`)
      // var(--xxx) references
      .replace(/(var\()([^)]+)(\))/g, `<span style="color:${SH_COLORS.punctuation}">$1</span><span style="color:${SH_COLORS.cssVarRef}">$2</span><span style="color:${SH_COLORS.punctuation}">$3</span>`)
      // CSS property: value pairs
      .replace(/(\s+)([a-z-]+)(\s*:)/g, `$1<span style="color:${SH_COLORS.cssProp}">$2</span>$3`)
      // Hex color values #xxx
      .replace(/(#[0-9a-fA-F]{3,8})/g, `<span style="color:${SH_COLORS.cssValue}">$1</span>`)
      // Numeric values with units
      .replace(/(\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg))/g, `<span style="color:${SH_COLORS.cssValue}">$1</span>`)
      // CSS selectors (lines ending with {)
      .replace(/^(\s*)([.#]?[a-zA-Z][a-zA-Z0-9_\-\s,.:#>+~[\]="']*)(\s*\{)/gm, `$1<span style="color:${SH_COLORS.cssSelector}">$2</span>$3`);
    out = out.replace(/(&lt;\/)(style)(&gt;)/gi, `<span style="color:${SH_COLORS.tag}">$1$2$3</span>`);
    return out.replace(/(&lt;style[^&]*?&gt;)/, "") + css + out.slice(out.lastIndexOf("&lt;\/"));
  });

  // HTML tags with attributes
  result = result.replace(/(&lt;\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(&gt;)/g, (_, open, tag, attrs, close) => {
    // Skip if already highlighted (inside style block)
    if (open.includes("span")) return _;
    let highlightedAttrs = attrs
      // Attribute name
      .replace(/\b([a-zA-Z][a-zA-Z0-9-:]*)(=)/g, `<span style="color:${SH_COLORS.attr}">$1</span>$2`)
      // Attribute value (double-quoted)
      .replace(/(=")(.*?)(")/g, `$1<span style="color:${SH_COLORS.string}">$2</span>$3`)
      // Attribute value (single-quoted)
      .replace(/(=')(.*?)(')/g, `$1<span style="color:${SH_COLORS.string}">$2</span>$3`);
    return `<span style="color:${SH_COLORS.punctuation}">${open}</span><span style="color:${SH_COLORS.tag}">${tag}</span>${highlightedAttrs}<span style="color:${SH_COLORS.punctuation}">${close}</span>`;
  });

  return result;
}

function highlightMarkdown(code: string): string {
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Headings (lines starting with #)
    .replace(/^(#{1,6}\s.*)$/gm, `<span style="color:${SH_COLORS.heading};font-weight:600">$1</span>`)
    // Bold **text**
    .replace(/(\*\*|__)(.*?)\1/g, `<span style="color:${SH_COLORS.keyword};font-weight:600">$1$2$1</span>`)
    // Italic *text*
    .replace(/(\*|_)(.*?)\1/g, `<span style="color:${SH_COLORS.plain};font-style:italic">$1$2$1</span>`)
    // Inline code `code`
    .replace(/(`)(.*?)(`)/g, `<span style="color:${SH_COLORS.code}">$1$2$3</span>`)
    // Code blocks ```
    .replace(/(```[\s\S]*?```)/g, `<span style="color:${SH_COLORS.code}">$1</span>`)
    // Links [text](url)
    .replace(/(\[)(.*?)(\]\()(.*?)(\))/g, `<span style="color:${SH_COLORS.punctuation}">$1</span><span style="color:${SH_COLORS.link}">$2</span><span style="color:${SH_COLORS.punctuation}">$3</span><span style="color:${SH_COLORS.string}">$4</span><span style="color:${SH_COLORS.punctuation}">$5</span>`)
    // List markers
    .replace(/^(\s*)([-*+]|\d+\.)\s/gm, `$1<span style="color:${SH_COLORS.keyword}">$2</span> `)
    // Blockquotes >
    .replace(/^(&gt;\s?.*)$/gm, `<span style="color:${SH_COLORS.comment}">$1</span>`);
}

function highlightCode(code: string, language: "html" | "markdown"): string {
  return language === "html" ? highlightHtml(code) : highlightMarkdown(code);
}

/** Extract base64 images from HTML/Markdown, return { cleaned code, image data URIs } */
function extractBase64Images(code: string): { cleaned: string; images: string[] } {
  const images: string[] = [];
  // 1. HTML <img> tags with base64 src
  let cleaned = code.replace(
    /<img\b([^>]*)src\s*=\s*["'](data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+)["']([^>]*)\/?>/gi,
    (_fullMatch, before, dataUri, after) => {
      images.push(dataUri);
      return `<img${before}src="[base64-image-${images.length}]"${after}/>`;
    }
  );
  // 2. Markdown ![alt](data:image/...;base64,...)
  cleaned = cleaned.replace(
    /(!\[[^\]]*\])\((data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+)\)/g,
    (_fullMatch, altPart, dataUri) => {
      images.push(dataUri);
      return `${altPart}([base64-image-${images.length}])`;
    }
  );
  return { cleaned, images };
}

/** Source code viewer — displays raw HTML/Markdown with syntax highlighting + base64 image preview */
function SourceView({ code, language }: { code: string; language: "html" | "markdown" }) {
  const { highlighted, images } = useMemo(() => {
    const { cleaned, images } = extractBase64Images(code);
    return { highlighted: highlightCode(cleaned, language), images };
  }, [code, language]);

  return (
    <div className="rounded-md overflow-auto flex-1 min-h-0" style={{ backgroundColor: "#0d1117", border: "1px solid #30363d" }}>
      <div className="sticky top-0 flex items-center gap-2 px-3 py-1.5" style={{ backgroundColor: "#161b22", borderBottom: "1px solid #30363d" }}>
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>
          {language}
        </span>
      </div>
      <pre
        className="p-4 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono"
        style={{ color: SH_COLORS.plain }}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
      {/* Base64 image previews */}
      {images.length > 0 && (
        <div className="border-t px-4 py-3 space-y-3" style={{ borderColor: "#30363d" }}>
          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>
            Image Previews ({images.length})
          </div>
          {images.map((dataUri, i) => (
            <div key={i} className="rounded-md overflow-hidden" style={{ border: "1px solid #30363d" }}>
              <div className="px-3 py-1 text-[10px]" style={{ backgroundColor: "#161b22", color: "#8b949e", borderBottom: "1px solid #30363d" }}>
                Image {i + 1}
              </div>
              <div className="p-3 flex justify-center" style={{ backgroundColor: "#0d1117" }}>
                <img
                  src={dataUri}
                  alt={`base64-image-${i + 1}`}
                  className="max-w-full rounded"
                  style={{ maxHeight: 400 }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
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
      <p className="mt-1 text-xs text-muted-foreground">{t("workspace.select_file_hint")}</p>
    </div>
  );
}

function LoadingState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center gap-2">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
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
