"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useWorkspaceStore } from "../workspace/store";
import { ContentPanel } from "../workspace/content-panel";
import { ChatPanel } from "../workspace/right-panel/chat-panel";
import { ResizableHandle } from "../workspace/resizable-handle";
import { TitleBar } from "../layout/title-bar";
import {
  useNotes,
  useDeleteWorkspaceFiles,
  useTranscriptionStatus,
  useRerunSummary,
  useTemplateCategories,
  isTranscriptionCompleted,
} from "../workspace/hooks/use-files";
import { useMoveFiles } from "../workspace/hooks/use-folder-mutations";
import { useFolders } from "../workspace/hooks/use-folders";
import { FileRowContextMenu } from "../workspace/middle-panel/file-row-context-menu";
import { filterWorkspaceFilesByFolder } from "../workspace/middle-panel/file-list-filter";
import { LOCAL_TRANSCRIPTION_FOLDER_ID, isLocalFileId } from "../workspace/local-transcription";
import {
  getDesktopVaultApi,
  markVaultLastSync,
  syncAllNotesToVault,
  useVaultConfig,
} from "../workspace/note-vault";
import { isNoteUnread, markNoteSeen, useSeenMap } from "./seen";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { useAuthStore } from "@lynse/core/auth";
import { useNotificationStore } from "../notifications/use-notification-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import {
  FolderOpen,
  FileAudio,
  Layers,
  Trash2,
  Circle,
  Filter,
  LayoutGrid,
  List,
  X,
  Loader2,
  RefreshCw,
  Monitor,
  Save,
} from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import type { WorkspaceItem, FolderInfo } from "../workspace/types";

type ViewMode = "list" | "grid";

/**
 * Local cache of the notes list, so a refresh (or app reload) paints the last
 * known list immediately instead of flashing an empty state while the first
 * request is in flight. Best-effort only — never blocks rendering.
 */
const NOTES_CACHE_KEY = "lynse_notes_cache_v1";
const NOTES_CACHE_LIMIT = 500;

function loadNotesCache(): WorkspaceItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(NOTES_CACHE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WorkspaceItem[]) : [];
  } catch {
    return [];
  }
}

function saveNotesCache(items: WorkspaceItem[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(NOTES_CACHE_KEY, JSON.stringify(items.slice(0, NOTES_CACHE_LIMIT)));
  } catch {
    // Ignore quota / serialization errors: the cache is best-effort.
  }
}

/** Format a Date as the backend's `YYYY-MM-DDTHH:MM:SS` (no timezone suffix). */
function toApiDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

type TimeBucket = "today" | "yesterday" | "thisWeek" | "thisMonth" | "lastMonth" | "month";

interface TimeSection {
  key: string;
  label: string;
  items: WorkspaceItem[];
}

/**
 * Fallback labels (zh) used only when the i18n key is not yet loaded
 * (e.g. a hot-reloaded session whose i18next instance predates the key).
 * Prevents the raw key `notes.time_*` from ever reaching the UI.
 */
