"use client";

import { useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect, Children, type ReactNode } from "react";
import { API_PROXY_PREFIX } from "@lynse/core/config";
import {
  Bookmark,
  FileText,
  FileAudio,
  Sparkles,
  MessageSquare,
  List,
  MoreHorizontal,
  X,
  Plus,
  RefreshCw,
  Loader2,
  Trash2,
  Upload,
  Cpu,
  ChevronLeft,
  ChevronRight,
  Clock,
} from "../icons";
import { getWorkspaceState, useWorkspaceStore } from "./store";
import { SummaryExportMenuItem } from "../connections/summary-export-menu-item";
import { useAudioEditorStore } from "../audio-editor/store";
import { useCloudAudio } from "./use-cloud-audio";
import { useNavigation } from "../navigation";
import { TAB_BAR_HEIGHT } from "./layout-constants";
import { api } from "@lynse/core/api/client";
import type { MeetingNotes } from "@lynse/core/api";
import { emitPluginEvent } from "../plugins";
import { SummaryMarkdownEditor } from "./summary-editor";
import { DockedMarkdownToolbar } from "./center-panel/docked-toolbar";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { TaskState, type TaskRecoveryAction } from "./task-state";
import { Button } from "@lynse/ui/components/ui/button";
import { ActivityIndicator } from "@lynse/ui/components/ui/activity-indicator";
import { AudioPlayer } from "./audio-player";
import type { AudioPlayerHandle } from "./audio-player";
import { ChaptersPanel } from "./chapter-panel";
import { RecordingMarksPanel, readRecordingMarks } from "./recording-marks-panel";
import {
  cloudChaptersQueryKey,
  cloudTranscriptionToChapterSegments,
  useCloudChapterDocument,
} from "./cloud-chapters";
import { formatRecordingTime, runChapterGeneration, saveChapterEdits } from "./local-chapters";
import {
  buildChapterDocument,
  buildUtterances,
  computeTranscriptHash,
  type ChapterSegment,
} from "./semantic-chapters";
import { generateChapters } from "@lynse/core/api";
import type { ChapterDocument, FileConclusion, SemanticChapter, WorkspaceItem } from "./types";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import type { RecordingTrackManifest } from "./types";
import { normalizeSummaryTemplateName } from "./types";
import { getSpeakerColor } from "@lynse/ui/lib/speaker";
import { getDisplayTitle, type EditedTitleState } from "./title-edit-state";
import {
  insertFileConclusion,
  mergePendingSummaryTab,
  useDeleteConclusion,
  useFiles,
  useFileOutline,
  useFileConclusions,
  useFileTranscription,
  useFileAudioUrl,
  useUpdateConclusion,
  useRerunSummary,
  useFileDetail,
  useTemplateCategories,
  sortConclusionsChronologically,
} from "./hooks/use-files";
import type { SummaryTabModel } from "./hooks/use-files";
import { useTranslation } from "@lynse/core/i18n/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ResummarizeDialog, type SummaryTemplateDialogMode } from "./resummarize-dialog";
import { ShareNoteMenuItem } from "./share-note/share-note-menu-item";
import { ShareNoteDialog } from "./share-note/share-note-dialog";
import { useNotificationStore } from "../notifications/use-notification-store";
import {
  getDesktopLocalTranscriptionApi,
  isLocalFileId,
  LOCAL_TRANSCRIPTION_FOLDER_ID,
} from "./local-transcription";
import {
  pendingRecordingRecordId,
  usePendingRecordingStore,
} from "../live-translation/pending-recording-store";
import { retryLocalTranscription } from "./local-transcription-retry";
import { isLocalTranscriptionActive, LOCAL_STATUS_LABEL_KEY } from "./local-transcription-status";
import { useRecordingCloudSync } from "../live-translation/use-recording-cloud-sync";
import { LiveNotesPanel } from "../live-translation/notes/notes-panel";
import type { LiveNotesState } from "../live-translation/notes/engine";
import { triggerLocalAutoSummary, LOCAL_SUMMARY_TAB_ID } from "./local-auto-summary";
import { generateCloudLynclawSummary } from "./cloud-lynclaw-summary";
import { generateCustomModelSummary } from "./custom-model-summary";
import { getCustomModelsApi } from "../custom-models";
import {
  LYNCLAW_FORMAT_LABELS,
  lynclawNoteId,
} from "./lynclaw-notes";
import {
  encodeLynclawSummary,
  logLynclawSummaryFailure,
  LynclawSummaryError,
  readLynclawSummary,
  type LynclawSummaryFormat,
} from "./lynclaw-summary";
import { isLynclawSummaryTabsEnabled } from "../feature-flags";
import { wrapCjkSpacing } from "./cjk-spacing";
import { extractBody } from "./content-html";
import { MilkdownViewer } from "./milkdown-viewer";
import {
  getDesktopVaultApi,
  stripVaultFrontmatter,
  useNoteVaultSync,
} from "./note-vault";
import type { LocalTranscriptionStatus } from "./types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@lynse/ui/components/ui/context-menu";
import "./content-preview.css";
import { toast } from "sonner";

function isHtmlContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<") && /<\/\w+>/.test(trimmed);
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
  const selectedItemId = useWorkspaceStore((s) => lynclawNoteId(s.selectedItemId) ? null : s.selectedItemId);
  const selectedItemTitle = useWorkspaceStore((s) => s.selectedItemTitle);
  const requestedContentTab = useWorkspaceStore((s) => s.contentTab);
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
  const { data: outline, isLoading: outlineLoading, error: outlineError } = useFileOutline(selectedItemId);
  const {
    data: conclusions,
    isLoading: conclusionsLoading,
    error: conclusionsError,
  } = useFileConclusions(selectedItemId);
  const { data: transcription, isLoading: transLoading } = useFileTranscription(selectedItemId);
  const isCloudSelectedItem = !!selectedItemId && !isLocalFileId(selectedItemId);
  // Dual-channel recordings: per-track listening (全部／本机／远端) and the
  // echo-cancellation status banner.
  const [trackFilter, setTrackFilter] = useState<"all" | "mic" | "system">("all");
  const [trackAudioUrl, setTrackAudioUrl] = useState<string | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const selectedTrackManifest = useMemo(() => {
    const manifest = transcription?.trackManifest as RecordingTrackManifest | undefined;
    if (!manifest?.tracks?.length) return null;
    const has = (id: string) => manifest.tracks.some((track) => track.id === id);
    return has("mic_processed") && has("system_processed") ? manifest : null;
  }, [transcription]);
  const selectedAecDegraded = isLocalFileId(selectedItemId) && !!transcription?.aecDegraded;
  const selectedTrackStatuses = transcription?.trackStatuses as
    | Partial<Record<"mic" | "system", { status: string; error?: string }>>
    | undefined;
  const selectedLiveSessionId =
    (transcription as { liveSessionId?: string } | undefined)?.liveSessionId ?? null;

  // AI semantic chapters use the same playback-ordered rows the 转写 tab
  // renders. Cloud rows use the flexible API envelope, so normalize them into
  // one canonical segment shape before generation and staleness hashing.
  const chapterSegments: ChapterSegment[] = useMemo(
    () =>
      !isCloudSelectedItem
        ? (transcription?.records ?? []).map((row) => ({
            id: row.id,
            text: row.text,
            startMs: row.beginTime,
            endMs: row.endTime,
            speaker: row.speakerName ?? null,
          }))
        : cloudTranscriptionToChapterSegments(transcription),
    [isCloudSelectedItem, transcription],
  );
  const localChaptersDocument = (transcription?.chaptersDocument as ChapterDocument | null | undefined) ?? null;
  const { data: cloudChaptersDocument } = useCloudChapterDocument(isCloudSelectedItem ? selectedItemId : null);
  const chaptersDocument = isCloudSelectedItem ? cloudChaptersDocument ?? null : localChaptersDocument;
  // Structured live meeting notes (lynclaw /api/notes) — recorded live sessions only.
  const liveNotes = (transcription?.notesJson as MeetingNotes | null | undefined) ?? null;
  const chaptersStatus = transcription?.chaptersStatus;
  const chaptersError = transcription?.chaptersError ?? null;

  useEffect(() => {
    setTrackFilter("all");
    setTrackAudioUrl(null);
  }, [selectedItemId]);

  useEffect(() => {
    let cancelled = false;
    const entry = selectedTrackManifest?.tracks.find((track) =>
      track.id === (trackFilter === "mic" ? "mic_processed" : "system_processed")
    );
    if (trackFilter === "all" || !selectedItemId || !entry) {
      setTrackAudioUrl(null);
      return;
    }
    getDesktopLocalTranscriptionApi()
      ?.getTrackAudioUrl(selectedItemId, entry.file)
      .then((url) => {
        if (!cancelled) setTrackAudioUrl(url ?? null);
      })
      .catch(() => {
        if (!cancelled) setTrackAudioUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trackFilter, selectedItemId, selectedTrackManifest]);

  const updateConclusion = useUpdateConclusion();
  const deleteConclusion = useDeleteConclusion();
  const rerunSummary = useRerunSummary();
  const { data: fileDetail, isLoading: fileDetailLoading } = useFileDetail(selectedItemId);
  const isDesktop = !!getDesktopLocalTranscriptionApi();
  const recordingMarks = useMemo(
    () => readRecordingMarks(isDesktop && fileDetail?.id === selectedItemId ? fileDetail : undefined),
    [isDesktop, fileDetail, selectedItemId],
  );
  const hasRecordingMarks = recordingMarks.marks.length > 0 || recordingMarks.images.length > 0;
  const contentTab = requestedContentTab === "marks" && !hasRecordingMarks
    ? "transcription"
    : requestedContentTab;
  const { data: templateCategories } = useTemplateCategories();

  const defaultTemplateId = useMemo(() => {
    const all = templateCategories?.flatMap((c) => c.templates) ?? [];
    return all.find((tpl) => tpl.isDefault === 1)?.id ?? all[0]?.id ?? "";
  }, [templateCategories]);

  const audioPlayerRef = useRef<AudioPlayerHandle>(null);
  const [highlightTimeMs, setHighlightTimeMs] = useState<number | null>(null);
  const [summaryEditor, setSummaryEditor] = useState<import("@milkdown/kit/core").Editor | null>(null);
  const [resummarizeOpen, setResummarizeOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [summaryDialogMode, setSummaryDialogMode] = useState<SummaryTemplateDialogMode>("add");
  const [selectedConclusionIdForTemplate, setSelectedConclusionIdForTemplate] = useState<string | null>(null);
  const [resummaryErrorFileId, setResummaryErrorFileId] = useState<string | null>(null);
  const [clearedSummaryFileIds, setClearedSummaryFileIds] = useState<Set<string>>(() => new Set());
  // Which resummary mode is in flight per file — "replace" rewrites the visible
  // summary in place (needs a dimmed working state), "rerun"/"add" swap to a
  // pending state instead.
  const [summaryWorkModes, setSummaryWorkModes] = useState<Record<string, SummaryTemplateDialogMode>>(() => ({}));
  const [pendingSummaryTabsByFile, setPendingSummaryTabsByFile] = useState<Record<string, SummaryTabModel[]>>({});
  const [summaryRetryTarget, setSummaryRetryTarget] = useState<{ fileId: string; key: string } | null>(null);
  const [retryingLocalFileIds, setRetryingLocalFileIds] = useState<Set<string>>(() => new Set());
  const [localRetryError, setLocalRetryError] = useState<string | null>(null);
  const [voiceprintDraft, setVoiceprintDraft] = useState<{ segmentId: string; name: string } | null>(null);
  // Summary tab staged for deletion behind the themed confirm dialog.
  const [pendingDeleteSummary, setPendingDeleteSummary] = useState<{ conclusionId: string; idx: number } | null>(null);
  const summaryCountBeforeResummary = useRef<{ fileId: string; count: number } | null>(null);

  const selectedTitle = useMemo(() => {
    if (!selectedItemId) return null;
    const listedTitle = files?.find((f) => f.id === selectedItemId)?.title ?? null;
    return listedTitle || selectedItemTitle;
  }, [selectedItemId, files, selectedItemTitle]);

  // Optimistic placeholder while a recording has not persisted yet (see
  // live-translation/pending-recording-store) — keeps the detail panel in its
  // pending state instead of flashing an empty page.
  const pendingRecording = usePendingRecordingStore((s) =>
    s.pending.find((p) => pendingRecordingRecordId(p.sessionId) === selectedItemId),
  );
  const selectedFile = useMemo<WorkspaceItem | null>(() => {
    if (!selectedItemId) return null;
    const listed = files?.find((f) => f.id === selectedItemId) ?? null;
    if (listed || !pendingRecording) return listed;
    return {
      id: selectedItemId,
      type: "file" as const,
      title: pendingRecording.title,
      createdAt: pendingRecording.startedAt,
      updatedAt: pendingRecording.startedAt,
      folderId: LOCAL_TRANSCRIPTION_FOLDER_ID,
      localStatus: pendingRecording.phase,
      transcriptionCompleted: false,
    };
  }, [selectedItemId, files, pendingRecording]);

  const audioDetail = fileDetail?.id === selectedItemId ? fileDetail : undefined;
  const cloudAudio = useCloudAudio(
    isCloudSelectedItem ? selectedItemId : null,
    String(audioDetail?.updatedAt ?? selectedFile?.updatedAt ?? ""),
    audioDetail?.originalFilename ?? selectedFile?.title,
    fileDetailLoading,
  );
  const { data: audioUrl } = useFileAudioUrl(cloudAudio.managed ? null : selectedItemId);
  const playerAudioUrl = cloudAudio.managed
    ? cloudAudio.audio?.url
    : (trackFilter === "all" ? audioUrl : trackAudioUrl ?? audioUrl);

  const isLocalSelectedItem = isLocalFileId(selectedItemId);
  // Only live-session records can upload: the Rust finalize / cloud-file-id
  // commands address the store by `local:live:<sessionId>`.
  const isLiveLocalSelectedItem = !!selectedItemId && selectedItemId.startsWith("local:live:");
  const localStatus = selectedFile?.localStatus;
  const selectedLocalRetrying = !!selectedItemId && retryingLocalFileIds.has(selectedItemId);
  const effectiveLocalStatus: LocalTranscriptionStatus | undefined = selectedLocalRetrying
    ? "transcribing"
    : localStatus;
  const localTranscriptionActive = isLocalTranscriptionActive({
    status: localStatus,
    retrying: selectedLocalRetrying,
  });
  // Audio-only record: the engine never ran (or produced nothing) and no job
  // is active — the point where the user must pick local vs. cloud transcribe.
  const isRecordedLocal = isLocalSelectedItem && localStatus === "recorded";

  const selectedCreatedAt = useMemo(() => {
    if (!selectedItemId || !files) return null;
    return files.find((f) => f.id === selectedItemId)?.createdAt ?? null;
  }, [selectedItemId, files]);

  // Scissors entry on the audio player bar: open the desktop audio editor for
  // this local recording (trim / desilence / enhance run through FFmpeg).
  const openAudioEditor = useAudioEditorStore((s) => s.openEditor);
  const { push } = useNavigation();
  const handleEditSelectedAudio = useCallback(() => {
    if (!selectedFile || !isLocalFileId(selectedFile.id)) return;
    openAudioEditor(
      [{ id: selectedFile.id, title: selectedFile.title, createdAt: selectedFile.createdAt }],
      "overwrite",
    );
    push("/audio-editor");
  }, [openAudioEditor, push, selectedFile]);

  const handleEditCloudAudio = useCallback(() => {
    if (!cloudAudio.audio) return;
    openAudioEditor([{
      id: cloudAudio.audio.id,
      cachedAudioUrl: cloudAudio.audio.url,
      title: selectedTitle || audioDetail?.originalFilename || t("audio_editor.title"),
      createdAt: selectedFile?.createdAt ?? audioDetail?.createdAt,
    }], "new");
    push("/audio-editor");
  }, [audioDetail, cloudAudio.audio, openAudioEditor, push, selectedFile?.createdAt, selectedTitle, t]);

  const [editedTitle, setEditedTitle] = useState<EditedTitleState | null>(null);
  const displayTitle = getDisplayTitle(selectedItemId, selectedTitle, editedTitle, selectedItemTitle);

  // Conclusions — each FileConclusionVO has a `templateName` field for the conclusion template name
  const conclusionTexts = useMemo(() => {
    if (!Array.isArray(conclusions)) return [];
    return sortConclusionsChronologically(conclusions)
      .map((c, i) => {
        const obj = c as Record<string, unknown>;
        const stored = String(obj.conclusionText ?? "");
        const lynclaw = readLynclawSummary(stored);
        const text = lynclaw?.body ?? stored;
        const id = String(obj.id ?? "");
        // "auto" falls back to the default template label.
        const name = lynclaw
          ? `${t("workspace.lynclaw_summary")} · ${LYNCLAW_FORMAT_LABELS[lynclaw.format]}`
          : normalizeSummaryTemplateName(
            String(obj.templateName ?? obj.conclusionName ?? obj.title ?? obj.name ?? ""),
          ) ?? "";
        return stored ? { key: id || `summary-${i}`, text, id, name, status: "ready" as const, lynclawFormat: lynclaw?.format } : null;
      })
      .filter(Boolean) as SummaryTabModel[];
  }, [conclusions, t]);
  const currentFileSummariesCleared = !!selectedItemId && clearedSummaryFileIds.has(selectedItemId);
  const pendingSummaryTabs = useMemo(
    () => selectedItemId ? (pendingSummaryTabsByFile[selectedItemId] ?? []) : [],
    [pendingSummaryTabsByFile, selectedItemId],
  );
  // Local recordings carry their agent-service deep summary on the record
  // itself (no cloud conclusion) — surface it as the first summary tab.
  const localSummaryTab = useMemo<SummaryTabModel | null>(() => {
    const stored = isLocalSelectedItem ? String((transcription as Record<string, unknown> | undefined)?.summaryMarkdown ?? "").trim() : "";
    if (!stored) return null;
    const lynclaw = readLynclawSummary(stored);
    return {
      key: LOCAL_SUMMARY_TAB_ID,
      text: lynclaw?.body ?? stored,
      id: LOCAL_SUMMARY_TAB_ID,
      name: lynclaw ? `${t("workspace.lynclaw_summary")} · ${LYNCLAW_FORMAT_LABELS[lynclaw.format]}` : t("workspace.deep_summary_tab"),
      status: "ready" as const,
      lynclawFormat: lynclaw?.format,
    };
  }, [isLocalSelectedItem, transcription, t]);
  const visibleConclusionTexts = useMemo(
    () => currentFileSummariesCleared
      ? []
      : [
          ...(localSummaryTab ? [localSummaryTab] : []),
          ...conclusionTexts,
          // The task reply and query refresh can arrive in either order.
          // Never draw the same completed summary twice between those renders.
          ...pendingSummaryTabs.filter((tab) => !tab.id || !conclusionTexts.some((saved) => saved.id === tab.id)),
        ],
    [currentFileSummariesCleared, localSummaryTab, conclusionTexts, pendingSummaryTabs],
  );

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

  // Local vault mirror: once the note's content is loaded (or after an edit
  // invalidates the queries), rewrite the note's markdown file on disk.
  useNoteVaultSync({
    fileId: selectedItemId,
    title: displayTitle,
    createdAt: selectedCreatedAt,
    updatedAt: selectedFile?.updatedAt ?? null,
    outlineText: outlineRaw,
    conclusions: conclusionTexts,
  });

  // Offline fallback: when both content queries fail (e.g. no network), show
  // the note's cached vault file instead of an empty panel.
  const [offlineVaultMarkdown, setOfflineVaultMarkdown] = useState<string | null>(null);
  useEffect(() => {
    const offline = !outlineLoading && !conclusionsLoading && !!outlineError && !!conclusionsError;
    if (!offline || !selectedItemId || isLocalFileId(selectedItemId)) {
      setOfflineVaultMarkdown((current) => (current === null ? current : null));
      return;
    }
    let cancelled = false;
    getDesktopVaultApi()
      ?.readNote(selectedItemId)
      .then((markdown) => {
        if (!cancelled) setOfflineVaultMarkdown(markdown?.trim() ? markdown : null);
      })
      .catch(() => {
        if (!cancelled) setOfflineVaultMarkdown(null);
      });
    return () => {
      cancelled = true;
    };
  }, [outlineError, conclusionsError, outlineLoading, conclusionsLoading, selectedItemId]);

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
        translatedText: String(s.translatedText ?? ""),
        source: String(s.source ?? ""),
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
  const handleConclusionChange = useCallback((conclusionId: string, markdown: string, format?: LynclawSummaryFormat) => {
    const conclusionText = format ? encodeLynclawSummary(format, markdown) : markdown;
    const existing = conclusionSaveTimers.current.get(conclusionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      // The local deep summary has no cloud conclusion behind it — edits go
      // straight to the record store instead of conclusion/update.
      if (isLocalSelectedItem && conclusionId === LOCAL_SUMMARY_TAB_ID) {
        void getDesktopLocalTranscriptionApi()
          ?.saveSummary(selectedItemId!, null, conclusionText)
          .then(() => qc.invalidateQueries({ queryKey: ["file-transcription", selectedItemId] }))
          .catch(() => undefined);
      } else {
        updateConclusion.mutate({ conclusionId, conclusionText });
      }
      conclusionSaveTimers.current.delete(conclusionId);
    }, 1500);
    conclusionSaveTimers.current.set(conclusionId, timer);
  }, [updateConclusion, isLocalSelectedItem, selectedItemId, qc]);

  const scrollToHeading = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const refreshLocalQueries = useCallback((fileId?: string | null) => {
    // The Notes page list is keyed `["notes", …]`, not `["files"]` — without
    // it a locally deleted recording keeps its row until the next refetch,
    // which reads as the delete button doing nothing.
    qc.invalidateQueries({ queryKey: ["files"] });
    qc.invalidateQueries({ queryKey: ["notes"] });
    qc.invalidateQueries({ queryKey: ["folder-counts"] });
    if (fileId) {
      qc.invalidateQueries({ queryKey: ["file-transcription", fileId] });
      qc.invalidateQueries({ queryKey: ["file-audio-url", fileId] });
    }
  }, [qc]);

  const handleRetryLocalTranscription = useCallback(async () => {
    await retryLocalTranscription({
      fileId: selectedItemId,
      api: getDesktopLocalTranscriptionApi(),
      refresh: refreshLocalQueries,
      setError: setLocalRetryError,
      setRetrying: (fileId, retrying) => {
        setRetryingLocalFileIds((current) => {
          const next = new Set(current);
          if (retrying) next.add(fileId);
          else next.delete(fileId);
          return next;
        });
      },
    });
  }, [refreshLocalQueries, selectedItemId]);

  // A recording that stayed local (the completion dialog's "保存到云" was
  // skipped) had no way back to the cloud — the sync chain only ever ran from
  // the completion dialog. Route it through the same upload+transcribe chain,
  // addressing the store by the record's live session id.
  const { syncLocalRecord } = useRecordingCloudSync();
  const [uploadingLocalRecording, setUploadingLocalRecording] = useState(false);
  const handleUploadLocalRecording = useCallback(async () => {
    const localApi = getDesktopLocalTranscriptionApi();
    if (!selectedItemId || !localApi || uploadingLocalRecording) return;
    setUploadingLocalRecording(true);
    setLocalRetryError(null);
    try {
      const record = await localApi.get(selectedItemId);
      if (!record?.liveSessionId) {
        setLocalRetryError(t("workspace.upload_needs_live_session"));
        return;
      }
      await syncLocalRecord({
        id: record.id,
        liveSessionId: record.liveSessionId,
        sourcePath: record.sourcePath,
        durationMs: record.durationMs,
        startedAt: record.startedAt,
      });
      refreshLocalQueries(selectedItemId);
    } catch (error) {
      setLocalRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadingLocalRecording(false);
    }
  }, [selectedItemId, uploadingLocalRecording, syncLocalRecord, refreshLocalQueries, t]);

  // Regenerate the local deep summary through the agent service. The record's
  // transcript stays as-is; { force: true } overwrites the stored summary.
  const [regeneratingLocalSummary, setRegeneratingLocalSummary] = useState(false);
  const handleRegenerateLocalSummary = useCallback(async () => {
    if (!selectedItemId || regeneratingLocalSummary) return;
    const fileId = selectedItemId;
    const requestedTab = getWorkspaceState().contentTab;
    setRegeneratingLocalSummary(true);
    try {
      const record = await getDesktopLocalTranscriptionApi()?.get(fileId);
      if (!record?.transcriptText?.trim()) return;
      const saved = await triggerLocalAutoSummary(
        { id: fileId, status: "completed", title: record.title },
        { force: true, t: (key) => t(key) },
      );
      if (saved) {
        await qc.invalidateQueries({ queryKey: ["file-transcription", fileId] });
        const current = getWorkspaceState();
        if (current.selectedItemId === fileId && current.contentTab === requestedTab) setContentTab("summary-0");
      }
    } catch (error) {
      toast.error(t("workspace.local_summary_failed"), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setRegeneratingLocalSummary(false);
    }
  }, [selectedItemId, regeneratingLocalSummary, qc, t, setContentTab]);

  // Fully off-cloud summary for local recordings: the user's own template
  // plus their own custom model, called directly from the desktop. The result
  // lands on the record's local summary tab like any other local summary.
  const handleCustomModelApply = useCallback(async (
    fileId: string,
    options: { prompt: string; profileId: string; templateName: string },
  ) => {
    await generateCustomModelSummary(fileId, options);
    await qc.invalidateQueries({ queryKey: ["file-transcription", fileId] });
    // The local summary is always the first tab.
    if (getWorkspaceState().selectedItemId === fileId) setContentTab("summary-0");
  }, [qc, setContentTab]);

  // AI semantic chapters — an independent task from the deep summary: one
  // failing must never block the other. `force` bypasses the manual-edit guard
  // only after the panel's confirm step.
  const [chapterBusy, setChapterBusy] = useState(false);
  const cloudChaptersMutation = useMutation({
    mutationFn: async ({ fileId, force }: { fileId: string; force: boolean }) => {
      const existing = qc.getQueryData<ChapterDocument>(cloudChaptersQueryKey(fileId));
      const transcriptHash = await computeTranscriptHash(chapterSegments);
      if (!force && existing?.transcriptHash === transcriptHash) return existing;

      const client = api();
      if (!client.getAgentBaseUrl()) throw new Error("AI service unavailable");
      const sessionToken = client.getToken();
      if (!sessionToken) throw new Error("Login required");

      const result = await generateChapters(
        {
          utterances: buildUtterances(chapterSegments),
          language: (transcription as Record<string, unknown> | undefined)?.language as string | undefined,
          recordingTime: formatRecordingTime(selectedCreatedAt ?? undefined),
        },
        sessionToken,
      );
      return buildChapterDocument(result, chapterSegments, transcriptHash);
    },
    onSuccess: (document, { fileId }) => {
      qc.setQueryData(cloudChaptersQueryKey(fileId), document);
    },
  });
  const cloudChapterGenerationMatches = cloudChaptersMutation.variables?.fileId === selectedItemId;
  const handleGenerateChapters = useCallback(
    async (force: boolean) => {
      if (!selectedItemId || chapterBusy) return;
      setChapterBusy(true);
      try {
        if (!isLocalSelectedItem) {
          await cloudChaptersMutation.mutateAsync({ fileId: selectedItemId, force });
          return;
        }
        const saved = await runChapterGeneration(selectedItemId, { force, t: (key) => t(key) });
        if (saved) {
          await qc.invalidateQueries({ queryKey: ["file-transcription", selectedItemId] });
        }
      } finally {
        setChapterBusy(false);
      }
    },
    [selectedItemId, chapterBusy, isLocalSelectedItem, cloudChaptersMutation, qc, t],
  );

  const handleSaveChapterEdits = useCallback(
    async (document: ChapterDocument) => {
      if (!selectedItemId) return false;
      if (!isLocalSelectedItem) {
        qc.setQueryData(cloudChaptersQueryKey(selectedItemId), document);
        return true;
      }
      const ok = await saveChapterEdits(selectedItemId, document, { t: (key) => t(key) });
      if (ok) {
        await qc.invalidateQueries({ queryKey: ["file-transcription", selectedItemId] });
      }
      return ok;
    },
    [selectedItemId, isLocalSelectedItem, qc, t],
  );

  const handleSeekChapter = useCallback(
    (chapter: SemanticChapter) => {
      if (chapter.startMs == null) return;
      audioPlayerRef.current?.seekTo(chapter.startMs / 1000);
      setHighlightTimeMs(chapter.startMs);
    },
    [],
  );

  const handleReprocessRecording = useCallback(async () => {    if (!selectedItemId || !selectedLiveSessionId) return;
    setReprocessing(true);
    try {
      await getDesktopLiveTranslationApi()?.reprocess(selectedLiveSessionId);
      refreshLocalQueries(selectedItemId);
    } catch (error) {
      setLocalRetryError(error instanceof Error ? error.message : String(error));
      refreshLocalQueries(selectedItemId);
    } finally {
      setReprocessing(false);
    }
  }, [refreshLocalQueries, selectedItemId, selectedLiveSessionId]);

  const handleRetryTrack = useCallback(async (track: "mic" | "system") => {
    if (!selectedItemId) return;
    setRetryingLocalFileIds((current) => new Set(current).add(selectedItemId));
    refreshLocalQueries(selectedItemId);
    try {
      await getDesktopLocalTranscriptionApi()?.retry(selectedItemId, { track });
      refreshLocalQueries(selectedItemId);
    } catch (error) {
      setLocalRetryError(error instanceof Error ? error.message : String(error));
      refreshLocalQueries(selectedItemId);
    } finally {
      setRetryingLocalFileIds((current) => {
        const next = new Set(current);
        next.delete(selectedItemId);
        return next;
      });
    }
  }, [refreshLocalQueries, selectedItemId]);

  const handleDeleteLocalTranscription = useCallback(async () => {
    if (!selectedItemId) return;
    try {
      await getDesktopLocalTranscriptionApi()?.delete(selectedItemId);
      refreshLocalQueries(selectedItemId);
      selectItem(null, null);
    } catch (error) {
      setLocalRetryError(error instanceof Error ? error.message : String(error));
    }
  }, [refreshLocalQueries, selectItem, selectedItemId]);

  const handleCreateVoiceprint = useCallback(async (segmentId: string, name: string) => {
    if (!selectedItemId || !segmentId) return;
    if (!name.trim()) return;
    await getDesktopLocalTranscriptionApi()?.createVoiceprint({
      name: name.trim(),
      sampleRecordId: selectedItemId,
      sampleSegmentIds: [segmentId],
    });
    setVoiceprintDraft(null);
    refreshLocalQueries(selectedItemId);
  }, [refreshLocalQueries, selectedItemId]);

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
        proxyUrl = API_PROXY_PREFIX + src.slice(client!.backendUrl.length);
      } else if (src.startsWith("/")) {
        proxyUrl = API_PROXY_PREFIX + src;
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
    const previous = summaryCountBeforeResummary.current;
    if (!previous || previous.fileId !== selectedItemId) return;
    // Completing a background task must not take the reader away from the
    // transcript or another summary they selected while it was running.
    if (contentTab !== `summary-${previous.count}`) {
      summaryCountBeforeResummary.current = null;
      return;
    }
    if (visibleConclusionTexts.length <= previous.count) return;
    setContentTab(`summary-${visibleConclusionTexts.length - 1}`);
    summaryCountBeforeResummary.current = null;
  }, [contentTab, visibleConclusionTexts.length, selectedItemId, setContentTab, summarizingFileIds]);

  const currentFileSummarizing = !!selectedItemId && summarizingFileIds.has(selectedItemId);
  const currentFileRerunning = currentFileSummarizing && currentFileSummariesCleared;
  const currentFileResummaryError = !!selectedItemId && resummaryErrorFileId === selectedItemId;
  // Replace mode (and the local deep-summary regen) rewrite the summary that is
  // already on screen instead of swapping to the pending state — dim it while
  // working so the content reads as "regenerating" rather than sitting still.
  const replaceRegenerating =
    (selectedItemId ? summaryWorkModes[selectedItemId] : undefined) === "replace" ||
    (isLocalSelectedItem && regeneratingLocalSummary);
  const summaryRegenOverlay = replaceRegenerating && contentTab.startsWith("summary-");

  const handleResummaryStarted = useCallback((
    fileId: string,
    mode: SummaryTemplateDialogMode,
    options?: { pendingId?: string; templateName?: string },
  ) => {
    summaryCountBeforeResummary.current = mode === "add" ? { fileId, count: visibleConclusionTexts.length } : null;
    setResummaryErrorFileId((current) => current === fileId ? null : current);
    if (mode === "add" && options?.pendingId) {
      const pendingTab: SummaryTabModel = {
        key: options.pendingId,
        id: "",
        name: options.templateName || t("workspace.summary"),
        text: "",
        status: "pending",
        pendingId: options.pendingId,
      };
      const retryKey = summaryRetryTarget?.fileId === fileId ? summaryRetryTarget.key : null;
      const retryIndex = pendingSummaryTabs.findIndex((tab) => tab.key === retryKey && tab.status === "error");
      setPendingSummaryTabsByFile((current) => {
        const tabs = current[fileId] ?? [];
        return {
          ...current,
          [fileId]: retryIndex < 0
            ? [...tabs, pendingTab]
            : tabs.map((tab) => tab.key === retryKey ? { ...pendingTab, key: tab.key } : tab),
        };
      });
      setContentTab(`summary-${retryIndex < 0 ? visibleConclusionTexts.length : visibleConclusionTexts.length - pendingSummaryTabs.length + retryIndex}`);
    }
    if (mode === "rerun") {
      setClearedSummaryFileIds((current) => {
        const next = new Set(current);
        next.add(fileId);
        return next;
      });
      setContentTab("outline");
    }
    setSummaryWorkModes((current) => ({ ...current, [fileId]: mode }));
    setFileSummarizing(fileId, true);
  }, [setContentTab, setFileSummarizing, t, visibleConclusionTexts.length, pendingSummaryTabs, summaryRetryTarget]);

  const handleResummaryFinished = useCallback((
    fileId: string,
    success: boolean,
    mode: SummaryTemplateDialogMode,
    options?: { pendingId?: string; conclusion?: import("./types").FileConclusion },
  ) => {
    setFileSummarizing(fileId, false);
    setSummaryWorkModes((current) => {
      if (!(fileId in current)) return current;
      const next = { ...current };
      delete next[fileId];
      return next;
    });
    // Add/replace failures belong to that summary. The transcript and saved
    // summaries remain available; only a full rerun needs the file-wide error.
    if (mode === "rerun") {
      setResummaryErrorFileId((current) => success ? (current === fileId ? null : current) : fileId);
    }
    if (success) {
      // Generation can take minutes and the user may have navigated away — the
      // toast alone is too easy to miss, so also record a notification-center
      // entry (funnels every completion path: generate button, dialog add/replace/rerun).
      useNotificationStore.getState().add({
        id: `trans-complete:${fileId}:${Date.now()}`,
        type: "transcription",
        title: (displayTitle ?? "").trim(),
        href: "/notes",
      });
      // Host domain event: when enabled, the Feishu plugin pushes the finished
      // summary card to the configured group (no-op on web / when off). A
      // freshly produced conclusion rides along; reruns fall back to fetching
      // the newest one.
      emitPluginEvent("transcription-completed", {
        recordId: fileId,
        source: "cloud",
        title: (displayTitle ?? "").trim(),
        summary: options?.conclusion?.conclusionText ?? null,
      });
    }
    if (mode === "add" && options?.pendingId) {
      setPendingSummaryTabsByFile((current) => {
        const tabs = current[fileId] ?? [];
        const nextTabs =
          success && options.conclusion
            ? mergePendingSummaryTab({ tabs, pendingId: options.pendingId!, conclusion: options.conclusion, lynclawName: t("workspace.lynclaw_summary") })
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
      if (getWorkspaceState().selectedItemId === fileId) setContentTab("summary-0");
    }
  }, [setContentTab, setFileSummarizing, displayTitle, t]);

  // One-click "auto generate": only available in the regenerate (重新生成)
  // context. Reruns the file with the default template, skipping the picker
  // dialog. Mirrors the rerun branch of ResummarizeDialog.
  const handleAutoRerun = useCallback(async () => {
    if (!selectedItemId || !defaultTemplateId || currentFileSummarizing) return;
    const fileId = selectedItemId;
    handleResummaryStarted(fileId, "rerun", {});
    qc.setQueryData(["file-conclusions", fileId], []);
    try {
      const result = await rerunSummary.mutateAsync({
        fileId,
        templateId: defaultTemplateId,
        modelId: (fileDetail as Record<string, unknown> | undefined)?.modelId as string | undefined,
        languageId: (fileDetail as Record<string, unknown> | undefined)?.languageId as string | undefined,
      });
      handleResummaryFinished(fileId, true, "rerun", {});
      if (!result.conclusion) {
        await qc.invalidateQueries({ queryKey: ["file-conclusions", fileId] });
      }
      toast.success(text("resummarize.success", "总结已重新生成"));
    } catch (err) {
      const fileDetailRec = fileDetail as Record<string, unknown> | undefined;
      console.error(
        "[重新总结失败] 完整错误对象:",
        err,
        "\n请求参数:",
        {
          fileId,
          templateId: defaultTemplateId,
          modelId: fileDetailRec?.modelId,
          languageId: fileDetailRec?.languageId,
        },
      );
      const msg = err instanceof Error ? err.message : text("resummarize.unknown_error", "未知错误");
      toast.error(text("resummarize.failed", "重新总结失败"), { description: msg });
      handleResummaryFinished(fileId, false, "rerun", {});
    }
  }, [
    selectedItemId,
    defaultTemplateId,
    currentFileSummarizing,
    fileDetail,
    handleResummaryStarted,
    handleResummaryFinished,
    rerunSummary,
    qc,
    text,
  ]);

  // Beta Lynclaw summary: generate from the transcript via the agent service,
  // then insert the result as a real cloud conclusion — it renders as a
  // regular summary tab (editable, deletable, synced), no AI task involved.
  const lynclawTabsEnabled = isLynclawSummaryTabsEnabled();
  const handleLynclawApply = useCallback(async (fileId: string, format: LynclawSummaryFormat): Promise<FileConclusion> => {
    let stage = "summarize-cloud-recording";
    try {
      const body = await generateCloudLynclawSummary(fileId, format, i18n.resolvedLanguage ?? i18n.language);
      stage = "insert-conclusion";
      const conclusionText = encodeLynclawSummary(format, body);
      const teamId = files?.find((file) => file.id === fileId)?.teamId;
      const inserted = await insertFileConclusion({ fileId, conclusionText, ...(teamId ? { teamId } : {}) });
      // The insert contract returns the new id; tolerate id-bearing objects too.
      const insertedId = typeof inserted === "string" && inserted.trim()
        ? inserted.trim()
        : typeof inserted === "object" && inserted !== null
          ? String((inserted as { id?: unknown }).id ?? "").trim()
          : String(inserted ?? "").trim();
      // Refresh the conclusions list so this tab becomes server-backed (the
      // pending-tab merge alone never reaches the delete/edit mutations' cache).
      void qc.invalidateQueries({ queryKey: ["file-conclusions", fileId] });
      if (!insertedId) throw new Error("Conclusion insert returned no id");
      return { id: insertedId, fileId, conclusionText, templateName: "", createdAt: new Date().toISOString() };
    } catch (error) {
      logLynclawSummaryFailure(stage, format, error);
      // LynclawSummaryError messages are i18n keys — resolve them for the dialog's error toast.
      throw error instanceof LynclawSummaryError ? new Error(t(error.message)) : error;
    }
  }, [files, i18n, t, qc]);

  // Regenerate a Lynclaw summary tab in place — same pipeline as the dialog
  // entry, routed through the shared pending-tab lifecycle.
  const handleLynclawRegenerate = useCallback(async (tab: SummaryTabModel) => {
    const fileId = selectedItemId;
    if (!fileId || !tab.lynclawFormat || currentFileSummarizing || isLocalSelectedItem) return;
    const pendingId = `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    handleResummaryStarted(fileId, "add", { pendingId, templateName: tab.name });
    try {
      const conclusion = await handleLynclawApply(fileId, tab.lynclawFormat);
      handleResummaryFinished(fileId, true, "add", { pendingId, conclusion });
      toast.success(text("resummarize.success", "总结已重新生成"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : text("resummarize.unknown_error", "未知错误");
      toast.error(text("resummarize.failed", "重新总结失败"), { description: msg });
      handleResummaryFinished(fileId, false, "add", { pendingId });
    }
  }, [selectedItemId, currentFileSummarizing, isLocalSelectedItem, handleResummaryStarted, handleResummaryFinished, handleLynclawApply, text]);

  const handleDeleteSummary = useCallback((conclusionId: string, idx: number) => {
    if (!selectedItemId) return;
    // Stage the deletion; the themed confirm dialog fires the mutation.
    setPendingDeleteSummary({ conclusionId, idx });
  }, [selectedItemId]);

  const confirmDeleteSummary = useCallback(() => {
    if (!pendingDeleteSummary) return;
    const { conclusionId, idx } = pendingDeleteSummary;
    // The local deep summary has no cloud conclusion — clearing the record's
    // summary fields is the delete. A 重新总结 regenerates from scratch.
    if (conclusionId === LOCAL_SUMMARY_TAB_ID && isLocalSelectedItem) {
      void getDesktopLocalTranscriptionApi()
        ?.saveSummary(selectedItemId!, null, "")
        .then(() => refreshLocalQueries(selectedItemId))
        .catch(() => undefined);
      setPendingDeleteSummary(null);
      if (contentTab === `summary-${idx}`) setContentTab("outline");
      return;
    }
    deleteConclusion.mutate(conclusionId, {
      onSuccess: () => {
        setPendingDeleteSummary(null);
        // Lynclaw tabs live in the pending model until the refetch lands — drop
        // the deleted id immediately so the tab never outlives its server row.
        setPendingSummaryTabsByFile((current) => {
          const tabs = selectedItemId ? current[selectedItemId] : undefined;
          if (!tabs?.some((tab) => tab.id === conclusionId)) return current;
          return { ...current, [selectedItemId!]: tabs.filter((tab) => tab.id !== conclusionId) };
        });
        if (contentTab === `summary-${idx}`) {
          const nextIdx = idx > 0 ? idx - 1 : 0;
          setContentTab(visibleConclusionTexts.length > 1 ? `summary-${nextIdx}` : "outline");
        }
      },
      onError: () => setPendingDeleteSummary(null),
    });
  }, [pendingDeleteSummary, deleteConclusion, contentTab, setContentTab, visibleConclusionTexts.length, isLocalSelectedItem, selectedItemId, refreshLocalQueries, setPendingSummaryTabsByFile]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center border-b border-border/50 bg-background/80 px-4 backdrop-blur-xl" style={{ height: TAB_BAR_HEIGHT }}>
        <ScrollableTabs activeTab={contentTab}>
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
            <span>{isDesktop ? t("workspace.desktop_transcript") : t("workspace.transcription")}</span>
          </TabButton>
          {hasRecordingMarks && (
            <TabButton
              active={contentTab === "marks"}
              onClick={() => setContentTab("marks")}
            >
              <Bookmark className="size-3.5" />
              <span>{t("workspace.marks")}</span>
            </TabButton>
          )}
          <TabButton
            active={contentTab === "chapters"}
            onClick={() => setContentTab("chapters")}
          >
            <Clock className="size-3.5" />
            <span>{t("workspace.chapters")}</span>
          </TabButton>
          {liveNotes && (
            <TabButton
              active={contentTab === "notes"}
              onClick={() => setContentTab("notes")}
            >
              <Sparkles className="size-3.5" />
              <span>{t("live_translation.notes_title")}</span>
            </TabButton>
          )}
          {visibleConclusionTexts.map((block, idx) => (
            <ContextMenu key={block.key}>
              <ContextMenuTrigger>
                <TabButton
                  active={contentTab === `summary-${idx}`}
                  onClick={() => setContentTab(`summary-${idx}`)}
                >
                  <Sparkles className="size-3.5 shrink-0" />
                  <span className="max-w-28 truncate" title={block.name || t("workspace.summary")}>{block.name || t("workspace.summary")}</span>
                </TabButton>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {block.id !== LOCAL_SUMMARY_TAB_ID && !block.lynclawFormat && (
                  <ContextMenuItem
                    onClick={() => {
                      setSelectedConclusionIdForTemplate(block.id);
                      setSummaryDialogMode("replace");
                      setResummarizeOpen(true);
                    }}
                    disabled={currentFileSummarizing || !block.id}
                  >
                    <RefreshCw className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                    <span>{text("summary_tab.replace_template", summaryTabFallback.replaceTemplate)}</span>
                  </ContextMenuItem>
                )}
                {block.id === LOCAL_SUMMARY_TAB_ID ? (
                  <ContextMenuItem
                    onClick={() => void handleRegenerateLocalSummary()}
                    disabled={regeneratingLocalSummary}
                  >
                    <RefreshCw className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                    <span>{t("resummarize.button")}</span>
                  </ContextMenuItem>
                ) : block.lynclawFormat ? (
                  <ContextMenuItem
                    onClick={() => void handleLynclawRegenerate(block)}
                    disabled={!selectedItemId || currentFileSummarizing}
                  >
                    <RefreshCw className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                    <span>{t("resummarize.button")}</span>
                  </ContextMenuItem>
                ) : (
                  <ContextMenuItem
                    onClick={handleAutoRerun}
                    disabled={!selectedItemId || currentFileSummarizing || !defaultTemplateId}
                  >
                    <RefreshCw className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                    <span>{t("resummarize.button")}</span>
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  onClick={() => handleDeleteSummary(block.id, idx)}
                  disabled={deleteConclusion.isPending || !block.id}
                >
                  <Trash2 className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                  <span>{text("summary_tab.delete", summaryTabFallback.delete)}</span>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
          {noteTabs.map((note) => (
            <TabButton
              key={note.id}
              active={contentTab === `note-${note.id}`}
              onClick={() => setContentTab(`note-${note.id}`)}
            >
              <span className="max-w-28 truncate" title={note.title}>{note.title}</span>
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
            disabled={!selectedItemId || currentFileSummarizing || (isLocalSelectedItem && !getCustomModelsApi())}
            className="ml-0.5 flex shrink-0 items-center justify-center rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-[color,background-color,transform] duration-(--duration-quick) hover:bg-accent/50 hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
            title={t("add_summary.button")}
          >
            <Plus className="size-3.5" />
          </button>
        </ScrollableTabs>
        {selectedItemId && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground"
              title="More actions"
            >
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {activeSummary?.id !== LOCAL_SUMMARY_TAB_ID && !activeSummary?.lynclawFormat && (
                <DropdownMenuItem
                  onClick={() => {
                    if (!activeSummary?.id) return;
                    setSelectedConclusionIdForTemplate(activeSummary.id);
                    setSummaryDialogMode("replace");
                    setResummarizeOpen(true);
                  }}
                  disabled={currentFileSummarizing || !activeSummary?.id}
                >
                  <RefreshCw className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                  <span>{text("summary_tab.replace_template", summaryTabFallback.replaceTemplate)}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  if (!activeSummary?.id || activeSummaryIdx < 0) return;
                  handleDeleteSummary(activeSummary.id, activeSummaryIdx);
                }}
                disabled={deleteConclusion.isPending || !activeSummary?.id}
              >
                <Trash2 className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                <span>{text("summary_tab.delete", summaryTabFallback.delete)}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => (isLocalSelectedItem ? void handleRegenerateLocalSummary() : handleAutoRerun())}
                disabled={!selectedItemId || currentFileSummarizing || (!isLocalSelectedItem && !defaultTemplateId) || regeneratingLocalSummary}
              >
                <RefreshCw className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                <span>{t("resummarize.button")}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Export the current summary to a connected document provider
                  (PRD FR-3). Renders nothing while Connections is off. */}
              <SummaryExportMenuItem
                fileId={selectedItemId}
                disabled={currentFileSummarizing || !activeSummary?.id}
              />
              <DropdownMenuSeparator />
              {/* Share the whole note as markdown / PDF / themed image. The
                  dialog renders at panel level — see ShareNoteMenuItem doc. */}
              <ShareNoteMenuItem
                onOpen={() => setShareOpen(true)}
                disabled={
                  currentFileSummarizing ||
                  isLocalSelectedItem ||
                  (!outlineRaw && conclusionTexts.length === 0)
                }
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Content area */}
      <div className="flex flex-1 min-h-0">
        <div className={`flex-1 min-w-0 ${contentTab === "transcription" ? "overflow-hidden" : "overflow-auto"}`}>
          {!selectedItemId ? (
            <EmptyState />
          ) : offlineVaultMarkdown && contentTab !== "marks" ? (
            <OfflineVaultView markdown={offlineVaultMarkdown} />
          ) : isLoading && contentTab !== "marks" ? (
            <LoadingState />
          ) : (
            <div className={`px-3 py-6 ${contentTab === "transcription" ? "flex flex-col h-full" : "min-h-full flex flex-col"}`}>
              <input
                type="text"
                value={displayTitle ?? ""}
                onChange={(e) => {
                  if (!selectedItemId) return;
                  setEditedTitle({ itemId: selectedItemId, title: e.target.value });
                }}
                placeholder={t("workspace.enter_filename")}
                className="w-full border-none bg-transparent text-[1.75rem] font-bold leading-[1.25] tracking-[-0.02em] outline-none placeholder:text-muted-foreground/50 shrink-0"
              />
              {isLocalSelectedItem && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {effectiveLocalStatus &&
                    effectiveLocalStatus !== "completed" &&
                    effectiveLocalStatus !== "recorded" && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                        {t(LOCAL_STATUS_LABEL_KEY[effectiveLocalStatus])}
                      </span>
                    )}
                  {localStatus === "failed" && !selectedLocalRetrying && (
                    <button
                      type="button"
                      onClick={handleRetryLocalTranscription}
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <RefreshCw className="size-3" />
                      {t("workspace.retry")}
                    </button>
                  )}
                  {/* Live-session recordings can still join the cloud after the
                      fact — the completion dialog's "保存到云" is not the last
                      chance. Hidden once the record reports "synced". */}
                  {isLiveLocalSelectedItem &&
                    selectedFile?.cloudSyncStatus !== "synced" && (
                      <button
                        type="button"
                        disabled={uploadingLocalRecording}
                        onClick={handleUploadLocalRecording}
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                      >
                        {uploadingLocalRecording ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Upload className="size-3" />
                        )}
                        {t("workspace.upload_to_cloud")}
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
                  {localRetryError && (
                    <span className="basis-full text-2xs text-destructive">
                      {localRetryError}
                    </span>
                  )}
                </div>
              )}
              {selectedCreatedAt && (
                <div className="mt-1 text-2xs text-muted-foreground shrink-0 tabular-nums">
                  {formatDate(selectedCreatedAt, i18n.language)}
                </div>
              )}

              {/* Replace-mode status line: the old summary stays readable while
                  it regenerates, so say so explicitly (shimmering label). */}
              {summaryRegenOverlay && (
                <div className="animate-in fade-in mt-3 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span className="animate-chat-text-shimmer">{t("resummarize.generating_title")}</span>
                </div>
              )}

              <div ref={contentPreviewRef} className={`content-preview mt-2 flex-1 min-h-0 ${contentTab === "transcription" || contentTab === "chapters" ? "lyse-transcription-preview flex flex-col flex-1 min-h-0" : ""}`}>
                {/* Keyed by the resummary lifecycle: leaving the pending state
                    remounts this box and replays its entrance fade on the fresh
                    content instead of hard-swapping. While a replace regenerates
                    in place, the same box dims — and the opacity transition
                    plays the reveal when the new text arrives. */}
                <div
                  key={`${currentFileRerunning ? "pending" : "done"}-${activeSummary?.status ?? "idle"}`}
                  className={`flex flex-1 min-h-0 flex-col transition-[opacity,filter] duration-300 ease-out animate-in fade-in slide-in-from-bottom-2 ${summaryRegenOverlay ? "opacity-40 blur-[1px]" : ""}`}
                >
                {contentTab === "marks" ? (
                  <RecordingMarksPanel {...recordingMarks} />
                ) : currentFileRerunning ? (
                  <ResummaryPendingState />
                ) : currentFileResummaryError ? (
                  <ResummaryErrorState
                    action={
                      isLocalSelectedItem && (localStatus === "recorded" || localStatus === "failed")
                        ? // No transcript exists — a summary rerun would fail the
                          // same way. The actual recovery is transcribing first.
                          {
                            label: t("workspace.transcribe_locally"),
                            onAction: () => void handleRetryLocalTranscription(),
                            busy: selectedLocalRetrying,
                          }
                        : {
                            label: t("workspace.regenerate"),
                            onAction: () => void (isLocalSelectedItem ? handleRegenerateLocalSummary() : handleAutoRerun()),
                            busy: currentFileSummarizing || regeneratingLocalSummary,
                            disabled: !isLocalSelectedItem && !defaultTemplateId,
                          }
                    }
                  />
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
                          <div className="content-preview-inner" dangerouslySetInnerHTML={{ __html: wrapCjkSpacing(outlineBody) }} />
                        )
                      ) : localTranscriptionActive ? (
                        /* An outline cannot exist before the transcript does, so
                           "暂无大纲" would read as a failure while a local job is
                           still running. Same predicate as the 转写 tab. */
                        <LocalTranscriptionPendingState retrying={selectedLocalRetrying} />
                      ) : isRecordedLocal ? (
                        <RecordedLocalActions
                          onLocalTranscribe={() => void handleRetryLocalTranscription()}
                          onUpload={() => void handleUploadLocalRecording()}
                          localBusy={selectedLocalRetrying}
                          uploadBusy={uploadingLocalRecording}
                        />
                      ) : (
                        <NoContentState label={t("workspace.no_outline")} />
                      )
                    )}

                    {(contentTab === "transcription" || contentTab === "chapters" || contentTab === "notes") && (
                      <div className="flex flex-col flex-1 min-h-0 space-y-3">
                        {/* Per-track listening for dual-channel recordings */}
                        {contentTab === "transcription" && isLocalSelectedItem && selectedTrackManifest && playerAudioUrl && (
                          <div className="flex w-full shrink-0 flex-wrap items-center gap-1.5">
                            {([
                              ["all", t("workspace.track_all")],
                              ["mic", t("workspace.track_local")],
                              ["system", t("workspace.track_remote")],
                            ] as const).filter(([value]) => value === "all" || selectedTrackManifest.tracks.some((track) => track.role === value)).map(([value, label]) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => setTrackFilter(value)}
                                className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                                  trackFilter === value
                                    ? "bg-accent text-accent-foreground"
                                    : "bg-muted/60 text-muted-foreground hover:bg-accent/40"
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                        {/* Echo-cancellation degraded: honest status + repair entry */}
                        {contentTab === "transcription" && isLocalSelectedItem && selectedAecDegraded && (
                          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
                            <span>{t("workspace.aec_degraded_banner")}</span>
                            {selectedLiveSessionId && (
                              <button
                                type="button"
                                disabled={reprocessing}
                                onClick={handleReprocessRecording}
                                className="rounded-md bg-accent px-2 py-0.5 text-xs text-accent-foreground disabled:opacity-60"
                              >
                                {reprocessing ? t("workspace.reprocessing") : t("workspace.reprocess")}
                              </button>
                            )}
                          </div>
                        )}
                        {/* A track's offline transcription failed: targeted retry */}
                        {contentTab === "transcription" && isLocalSelectedItem &&
                          (["mic", "system"] as const)
                            .filter((track) => selectedTrackStatuses?.[track]?.status === "failed")
                            .map((track) => (
                              <button
                                key={track}
                                type="button"
                                onClick={() => handleRetryTrack(track)}
                                className="w-full shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-left text-xs text-foreground hover:bg-destructive/20"
                              >
                                {(track === "mic" ? t("workspace.track_local") : t("workspace.track_remote")) +
                                  " · " +
                                  t("workspace.retry_track")}
                              </button>
                            ))}
                        {/* Audio player — shared by the 转写 and 章节 tabs; it
                            lives above tab-specific content so switching tabs
                            never unmounts it and chapter seeks keep working */}
                        {(playerAudioUrl || cloudAudio.managed) && (
                          <div className="w-full shrink-0">
                            <AudioPlayer
                              key={cloudAudio.managed ? cloudAudio.cacheKey : undefined}
                              ref={audioPlayerRef}
                              src={playerAudioUrl}
                              recordId={cloudAudio.audio?.id ?? (trackFilter === "all" ? selectedItemId : undefined)}
                              sourceIntervals={transcription?.audioSourceIntervals}
                              highlightTimeMs={highlightTimeMs}
                              durationHint={selectedFile?.durationSeconds}
                              animateWaveformLoading={contentTab === "transcription"}
                              download={cloudAudio.managed ? {
                                start: cloudAudio.download,
                                disabled: cloudAudio.checking || cloudAudio.job?.pending,
                                progress: cloudAudio.job?.pending ? cloudAudio.job.percent : undefined,
                                failed: cloudAudio.job?.failed,
                              } : undefined}
                              onEdit={contentTab === "transcription"
                                ? isLocalSelectedItem ? handleEditSelectedAudio : cloudAudio.audio ? handleEditCloudAudio : undefined
                                : undefined}
                            />
                          </div>
                        )}
                        {contentTab === "chapters" && (
                          <ChaptersPanel
                            segments={chapterSegments}
                            document={chaptersDocument}
                            status={
                              isLocalSelectedItem
                                ? chaptersStatus
                                : cloudChapterGenerationMatches && cloudChaptersMutation.isError
                                  ? "error"
                                  : undefined
                            }
                            error={
                              isLocalSelectedItem
                                ? chaptersError
                                : cloudChapterGenerationMatches && cloudChaptersMutation.error instanceof Error
                                  ? cloudChaptersMutation.error.message
                                  : cloudChaptersMutation.error
                                    ? String(cloudChaptersMutation.error)
                                    : null
                            }
                            busy={chapterBusy}
                            hasTranscript={chapterSegments.some((segment) => segment.text.trim())}
                            onGenerate={handleGenerateChapters}
                            onSeekChapter={handleSeekChapter}
                            onSaveEdits={handleSaveChapterEdits}
                          />
                        )}
                        {contentTab === "notes" && liveNotes && (
                          <div className="flex-1 min-h-0 overflow-y-auto">
                            <LiveNotesRecordView notes={liveNotes} />
                          </div>
                        )}
                        {/* Transcription segments or empty state */}
                        {contentTab === "transcription" && (localTranscriptionActive ? (
                          <LocalTranscriptionPendingState retrying={selectedLocalRetrying} />
                        ) : transSegments && transSegments.length > 0 ? (
                          <div className="lyse-transcription-list flex-1 min-h-0 overflow-y-auto space-y-1 text-sm leading-relaxed pb-4">
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
                                    <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{seg.time}</span>
                                    <span className="shrink-0 font-semibold text-xs" style={{ color }}>{seg.speaker}</span>
                                  </div>
                                  <p className="text-foreground mt-0.5">{seg.translatedText || seg.text}</p>
                                  {seg.translatedText && (
                                    <p className="mt-0.5 text-xs text-muted-foreground">{seg.text}</p>
                                  )}
                                  {isLocalSelectedItem && seg.id && (
                                    <div className="mt-1 flex flex-wrap items-center gap-1">
                                      {voiceprintDraft?.segmentId === seg.id ? (
                                        <>
                                          <input
                                            value={voiceprintDraft.name}
                                            onClick={(event) => event.stopPropagation()}
                                            onChange={(event) => setVoiceprintDraft({
                                              segmentId: seg.id,
                                              name: event.target.value,
                                            })}
                                            className="h-6 w-28 rounded border border-border bg-background px-1.5 text-3xs outline-none focus:border-primary"
                                          />
                                          <button
                                            type="button"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              handleCreateVoiceprint(seg.id, voiceprintDraft.name);
                                            }}
                                            className="inline-flex rounded border border-border px-1.5 py-0.5 text-3xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                          >
                                            保存
                                          </button>
                                          <button
                                            type="button"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              setVoiceprintDraft(null);
                                            }}
                                            className="inline-flex rounded border border-border px-1.5 py-0.5 text-3xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                          >
                                            取消
                                          </button>
                                        </>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setVoiceprintDraft({ segmentId: seg.id, name: seg.speaker || "发言人" });
                                          }}
                                          className="inline-flex rounded border border-border px-1.5 py-0.5 text-3xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                        >
                                          保存声纹
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            <div className="mt-6 border-t border-border pt-3 text-center">
                              <p className="text-3xs text-muted-foreground/60">{t("workspace.ai_disclaimer")}</p>
                            </div>
                          </div>
                        ) : isLocalSelectedItem ? (
                          isRecordedLocal ? (
                            <RecordedLocalActions
                              onLocalTranscribe={() => void handleRetryLocalTranscription()}
                              onUpload={() => void handleUploadLocalRecording()}
                              localBusy={selectedLocalRetrying}
                              uploadBusy={uploadingLocalRecording}
                            />
                          ) : (
                            <NoContentState label={t("workspace.no_transcription")} />
                          )
                        ) : (
                          <TranscriptionGeneratePrompt
                            hint={t("workspace.transcription_generate_hint")}
                            buttonText={t("workspace.transcription_generate_button")}
                            onGenerate={handleAutoRerun}
                            disabled={currentFileSummarizing || !defaultTemplateId}
                          />
                        ))}
                      </div>
                    )}

                    {/* Single summary tab */}
                    {activeSummaryIdx >= 0 && visibleConclusionTexts[activeSummaryIdx] && (() => {
                      const block = visibleConclusionTexts[activeSummaryIdx]!;
                      if (block.status === "pending") return <ResummaryPendingState />;
                      if (block.status === "error") return (
                        <ResummaryErrorState action={{
                          label: t("workspace.retry"),
                          disabled: currentFileSummarizing,
                          onAction: () => {
                            if (!selectedItemId) return;
                            setSummaryRetryTarget({ fileId: selectedItemId, key: block.key });
                            setSelectedConclusionIdForTemplate(null);
                            setSummaryDialogMode("add");
                            setResummarizeOpen(true);
                          },
                        }} />
                      );
                      const html = block.lynclawFormat ? block.lynclawFormat === "html" : isHtmlContent(block.text);
                      if (sourceViewVisible) {
                        return <SourceView code={block.text} language={html ? "html" : "markdown"} />;
                      }
                      return html ? (() => {
                        const { content, scopedStyles } = extractBody(block.text);
                        return (
                          <>
                            {scopedStyles && <style dangerouslySetInnerHTML={{ __html: scopedStyles }} />}
                            <div className="content-preview-inner" dangerouslySetInnerHTML={{ __html: wrapCjkSpacing(content) }} />
                          </>
                        );
                      })() : (
                        /* Markdown summary + always-visible docked editing rail:
                           the rail stays pinned to the left edge while the user
                           browses, so formatting stays one click away. */
                        <div className="flex min-h-0 flex-1 items-stretch gap-2">
                          <DockedMarkdownToolbar editor={summaryEditor} />
                          <div className="min-w-0 flex-1">
                            <SummaryMarkdownEditor
                              content={block.text}
                              onChange={(markdown) => handleConclusionChange(block.id, markdown, block.lynclawFormat)}
                              onEditorReady={setSummaryEditor}
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {/* Note tab */}
                    {activeNoteId && (
                      <NoteContent key={activeNoteId} fileId={selectedItemId} noteId={activeNoteId} />
                    )}
                  </>
                )}
                </div>
              </div>

              {contentTab !== "transcription" && contentTab !== "marks" && (
                <div className="mt-2 border-t border-stroke-quaternary pt-1.5 pb-1 text-center shrink-0">
                  <p className="text-3xs text-muted-foreground/60">{t("workspace.ai_disclaimer")}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Floating outline sidebar */}
        {outlineSidebarVisible && contentTab === "outline" && selectedItemId && (
          <div className="w-52 shrink-0 border-l border-stroke-tertiary bg-background overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b border-stroke-tertiary">
              <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">{t("workspace.outline")}</span>
              <button onClick={toggleOutlineSidebar} className="text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            </div>
            <div className="p-2">
              {headings.map((h) => (
                <button
                  key={h.id}
                  onClick={() => scrollToHeading(h.id)}
                  className={`block w-full text-left rounded px-2 py-1 text-2xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors ${
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
        onOpenChange={(open) => {
          setResummarizeOpen(open);
          if (!open) setSummaryRetryTarget(null);
        }}
        fileId={selectedItemId}
        conclusionId={selectedConclusionIdForTemplate}
        mode={summaryDialogMode}
        onStarted={handleResummaryStarted}
        onFinished={handleResummaryFinished}
        onLynclawApply={lynclawTabsEnabled ? handleLynclawApply : undefined}
        localOnly={isLocalSelectedItem}
        onCustomModelApply={handleCustomModelApply}
      />

      {/* Outside the dropdown tree: closing the ⋯ menu unmounts its subtree,
          which would kill a dialog mounted inside it. */}
      <ShareNoteDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        fileId={selectedItemId}
        title={displayTitle}
        createdAt={selectedCreatedAt}
        outlineText={outlineRaw}
        /* 分享当前正看的这份总结：Lynclaw 总结 tab 的分享只带 activeSummary，
           没有激活 tab 时退回全部总结的旧行为。 */
        conclusions={
          activeSummary
            ? [{
                id: activeSummary.id,
                name: activeSummary.name,
                text: activeSummary.text,
              }]
            : conclusionTexts
        }
      />

      <DeleteConfirmDialog
        open={pendingDeleteSummary !== null}
        description={text("summary_tab.delete_confirm", summaryTabFallback.deleteConfirm)}
        pending={deleteConclusion.isPending}
        onConfirm={confirmDeleteSummary}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteSummary(null);
        }}
      />
    </div>
  );
}

function ResummaryPendingState() {
  const { t } = useTranslation();
  return (
    <TaskState
      pending
      title={t("resummarize.generating_title")}
      description={t("resummarize.generating_description")}
    />
  );
}

function ResummaryErrorState({
  action,
}: {
  /** Prominent recovery button rendered under the failure text. Callers pick
   *  the right recovery: rerun the summary, or — for a local recording with no
   *  transcript — transcribe first, since a rerun would only fail again. */
  action?: TaskRecoveryAction;
}) {
  const { t } = useTranslation();
  return (
    <TaskState
      title={t("resummarize.error_title")}
      description={t("resummarize.error_description")}
      action={action}
    />
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
  const [noteEditor, setNoteEditor] = useState<import("@milkdown/kit/core").Editor | null>(null);

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

  return (
    <div className="flex min-h-0 flex-1 items-stretch gap-2">
      <DockedMarkdownToolbar editor={noteEditor} />
      <div className="min-w-0 flex-1">
        <SummaryMarkdownEditor content={content} onChange={handleChange} onEditorReady={setNoteEditor} />
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      data-tab-active={active ? "true" : undefined}
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

function ScrollableTabs({ activeTab, children }: { activeTab: string; children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemCount = Children.toArray(children).length;
  const { t } = useTranslation();
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateArrows = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const { scrollLeft, scrollWidth, clientWidth } = container;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  // Keep arrow visibility in sync with overflow + scroll position.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    updateArrows();
    const onScroll = () => updateArrows();
    container.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateArrows());
    ro.observe(container);
    return () => {
      container.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [updateArrows, itemCount]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>('[data-tab-active="true"]');
    if (!active) return;
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.left < containerRect.left) {
      container.scrollBy({ left: activeRect.left - containerRect.left - 4, behavior: "smooth" });
    } else if (activeRect.right > containerRect.right) {
      container.scrollBy({ left: activeRect.right - containerRect.right + 4, behavior: "smooth" });
    }
  }, [activeTab, itemCount]);

  const scrollByDir = (dir: 1 | -1) => {
    const container = containerRef.current;
    if (!container) return;
    const amount = Math.max(container.clientWidth * 0.7, 140);
    container.scrollBy({ left: dir * amount, behavior: "smooth" });
  };

  return (
    <div className="flex flex-1 min-w-0 items-center gap-0.5">
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scrollByDir(-1)}
          aria-label={t("workspace.scroll_tabs_left")}
          title={t("workspace.scroll_tabs_left")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-(--duration-quick) hover:bg-accent/50 hover:text-foreground active:scale-[0.96]"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}
      <div
        ref={containerRef}
        onWheel={(event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            event.currentTarget.scrollLeft += event.deltaY;
          }
        }}
        className="flex flex-1 min-w-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {canScrollRight && (
        <button
          type="button"
          onClick={() => scrollByDir(1)}
          aria-label={t("workspace.scroll_tabs_right")}
          title={t("workspace.scroll_tabs_right")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-(--duration-quick) hover:bg-accent/50 hover:text-foreground active:scale-[0.96]"
        >
          <ChevronRight className="size-4" />
        </button>
      )}
    </div>
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
  heading: "#a5a9f5",     // indigo — markdown headings
  code: "#ffa657",        // orange — inline code
  link: "#d2a8ff",        // purple — links
  // CSS (inside <style>)
  cssProp: "#a5a9f5",     // indigo — CSS property names
  cssValue: "#e5e5e7",    // light gray — CSS property values
  cssVar: "#888888",      // gray — CSS variable declarations
  cssVarRef: "#c7c9ff",   // light indigo — var(--xxx) references
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
    const css = cssBody
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
    const highlightedAttrs = attrs
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
export function SourceView({ code, language }: { code: string; language: "html" | "markdown" }) {
  const { highlighted, images } = useMemo(() => {
    const { cleaned, images } = extractBase64Images(code);
    return { highlighted: highlightCode(cleaned, language), images };
  }, [code, language]);

  return (
    <div className="rounded-md overflow-auto flex-1 min-h-0" style={{ backgroundColor: "#0d1117", border: "1px solid #30363d" }}>
      <div className="sticky top-0 flex items-center gap-2 px-3 py-1.5" style={{ backgroundColor: "#161b22", borderBottom: "1px solid #30363d" }}>
        <span className="text-3xs font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>
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
          <div className="text-3xs font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>
            Image Previews ({images.length})
          </div>
          {images.map((dataUri, i) => (
            <div key={i} className="rounded-md overflow-hidden" style={{ border: "1px solid #30363d" }}>
              <div className="px-3 py-1 text-3xs" style={{ backgroundColor: "#161b22", color: "#8b949e", borderBottom: "1px solid #30363d" }}>
                Image {i + 1}
              </div>
              <div className="p-3 flex justify-center" style={{ backgroundColor: "#0d1117" }}>
                <img
                  src={dataUri}
                  alt={`base64-image-${i + 1}`}
                  className="max-w-full rounded outline outline-1 -outline-offset-1 outline-white/10"
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
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-6 text-center">
      <div className="relative mx-auto mb-5 flex size-16 items-center justify-center rounded-[20px] border border-border bg-card text-primary shadow-sm">
        <FileText className="size-7" strokeWidth={1.5} />
      </div>
      <h3 className="relative text-base font-semibold tracking-tight text-foreground">
        {t("workspace.no_file_selected")}
      </h3>
      <p className="relative mt-2 text-sm leading-6 text-muted-foreground">
        {t("workspace.select_file_hint")}
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    // Prose-shaped skeleton: mirrors a note document (title + paragraphs)
    // instead of a spinner, so the panel doesn't jarringly reflow on load.
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 px-8 py-10" aria-hidden>
      <span className="h-6 w-2/5 animate-pulse rounded bg-muted-foreground/10" />
      <div className="flex flex-col gap-3">
        {[100, 92, 96, 60].map((width, i) => (
          <span
            key={i}
            className="h-3.5 animate-pulse rounded bg-muted-foreground/10"
            style={{ width: `${width}%` }}
          />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {[95, 88, 40].map((width, i) => (
          <span
            key={i}
            className="h-3.5 animate-pulse rounded bg-muted-foreground/10"
            style={{ width: `${width}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Read-only rendering of the note's local vault file when the cloud content
 *  queries fail offline. */
function OfflineVaultView({ markdown }: { markdown: string }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text">
        <FileText className="size-3.5 shrink-0" />
        <span>{t("vault.offline_banner")}</span>
      </div>
      <div className="min-w-0">
        <MilkdownViewer content={stripVaultFrontmatter(markdown)} />
      </div>
    </div>
  );
}

function LocalTranscriptionPendingState({ retrying }: { retrying: boolean }) {
  const { t } = useTranslation();
  return (
    <TaskState
      pending
      title={t(retrying ? "workspace.local_retranscribing" : "workspace.local_transcribing")}
      description={t("workspace.local_transcribing_hint")}
    />
  );
}

function NoContentState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/** Audio-only local recording (`recorded`): no transcript exists and nothing
 *  is running. Offers the two ways forward — run the local engine, or upload
 *  to the cloud and let the server pipeline transcribe (spends credits). */
function RecordedLocalActions({
  onLocalTranscribe,
  onUpload,
  localBusy,
  uploadBusy,
}: {
  onLocalTranscribe: () => void;
  onUpload: () => void;
  localBusy: boolean;
  uploadBusy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <FileAudio className="size-6" />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">
        {t("workspace.recorded_no_transcription_hint")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="contrast"
          size="lg"
          type="button"
          onClick={onLocalTranscribe}
          disabled={localBusy || uploadBusy}
          aria-busy={localBusy || undefined}
          className="gap-2 px-5"
        >
          {localBusy ? <ActivityIndicator className="size-4" /> : <Cpu className="size-4" />}
          <span>{t("workspace.transcribe_locally")}</span>
        </Button>
        <Button
          variant="outline"
          size="lg"
          type="button"
          onClick={onUpload}
          disabled={localBusy || uploadBusy}
          aria-busy={uploadBusy || undefined}
          className="gap-2 px-5"
        >
          {uploadBusy ? <ActivityIndicator className="size-4" /> : <Upload className="size-4" />}
          <span>{t("workspace.upload_and_transcribe")}</span>
        </Button>
      </div>
    </div>
  );
}

function TranscriptionGeneratePrompt({
  hint,
  buttonText,
  onGenerate,
  disabled,
}: {
  hint: string;
  buttonText: string;
  onGenerate: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-1 w-full flex-col items-center justify-center gap-5 py-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <MessageSquare className="size-6" />
      </div>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <Button
        variant="contrast"
        size="lg"
        type="button"
        onClick={onGenerate}
        disabled={disabled}
        className="gap-2 px-6"
      >
        <Sparkles className="size-4" />
        <span>{buttonText}</span>
      </Button>
    </div>
  );
}

function formatDate(dateStr: string, locale: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString(locale || "en", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return dateStr; }
}

/** Read-only rendering of a recorded session's structured notes (the record's
 *  notesJson). Reuses the live panel presentation with an idle state — no
 *  engine, no timers, no fresh badges. */
function LiveNotesRecordView({ notes }: { notes: MeetingNotes }) {
  const state: LiveNotesState = {
    sessionId: null,
    notes,
    status: "done",
    freshTopicIds: [],
    error: null,
    updatedAt: null,
  };
  return <LiveNotesPanel state={state} />;
}
