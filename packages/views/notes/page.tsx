"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useWorkspaceStore } from "../workspace/store";
import { ContentPanel } from "../workspace/content-panel";
import { ChatPanel } from "../workspace/right-panel/chat-panel";
import { ResizableHandle } from "../workspace/resizable-handle";
import { TitleBar } from "../layout/title-bar";
import { useNotes } from "../workspace/hooks/use-files";
import { useFolders } from "../workspace/hooks/use-folders";
import { filterWorkspaceFilesByFolder } from "../workspace/middle-panel/file-list-filter";
import { LOCAL_TRANSCRIPTION_FOLDER_ID } from "../workspace/local-transcription";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
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
  const layoutRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [isListResizing, setIsListResizing] = useState(false);

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

  // Last known-good list, hydrated from localStorage on mount.
  const [cachedFiles, setCachedFiles] = useState<WorkspaceItem[]>(() => loadNotesCache());
  useEffect(() => {
    if (!Array.isArray(files) || files.length === 0) return;
    setCachedFiles(files);
    saveNotesCache(files);
  }, [files]);

  // Render the cached list whenever the query has no data yet (initial load or
  // refetch), so the panel never goes blank.
  // Logged out → the notes query is disabled and `files` is undefined; never
  // surface cached cloud data in that state.
  const sourceFiles = files ?? (isAuthenticated ? cachedFiles : []);

  const folderList: FolderInfo[] = Array.isArray(folders) ? folders : [];

  const currentFolderName = useMemo(() => {
    if (selectedFolderId === "__all__") return t("layout.all_files");
    if (selectedFolderId === LOCAL_TRANSCRIPTION_FOLDER_ID) return t("layout.local_transcriptions");
    if (selectedFolderId === "__uncategorized__") return t("layout.uncategorized");
    if (selectedFolderId === "__trash__") return t("layout.trash");
    const found = folderList.find((f) => String(f.id) === selectedFolderId);
    return found?.folderName ?? t("layout.all_files");
  }, [selectedFolderId, folderList, t]);

  const filteredFiles = useMemo(() => {
    if (!Array.isArray(sourceFiles)) return [];
    return filterWorkspaceFilesByFolder(sourceFiles, selectedFolderId);
  }, [sourceFiles, selectedFolderId]);

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
        <Layers className="mr-2 size-4" />
        {t("layout.all_files")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handleSelectFolder(LOCAL_TRANSCRIPTION_FOLDER_ID)}>
        <FileAudio className="mr-2 size-4" />
        {t("layout.local_transcriptions")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handleSelectFolder("__uncategorized__")}>
        <Circle className="mr-2 size-4" />
        {t("layout.uncategorized")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {folderList.length === 0 && (
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("layout.no_folders")}</div>
      )}
      {folderList.map((folder) => (
        <DropdownMenuItem key={folder.id} onClick={() => handleSelectFolder(String(folder.id))}>
          {folder.color ? (
            <span className="mr-2 size-2.5 rounded-full" style={{ backgroundColor: folder.color }} />
          ) : (
            <Circle className="mr-2 size-4" />
          )}
          {folder.folderName}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => handleSelectFolder("__trash__")}>
        <Trash2 className="mr-2 size-4" />
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
          "flex min-w-0 flex-col overflow-hidden",
          selectedItemId ? "shrink-0" : "flex-1",
          selectedItemId && !isListResizing ? "transition-[width] duration-300" : "",
        )}
        style={
          selectedItemId
            ? { width: `clamp(300px, ${notesListWidth}px, calc(100% - 520px))` }
            : undefined
        }
      >
        {/* Header: actions */}
        <div
          className="flex shrink-0 select-none items-start justify-between border-b border-border/50 bg-background/80 px-4 py-3 backdrop-blur-xl"
          data-tauri-drag-region
        >
          <div className="flex flex-col items-end gap-2" data-tauri-drag-region={false}>
            <div className="flex items-center gap-1">
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
          </div>
        </div>

        {/* File list / grid, grouped by time */}
        <div className="flex-1 overflow-y-auto">
          {timeSections.length === 0 ? (
            <EmptyState />
          ) : viewMode === "grid" ? (
            <div className="pb-4">
              {timeSections.map((section) => (
                <div key={section.key} className="px-4 pt-3">
                  <TimeSectionHeader label={section.label} count={section.items.length} />
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 pb-1 pt-2">
                    {section.items.map((file) => (
                      <GridCard
                        key={file.id}
                        file={file}
                        isSelected={selectedItemId === file.id}
                        onClick={() => selectItem(file.id, "file", file.title)}
                      />
                    ))}
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
                    {section.items.map((file) => (
                      <FileRow
                        key={file.id}
                        file={file}
                        isSelected={selectedItemId === file.id}
                        onClick={() => selectItem(file.id, "file", file.title)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
                      transition={reduceMotion ? { duration: 0 } : { duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
                      className="flex shrink-0 overflow-hidden border-l border-border/50 bg-card/95 shadow-[-12px_0_34px_rgba(0,0,0,0.14)] backdrop-blur-xl"
                    >
                      <ResizableHandle
                        label={t("workspace.resize_chat_panel")}
                        onResize={handleChatPanelResize}
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
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/90 px-4 py-2 backdrop-blur-sm">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground">{label}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground/70">{count}</span>
      <div className="ml-1 h-px flex-1 bg-border/40" />
    </div>
  );
}

function FileRow({
  file,
  isSelected,
  onClick,
}: {
  file: WorkspaceItem;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-4 rounded-lg px-3 py-3 text-left transition-colors",
        isSelected ? "bg-accent/60" : "hover:bg-accent/30"
      )}
    >
      {/* Info */}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-foreground">{file.title}</h3>
        <NoteMetadata file={file} />
      </div>
    </button>
  );
}

function GridCard({
  file,
  isSelected,
  onClick,
}: {
  file: WorkspaceItem;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex flex-col rounded-xl border border-border/60 bg-card p-3 text-left transition-colors hover:border-primary/20 hover:bg-accent/30",
        isSelected ? "border-primary/40 bg-accent/40 ring-1 ring-primary/30" : ""
      )}
    >
      {/* Title */}
      <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-foreground">{file.title}</h3>
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

  return (
    <>
      {(date || duration) && (
        <div className="mt-1 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          {date && <span>{date}</span>}
          {date && duration && <span aria-hidden="true">·</span>}
          {duration && <span>{duration}</span>}
        </div>
      )}
      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="max-w-32 truncate rounded-md bg-muted px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground"
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