const TIME_LABEL_FALLBACK: Record<string, string> = {
  today: "今天",
  yesterday: "昨天",
  thisWeek: "本周",
  thisMonth: "本月",
  lastMonth: "上个月",
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Monday-based start of the current week. */
function startOfWeekMonday(d: Date): Date {
  const day = startOfDay(d);
  const diff = (day.getDay() + 6) % 7; // 0 = Monday
  return addDays(day, -diff);
}

/**
 * Bucket workspace files into time-based sections (newest first):
 * 今天 / 昨天 / 本周 / 本月 / 上个月, then older months labeled by YYYY年M月.
 * Each file is assigned to the first matching bucket, so sections never overlap.
 */
function getTimeSections(
  files: WorkspaceItem[],
  t: (key: string) => string,
  locale: string,
): TimeSection[] {
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = addDays(today, -1);
  const thisWeekStart = startOfWeekMonday(now);
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const sorted = [...files].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const fixed: Record<Exclude<TimeBucket, "month">, WorkspaceItem[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    thisMonth: [],
    lastMonth: [],
  };
  const monthly = new Map<string, WorkspaceItem[]>();

  for (const f of sorted) {
    const d = new Date(f.createdAt);
    if (Number.isNaN(d.getTime())) {
      fixed.thisMonth.push(f);
      continue;
    }
    if (d >= today) fixed.today.push(f);
    else if (d >= yesterday) fixed.yesterday.push(f);
    else if (d >= thisWeekStart) fixed.thisWeek.push(f);
    else if (d >= thisMonthStart) fixed.thisMonth.push(f);
    else if (d >= lastMonthStart) fixed.lastMonth.push(f);
    else {
      const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
      const arr = monthly.get(monthKey);
      if (arr) arr.push(f);
      else monthly.set(monthKey, [f]);
    }
  }

  const monthFormatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" });
  const sections: TimeSection[] = [];
  const order: Exclude<TimeBucket, "month">[] = [
    "today",
    "yesterday",
    "thisWeek",
    "thisMonth",
    "lastMonth",
  ];
  for (const key of order) {
    if (fixed[key].length > 0) {
      const i18nKey = `notes.time_${key}`;
      const resolved = t(i18nKey);
      const label = resolved === i18nKey ? (TIME_LABEL_FALLBACK[key] ?? key) : resolved;
      sections.push({ key, label, items: fixed[key] });
    }
  }
  const monthKeys = Array.from(monthly.keys()).sort((a, b) => b.localeCompare(a));
  for (const k of monthKeys) {
    const [yStr, mStr] = k.split("-");
    const label = monthFormatter.format(new Date(Number(yStr), Number(mStr), 1));
    sections.push({ key: k, label, items: monthly.get(k)! });
  }
  return sections;
}

/** Press-and-hold duration (ms) before a row enters multi-select mode. */
const LONG_PRESS_MS = 400;

/**
 * Long-press a row to enter multi-select and select it. While multi-select is
 * active a plain click toggles the row instead of opening it, and the click
 * fired right after a long-press is suppressed. Same interactions as the
 * recordings list cards.
 */
function useLongPressSelection({
  multiMode,
  onOpen,
  onToggleSelect,
  onLongPressSelect,
}: {
  multiMode: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onLongPressSelect: () => void;
}) {
  const timer = useRef<number | null>(null);
  const didLongPress = useRef(false);

  const clearLongPress = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Cancel a pending timer if the row unmounts mid-press.
  useEffect(() => clearLongPress, [clearLongPress]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only the left button triggers long-press; right-click opens the context menu.
      if (e.button !== 0) return;
      didLongPress.current = false;
      clearLongPress();
      timer.current = window.setTimeout(() => {
        didLongPress.current = true;
        onLongPressSelect();
      }, LONG_PRESS_MS);
    },
    [clearLongPress, onLongPressSelect],
  );

  const onClick = useCallback(() => {
    clearLongPress();
    // Suppress the synthetic click that follows a long-press.
    if (didLongPress.current) {
      didLongPress.current = false;
      return;
    }
    if (multiMode) onToggleSelect();
    else onOpen();
  }, [clearLongPress, multiMode, onOpen, onToggleSelect]);

  return {
    onClick,
    onPointerDown,
    onPointerUp: clearLongPress,
    onPointerLeave: clearLongPress,
  };
}

export function NotesPage() {
  const { t, i18n } = useTranslation();
  const reduceMotion = useReducedMotion();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const chatPanelWidth = useWorkspaceStore((s) => s.chatPanelWidth);
  const notesListWidth = useWorkspaceStore((s) => s.notesListWidth);
  const setNotesListWidth = useWorkspaceStore((s) => s.setNotesListWidth);
  const handleChatPanelResize = useWorkspaceStore((s) => s.handleChatPanelResize);
  const selectedFileIds = useWorkspaceStore((s) => s.selectedFileIds);
  const toggleFileSelected = useWorkspaceStore((s) => s.toggleFileSelected);
  const selectAllFiles = useWorkspaceStore((s) => s.selectAllFiles);
  const clearFileSelection = useWorkspaceStore((s) => s.clearFileSelection);
  const summarizingFileIds = useWorkspaceStore((s) => s.summarizingFileIds);
  const setFileSummarizing = useWorkspaceStore((s) => s.setFileSummarizing);
  const layoutRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [isListResizing, setIsListResizing] = useState(false);
  // While the chat panel handle is dragged, its width animation is disabled so
  // the panel tracks the pointer 1:1 (same gate as workspace-layout.tsx).
  const [isChatPanelResizing, setIsChatPanelResizing] = useState(false);

  // Stable for the session: a bare `new Date()` here would change the query key
  // on every render, miss the cache and blank the list.
  const endTime = useMemo(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 0);
    return toApiDateTime(d);
  }, []);

  const { data: files } = useNotes({
    // Wide range → effectively "all my meetings" (recordings + their notes).
    startTime: "2020-01-01T00:00:00",
    endTime,
  });
  const { data: folders } = useFolders();

  // Right-click actions on a note row: move to another group / soft-delete.
  // Same mutations the workspace file list uses, so both views stay in sync
  // (both invalidate the notes list on success).
  const moveMutation = useMoveFiles();
  const deleteMutation = useDeleteWorkspaceFiles();
  const rerunMutation = useRerunSummary();
  const { data: templateCategories } = useTemplateCategories();

  // Batch transcription reuses the account-default template, same as the
  // content panel's "生成" button.
  const defaultTemplateId = useMemo(() => {
    const all = templateCategories?.flatMap((c) => c.templates) ?? [];
    return all.find((tpl) => tpl.isDefault === 1)?.id ?? all[0]?.id ?? "";
  }, [templateCategories]);

  const handleMoveFile = (targetIds: string[], newFolderId: string, oldFolderId: string) => {
    moveMutation.mutate({ oldFolderId, newFolderId, fileIds: targetIds });
    clearFileSelection();
  };

  const handleDeleteFile = (targetIds: string[]) => {
    if (window.confirm(t("workspace.delete_confirm"))) {
      deleteMutation.mutate(targetIds, {
        onSuccess: () => {
          if (targetIds.includes(selectedItemId ?? "")) {
            selectItem(null, null);
          }
          clearFileSelection();
        },
        onError: (error) => {
          toast.error(t("workspace.delete_failed", { error: error.message }));
        },
      });
    }
  };

  // Last known-good list, hydrated from localStorage on mount.
  const [cachedFiles, setCachedFiles] = useState<WorkspaceItem[]>(() => loadNotesCache());
  useEffect(() => {
    if (!Array.isArray(files)) return;
    // An empty authenticated list is real (e.g. every file was just deleted
    // via the context menu) and must empty the cache too, or deleted rows
    // would flash back on the next mount. Logged out the query is disabled
    // and never resolves to [].
    if (files.length === 0 && !isAuthenticated) return;
    setCachedFiles(files);
    saveNotesCache(files);
  }, [files, isAuthenticated]);

  // Render the cached list whenever the query has no data yet (initial load or
  // refetch), so the panel never goes blank.
  // Logged out → the notes query is disabled and `files` is undefined; never
  // surface cached cloud data in that state.
  const sourceFiles = files ?? (isAuthenticated ? cachedFiles : []);

  // One-click mirror of every cloud note into the local markdown vault.
  const vaultApi = getDesktopVaultApi();
  const { data: vaultConfig } = useVaultConfig();
  const [vaultSyncing, setVaultSyncing] = useState(false);
  const handleSyncVault = useCallback(async () => {
    if (!vaultApi || vaultSyncing) return;
    if (!vaultConfig?.enabled) {
      toast.info(t("vault.sync_disabled_hint"));
      return;
    }
    setVaultSyncing(true);
    const loadingToastId = toast.loading(t("vault.sync_started"));
    try {
      const summary = await syncAllNotesToVault(sourceFiles, {
        outline: t("vault.section_outline"),
        summary: t("vault.section_summary"),
      });
      markVaultLastSync();
      if (summary.failed > 0) {
        toast.error(
          t("vault.sync_partial", { written: summary.written, failed: summary.failed }),
          { id: loadingToastId },
        );
      } else {
        toast.success(t("vault.sync_done", { count: summary.written }), { id: loadingToastId });
      }
    } catch (error) {
      toast.error(t("vault.sync_failed", { error: error instanceof Error ? error.message : "" }), {
        id: loadingToastId,
      });
    } finally {
      setVaultSyncing(false);
    }
  }, [vaultApi, vaultSyncing, vaultConfig?.enabled, sourceFiles, t]);

  const folderList: FolderInfo[] = Array.isArray(folders) ? folders : [];
  const currentFolderName = useMemo(() => {
    if (selectedFolderId === "__all__") return t("layout.all_files");
    if (selectedFolderId === LOCAL_TRANSCRIPTION_FOLDER_ID) return t("layout.local_transcriptions");
    if (selectedFolderId === "__uncategorized__") return t("layout.uncategorized");
    if (selectedFolderId === "__trash__") return t("layout.trash");
    const found = folderList.find((f) => String(f.id) === selectedFolderId);
    return found?.folderName ?? t("layout.all_files");
  }, [selectedFolderId, folderList, t]);

  // Custom folders can carry a color; echoing its dot next to the header title
  // ties the header back to the option picked in the filter dropdown.
  const currentFolderColor = useMemo(
    () => folderList.find((f) => String(f.id) === selectedFolderId)?.color,
    [selectedFolderId, folderList],
  );

  const filteredFiles = useMemo(() => {
    if (!Array.isArray(sourceFiles)) return [];
    return filterWorkspaceFilesByFolder(sourceFiles, selectedFolderId);
  }, [sourceFiles, selectedFolderId]);

  // Unread dot: transcription finished but the note hasn't been opened since.
  // Cloud completion comes from the trans-status endpoint; local ids are
  // excluded from that query — they carry their own completed flag and would
  // never go terminal on the backend, keeping the poll alive forever.
  const cloudVisibleIds = useMemo(
    () => filteredFiles.filter((f) => !isLocalFileId(f.id)).map((f) => f.id).sort(),
    [filteredFiles],
  );
  const { data: transStatus } = useTranscriptionStatus(cloudVisibleIds);
  const seenMap = useSeenMap();
  const unreadIds = useMemo(() => {
    const set = new Set<string>();
    for (const file of filteredFiles) {
      const completed = isLocalFileId(file.id)
        ? file.transcriptionCompleted === true
        : isTranscriptionCompleted(transStatus?.[file.id]);
      if (isNoteUnread(file, completed, seenMap)) set.add(file.id);
    }
    return set;
  }, [filteredFiles, transStatus, seenMap]);

  // A transcription that finishes while the note is already open counts as read.
  useEffect(() => {
    if (!selectedItemId || unreadIds.size === 0) return;
    const current = filteredFiles.find((f) => f.id === selectedItemId);
    if (current && unreadIds.has(current.id)) markNoteSeen(current.id, current.updatedAt);
  }, [selectedItemId, unreadIds, filteredFiles]);

  const handleOpenNote = (file: WorkspaceItem) => {
    markNoteSeen(file.id, file.updatedAt);
    selectItem(file.id, "file", file.title);
  };

  // ── Multi-select (same interactions as the recordings list) ──
  // Long-press a row to enter multi-select; while active, clicks toggle the
  // checkbox and the context menu targets the whole selection.
  const multiMode = selectedFileIds.size > 0;
  const allSelected =
    filteredFiles.length > 0 && filteredFiles.every((f) => selectedFileIds.has(f.id));
  const someSelected = filteredFiles.some((f) => selectedFileIds.has(f.id));

  const handleLongPressSelect = (fileId: string) => {
    if (!selectedFileIds.has(fileId)) toggleFileSelected(fileId);
  };

  const toggleSelectAll = () => {
    if (allSelected) clearFileSelection();
    else selectAllFiles(filteredFiles.map((f) => f.id));
  };

  // Navigating away must drop a pending selection: the recordings list reads
  // the same store key and would otherwise show phantom checkboxes.
  useEffect(() => () => clearFileSelection(), [clearFileSelection]);

  // Which visible cloud files already have a completed transcription — drives
  // the batch menu label ("转写选中" vs "重新生成选中").
  const transcribedIds = useMemo(() => {
    const set = new Set<string>();
    if (transStatus) {
      for (const id of cloudVisibleIds) {
        if (isTranscriptionCompleted(transStatus[id])) set.add(id);
      }
    }
    return set;
  }, [transStatus, cloudVisibleIds]);

  // Sequential batch transcription — the backend runs ONE pipeline per account
  // at a time, so firing concurrently would hang the later files (see the
  // recordings list for the full rationale).
  const handleTranscribe = async (targetIds: string[]) => {
    if (!defaultTemplateId) return;
    // Local transcriptions never go through the cloud pipeline.
    const ids = targetIds.filter((id) => !isLocalFileId(id));
    if (ids.length === 0) {
      clearFileSelection();
      return;
    }
    for (const id of ids) {
      setFileSummarizing(id, true);
      try {
        await rerunMutation.mutateAsync({ fileId: id, templateId: defaultTemplateId });
        // Batch pipelines run for minutes and the user has usually walked away
        // — record each completion in the notification center as it lands.
        useNotificationStore.getState().add({
          id: `trans-complete:${id}:${Date.now()}`,
          type: "transcription",
          title: (filteredFiles.find((f) => f.id === id)?.title ?? "").trim(),
          href: "/notes",
        });
      } catch {
        // One failed file must not abort the rest of the batch; the failure
        // surfaces via the mutation's own error handling / cache invalidation.
      } finally {
        setFileSummarizing(id, false);
      }
    }
    clearFileSelection();
  };

  // ── Floating batch action bar (visible only in multi-select) ──
  const selectionIds = useMemo(() => Array.from(selectedFileIds), [selectedFileIds]);
  const canBatchTranscribe =
    !!defaultTemplateId && !selectionIds.some((id) => isLocalFileId(id));
  const selectionTranscribing = selectionIds.some((id) => summarizingFileIds.has(id));
  const batchTranscribeLabel = useMemo(() => {
    const allTranscribed =
      selectionIds.length > 0 && selectionIds.every((id) => transcribedIds.has(id));
    return allTranscribed ? t("workspace.regenerate_selected") : t("workspace.transcribe_selected");
  }, [selectionIds, transcribedIds, t]);
  // The move API takes the folder the files move out of; a mixed-folder
  // selection has no single origin, so fall back to "".
  const selectionOldFolderId = useMemo(() => {
    const items = filteredFiles.filter((f) => selectedFileIds.has(f.id));
    if (items.length === 0) return "";
    const first = items[0]?.folderId ?? "";
    return items.every((f) => (f.folderId ?? "") === first) ? first : "";
  }, [filteredFiles, selectedFileIds]);
  const movableFolders = useMemo(
    () => folderList.filter((f) => !String(f.id).startsWith("__")),
    [folderList],
  );

  // Per-group recording counts for the filter dropdown. Reuses the list's own
  // filter so a number always matches what selecting that group shows. Trash
  // is excluded — the notes query never returns trashed files.
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const ids = [
      "__all__",
      LOCAL_TRANSCRIPTION_FOLDER_ID,
      "__uncategorized__",
      ...folderList.map((f) => String(f.id)),
    ];
    for (const id of ids) {
      counts.set(id, filterWorkspaceFilesByFolder(sourceFiles, id).length);
    }
    return counts;
  }, [sourceFiles, folderList]);

  const timeSections = useMemo(
    () => getTimeSections(filteredFiles, t, i18n.language),
    [filteredFiles, t, i18n.language],
  );

  const handleSelectFolder = (folderId: string | null) => {
    selectFolder(folderId);
  };

  const handleNotesListResize = useCallback(
    (delta: number) => {
      const layoutWidth = layoutRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const currentWidth = listRef.current?.getBoundingClientRect().width ?? notesListWidth;
      const maxWidth = Math.max(300, Math.min(600, layoutWidth - 520));
      setNotesListWidth(currentWidth + delta, maxWidth);
    },
    [notesListWidth, setNotesListWidth],
  );

  const folderDropdownItems = (
    <DropdownMenuContent align="end" className="w-52">
      <DropdownMenuItem onClick={() => handleSelectFolder("__all__")}>
        <Layers className="mr-2 size-4 text-muted-foreground" strokeWidth={1.5} />
        <span className="flex-1">{t("layout.all_files")}</span>
        <FolderCount count={folderCounts.get("__all__")} />
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handleSelectFolder(LOCAL_TRANSCRIPTION_FOLDER_ID)}>
        <FileAudio className="mr-2 size-4 text-muted-foreground" strokeWidth={1.5} />
        <span className="flex-1">{t("layout.local_transcriptions")}</span>
        <FolderCount count={folderCounts.get(LOCAL_TRANSCRIPTION_FOLDER_ID)} />
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handleSelectFolder("__uncategorized__")}>
        <Circle className="mr-2 size-4 text-muted-foreground" strokeWidth={1.5} />
        <span className="flex-1">{t("layout.uncategorized")}</span>
        <FolderCount count={folderCounts.get("__uncategorized__")} />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {folderList.length === 0 && (
        <div className="px-2 py-1.5 text-2xs text-muted-foreground">{t("layout.no_folders")}</div>
      )}
      {folderList.map((folder) => (
        <DropdownMenuItem key={folder.id} onClick={() => handleSelectFolder(String(folder.id))}>
          {folder.color ? (
            <span className="mr-2 size-2.5 rounded-full" style={{ backgroundColor: folder.color }} />
          ) : (
            <Circle className="mr-2 size-4 text-muted-foreground" strokeWidth={1.5} />
          )}
          <span className="flex-1 truncate">{folder.folderName}</span>
          <FolderCount count={folderCounts.get(String(folder.id))} />
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => handleSelectFolder("__trash__")}>
        <Trash2 className="mr-2 size-4 text-muted-foreground" strokeWidth={1.5} />
        {t("layout.trash")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <div ref={layoutRef} className="flex h-full min-h-0 overflow-hidden bg-background">
      {/* Left: file list area */}
      <div
        ref={listRef}
        className={cn(
          "relative flex min-w-0 flex-col overflow-hidden",
          selectedItemId ? "shrink-0" : "flex-1",
          selectedItemId && !isListResizing ? "transition-[width] duration-300" : "",
        )}
        style={
          selectedItemId
            ? { width: `clamp(300px, ${notesListWidth}px, calc(100% - 520px))` }
            : undefined
        }
      >
        {/* Header: current group title (left) + actions (right) */}
        <div
          className="flex shrink-0 select-none items-center justify-between gap-3 border-b border-border/50 bg-background/80 px-4 py-3 backdrop-blur-xl"
          data-tauri-drag-region
        >
          {/* Current filter group — the only persistent indicator of which
              folder the list is scoped to (the funnel tooltip is hover-only). */}
          <div className="flex min-w-0 items-baseline gap-1.5">
            {currentFolderColor && (
              <span
                className="size-2.5 shrink-0 translate-y-[-1px] self-center rounded-full"
                style={{ backgroundColor: currentFolderColor }}
              />
            )}
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">{currentFolderName}</h2>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              ({filteredFiles.length})
            </span>
          </div>
          <div className="flex flex-col items-end gap-2" data-tauri-drag-region={false}>
            {multiMode ? (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={t("workspace.select_all")}
                  className="size-3.5 cursor-pointer accent-primary"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={toggleSelectAll}
                />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t("workspace.selected_count", { count: selectedFileIds.size })}
                </span>
                <button
                  type="button"
                  onClick={clearFileSelection}
                  title={t("workspace.cancel_selection")}
                  className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                {vaultApi && isAuthenticated && (
                  <button
                    type="button"
                    onClick={handleSyncVault}
                    disabled={vaultSyncing}
                    title={t("vault.sync_all")}
                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    data-tauri-drag-region={false}
                  >
                    {vaultSyncing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                  </button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    title={`${t("notes.filter")}: ${currentFolderName}`}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                      selectedFolderId && selectedFolderId !== "__all__" ? "text-foreground" : ""
                    )}
                    data-tauri-drag-region={false}
                  >
                    <Filter className="size-4" />
                  </DropdownMenuTrigger>
                  {folderDropdownItems}
                </DropdownMenu>

                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  title={t("notes.grid_view")}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg transition-colors",
                    viewMode === "grid"
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <LayoutGrid className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  title={t("notes.list_view")}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg transition-colors",
                    viewMode === "list"
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <List className="size-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* File list / grid, grouped by time. Extra bottom padding while the
            batch bar is up so the last rows aren't hidden behind it. */}
        <div className={cn("flex-1 overflow-y-auto", multiMode && "pb-20")}>
          {timeSections.length === 0 ? (
            <EmptyState />
          ) : viewMode === "grid" ? (
            <div className="pb-4">
              {timeSections.map((section) => (
                <div key={section.key} className="px-4 pt-3">
                  <TimeSectionHeader label={section.label} count={section.items.length} />
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 pb-1 pt-2">
                    {section.items.map((file) => {
                      const isChecked = selectedFileIds.has(file.id);
                      const targetIds =
                        isChecked && selectedFileIds.size > 0
                          ? Array.from(selectedFileIds)
                          : [file.id];
                      return (
                        <FileRowContextMenu
                          key={file.id}
                          file={file}
                          targetIds={targetIds}
                          folders={folderList}
                          canTranscribe={
                            !!defaultTemplateId && !targetIds.some((id) => isLocalFileId(id))
                          }
                          transcribedIds={transcribedIds}
                          onMove={handleMoveFile}
                          onDelete={handleDeleteFile}
                          onTranscribe={handleTranscribe}
                        >
                          <GridCard
                            file={file}
                            isSelected={selectedItemId === file.id}
                            unread={unreadIds.has(file.id)}
                            isSummarizing={summarizingFileIds.has(file.id)}
                            isChecked={isChecked}
                            multiMode={multiMode}
                            onOpen={() => handleOpenNote(file)}
                            onToggleSelect={() => toggleFileSelected(file.id)}
                            onLongPressSelect={() => handleLongPressSelect(file.id)}
                          />
                        </FileRowContextMenu>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div>
              {timeSections.map((section) => (
                <div key={section.key}>
                  <TimeSectionHeader label={section.label} count={section.items.length} />
                  <div className="divide-y divide-border/40 px-4">
                    {section.items.map((file) => {
                      const isChecked = selectedFileIds.has(file.id);
                      const targetIds =
                        isChecked && selectedFileIds.size > 0
                          ? Array.from(selectedFileIds)
                          : [file.id];
                      return (
                        <FileRowContextMenu
                          key={file.id}
                          file={file}
                          targetIds={targetIds}
                          folders={folderList}
                          canTranscribe={
                            !!defaultTemplateId && !targetIds.some((id) => isLocalFileId(id))
                          }
                          transcribedIds={transcribedIds}
                          onMove={handleMoveFile}
                          onDelete={handleDeleteFile}
                          onTranscribe={handleTranscribe}
                        >
                          <FileRow
                            file={file}
                            isSelected={selectedItemId === file.id}
                            unread={unreadIds.has(file.id)}
                            isSummarizing={summarizingFileIds.has(file.id)}
                            isChecked={isChecked}
                            multiMode={multiMode}
                            onOpen={() => handleOpenNote(file)}
                            onToggleSelect={() => toggleFileSelected(file.id)}
                            onLongPressSelect={() => handleLongPressSelect(file.id)}
                          />
                        </FileRowContextMenu>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Floating batch action bar — springs up while multi-select is active. */}
        <AnimatePresence>
          {multiMode && (
            <motion.div
              key="batch-action-bar"
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.96 }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { type: "spring", bounce: 0, duration: 0.3 }
              }
              className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-4"
            >
              <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-border/60 bg-card/95 p-1.5 shadow-lg backdrop-blur-xl">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={movableFolders.length === 0}
                    title={t("workspace.move_to")}
                    className="flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                    data-tauri-drag-region={false}
                  >
                    <FolderOpen className="size-4 text-muted-foreground" strokeWidth={1.5} />
                    {t("workspace.move_to")}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="center" className="max-h-64 w-48 overflow-y-auto">
                    {movableFolders.length === 0 ? (
                      <div className="px-2 py-1.5 text-2xs text-muted-foreground">
                        {t("layout.no_folders")}
                      </div>
                    ) : (
                      movableFolders.map((folder) => (
                        <DropdownMenuItem
                          key={folder.id}
                          onClick={() =>
                            handleMoveFile(selectionIds, String(folder.id), selectionOldFolderId)
                          }
                        >
                          {folder.color ? (
                            <span
                              className="mr-2 size-2.5 rounded-full"
                              style={{ backgroundColor: folder.color }}
                            />
                          ) : (
                            <Circle className="mr-2 size-4 text-muted-foreground" strokeWidth={1.5} />
                          )}
                          <span className="truncate">{folder.folderName}</span>
                        </DropdownMenuItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="h-5 w-px bg-border/60" aria-hidden="true" />

                <button
                  type="button"
                  disabled={!canBatchTranscribe || selectionTranscribing}
                  onClick={() => handleTranscribe(selectionIds)}
                  title={batchTranscribeLabel}
                  className="flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                  data-tauri-drag-region={false}
                >
                  <RefreshCw className="size-4 text-muted-foreground" strokeWidth={1.5} />
                  {batchTranscribeLabel}
                </button>

                <div className="h-5 w-px bg-border/60" aria-hidden="true" />

                <button
                  type="button"
                  onClick={() => handleDeleteFile(selectionIds)}
                  title={t("workspace.delete_selected")}
                  className="flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                  data-tauri-drag-region={false}
                >
                  <Trash2 className="size-4" strokeWidth={1.5} />
                  {t("workspace.delete_selected")}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Right: content + chat panels */}
      <AnimatePresence initial={false}>
        {selectedItemId && (
          <motion.div
            key="detail-panel"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
            className="flex min-w-0 flex-1 bg-background"
          >
            <ResizableHandle
              label={t("notes.resize_list")}
              onResize={handleNotesListResize}
              onResizeStart={() => setIsListResizing(true)}
              onResizeEnd={() => setIsListResizing(false)}
              side="right"
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <TitleBar />
              <div className="flex min-h-0 flex-1">
                <ContentPanel />
                <AnimatePresence initial={false}>
                  {chatPanelVisible && (
                    <motion.div
                      key="chat-panel"
                      initial={{ width: 0, opacity: 0 }}
                      animate={{ width: chatPanelWidth, opacity: 1 }}
                      exit={{ width: 0, opacity: 0 }}
                      transition={
                        isChatPanelResizing || reduceMotion
                          ? { duration: 0 }
                          : { type: "spring", bounce: 0, duration: 0.3 }
                      }
                      className="flex shrink-0 overflow-hidden border-l border-border/50 bg-card/95 shadow-[var(--shadow-panel-left)] backdrop-blur-xl"
                    >
                      <ResizableHandle
                        label={t("workspace.resize_chat_panel")}
                        onResize={handleChatPanelResize}
                        onResizeStart={() => setIsChatPanelResizing(true)}
                        onResizeEnd={() => setIsChatPanelResizing(false)}
                        side="left"
                      />
                      <div className="h-full overflow-hidden" style={{ width: chatPanelWidth }}>
                        <ChatPanel />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TimeSectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/90 px-4 py-1.5 backdrop-blur-sm">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xs tabular-nums text-muted-foreground/70">{count}</span>
      <div className="ml-1 h-px flex-1 bg-border/40" />
    </div>
  );
}

/** Right-aligned recording count in a filter-dropdown row; hidden when unknown. */
function FolderCount({ count }: { count: number | undefined }) {
  if (count === undefined) return null;
  return <span className="text-2xs tabular-nums text-muted-foreground">{count}</span>;
}

function FileRow({
  file,
  isSelected,
  unread,
  isSummarizing,
  isChecked,
  multiMode,
  onOpen,
  onToggleSelect,
  onLongPressSelect,
}: {
  file: WorkspaceItem;
  isSelected: boolean;
  /** Transcription finished but the note hasn't been opened yet — shows the dot. */
  unread: boolean;
  /** Batch transcription pipeline currently running for this note. */
  isSummarizing: boolean;
  isChecked: boolean;
  multiMode: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onLongPressSelect: () => void;
}) {
  const { t } = useTranslation();
  const press = useLongPressSelection({ multiMode, onOpen, onToggleSelect, onLongPressSelect });
  return (
    <button
      {...press}
      className={cn(
        "group flex w-full items-center rounded-lg px-3 py-2 text-left transition-colors",
        isChecked ? "bg-primary/10" : isSelected ? "bg-accent/60" : "hover:bg-accent/30"
      )}
    >
      {multiMode && (
        <input
          type="checkbox"
          aria-label={t("workspace.select_file", { name: file.title })}
          checked={isChecked}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          className="mr-2.5 size-3.5 shrink-0 cursor-pointer accent-primary"
        />
      )}
      {/* Info */}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-foreground">{file.title}</h3>
        <NoteMetadata file={file} />
      </div>
      {isSummarizing ? (
        <span className="ml-2 shrink-0" title={t("workspace.summarizing")}>
          <Loader2 className="size-3.5 animate-spin text-primary" />
        </span>
      ) : unread ? (
        <span
          className="ml-2 size-2 shrink-0 rounded-full bg-destructive"
          title={t("notes.unread_hint")}
        />
      ) : null}
    </button>
  );
}

function GridCard({
  file,
  isSelected,
  unread,
  isSummarizing,
  isChecked,
  multiMode,
  onOpen,
  onToggleSelect,
  onLongPressSelect,
}: {
  file: WorkspaceItem;
  isSelected: boolean;
  /** Transcription finished but the note hasn't been opened yet — shows the dot. */
  unread: boolean;
  /** Batch transcription pipeline currently running for this note. */
  isSummarizing: boolean;
  isChecked: boolean;
  multiMode: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onLongPressSelect: () => void;
}) {
  const { t } = useTranslation();
  const press = useLongPressSelection({ multiMode, onOpen, onToggleSelect, onLongPressSelect });
  return (
    <button
      {...press}
      className={cn(
        "group relative flex flex-col rounded-xl border bg-card p-2.5 text-left transition-colors hover:border-primary/20 hover:bg-accent/30",
        isChecked
          ? "border-primary/40 bg-primary/5"
          : isSelected
            ? "border-primary/40 bg-accent/40 ring-1 ring-primary/30"
            : "border-border/60"
      )}
    >
      {isSummarizing ? (
        <span className="absolute right-2 top-2" title={t("workspace.summarizing")}>
          <Loader2 className="size-3.5 animate-spin text-primary" />
        </span>
      ) : unread ? (
        <span
          className="absolute right-2 top-2 size-2 rounded-full bg-destructive"
          title={t("notes.unread_hint")}
        />
      ) : null}
      {multiMode && (
        <span className="absolute left-1.5 top-1.5 flex size-4 items-center justify-center">
          <input
            type="checkbox"
            aria-label={t("workspace.select_file", { name: file.title })}
            checked={isChecked}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="size-3.5 cursor-pointer accent-primary"
          />
        </span>
      )}
      {/* Title */}
      <h3 className="line-clamp-2 min-h-[2.25rem] text-sm font-semibold leading-[1.125rem] text-foreground">{file.title}</h3>
      <NoteMetadata file={file} />
    </button>
  );
}

function NoteMetadata({ file }: { file: WorkspaceItem }) {
  const { t } = useTranslation();
  const date = formatNoteDate(file.createdAt);
  const duration = formatRecordingDuration(file.durationSeconds);
  const recordingType = file.recordingMode
    ? t(`notes.recording_${file.recordingMode}`)
    : null;
  const tags = Array.from(new Set([...(recordingType ? [recordingType] : []), ...(file.tags ?? [])]));
  const isLocal = isLocalFileId(file.id);

  return (
    <>
      {(isLocal || date || duration) && (
        <div className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          {isLocal && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1 py-0.5 text-primary"
              title={t("workspace.local_recording_hint")}
            >
              <Monitor className="size-3" strokeWidth={1.75} />
            </span>
          )}
          {date && <span>{date}</span>}
          {date && duration && <span aria-hidden="true">·</span>}
          {duration && <span>{duration}</span>}
        </div>
      )}
      {tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="max-w-32 truncate rounded-md bg-muted px-1.5 py-0.5 text-3xs leading-4 text-muted-foreground"
              title={tag}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function formatNoteDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatRecordingDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "";
  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteLabel = String(minutes).padStart(2, "0");
  const secondLabel = String(seconds).padStart(2, "0");
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${minuteLabel}:${secondLabel}`
    : `${minuteLabel}:${secondLabel}`;
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
        <FolderOpen className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium text-foreground">{t("files.empty")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("files.empty_hint")}</p>
    </div>
  );
}
