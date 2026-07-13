"use client";

import { useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Search, FolderOpen, GripVertical, ArrowUpDown, ArrowDown, ArrowUp, Loader2 } from "../../icons";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";
import { useWorkspaceStore } from "../store";
import { useFiles } from "../hooks/use-files";
import { useFolders } from "../hooks/use-folders";
import type { WorkspaceItem } from "../types";
import { filterWorkspaceFilesByFolder } from "./file-list-filter";
import { LOCAL_TRANSCRIPTION_FOLDER_ID } from "../local-transcription";

export function FileList() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const fileListWidth = useWorkspaceStore((s) => s.fileListWidth);
  const searchQuery = useWorkspaceStore((s) => s.searchQuery);
  const setSearchQuery = useWorkspaceStore((s) => s.setSearchQuery);
  const fileSortField = useWorkspaceStore((s) => s.fileSortField);
  const fileSortDir = useWorkspaceStore((s) => s.fileSortDir);
  const toggleFileSortField = useWorkspaceStore((s) => s.toggleFileSortField);
  const toggleFileSortDir = useWorkspaceStore((s) => s.toggleFileSortDir);
  const summarizingFileIds = useWorkspaceStore((s) => s.summarizingFileIds);
  const { t } = useTranslation();

  const { data: files } = useFiles({
    pageNum: 1,
    pageSize: 200,
    folderId: selectedFolderId ?? undefined,
  });
  const { data: folders } = useFolders();

  const folderName = useMemo(() => {
    if (selectedFolderId === "__all__") return t("layout.all_files");
    if (selectedFolderId === LOCAL_TRANSCRIPTION_FOLDER_ID) return t("layout.local_transcriptions");
    if (selectedFolderId === "__uncategorized__") return t("layout.uncategorized");
    if (selectedFolderId === "__trash__") return t("layout.trash");
    if (!Array.isArray(folders)) return t("workspace.files");
    const found = folders.find((f) => String(f.id) === selectedFolderId);
    return found?.folderName ?? t("workspace.files");
  }, [selectedFolderId, folders, t]);

  const folderColor = useMemo(() => {
    if (!selectedFolderId || selectedFolderId.startsWith("__")) return null;
    if (!Array.isArray(folders)) return null;
    const found = folders.find((f) => String(f.id) === selectedFolderId);
    return found?.color ?? null;
  }, [selectedFolderId, folders]);

  const filteredFiles = useMemo(() => {
    if (!Array.isArray(files)) return [];
    const inFolder = filterWorkspaceFilesByFolder(files, selectedFolderId);
    let result = inFolder;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((f) => f.title.toLowerCase().includes(q));
    }
    // Sort by field and direction
    const dir = fileSortDir === "asc" ? 1 : -1;
    return [...result].sort((a, b) => {
      const aTime = new Date(a[fileSortField] || 0).getTime();
      const bTime = new Date(b[fileSortField] || 0).getTime();
      return (aTime - bTime) * dir;
    });
  }, [files, selectedFolderId, searchQuery, fileSortField, fileSortDir]);

  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width: fileListWidth }}
    >
      <style>
        {`
          @keyframes ai-file-text-shimmer {
            0% { background-position: 0% 50%; }
            100% { background-position: 240% 50%; }
          }
        `}
      </style>
      {/* Header — Folder name + Search + Sort */}
      {selectedFolderId && (
        <div className="flex shrink-0 flex-col border-b border-border">
          <div className="flex items-center gap-2 px-3 py-2">
            {folderColor ? (
              <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: folderColor }} />
            ) : null}
            <span className="truncate text-xs font-medium">{folderName}</span>
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
              {filteredFiles.length}
            </span>
          </div>
          <div className="flex items-center gap-1 px-2 pb-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("workspace.search_files")}
                className="h-7 pl-7 text-xs"
              />
            </div>
            <button
              onClick={toggleFileSortField}
              title={fileSortField === "createdAt" ? t("workspace.sort_by_created") : t("workspace.sort_by_updated")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <ArrowUpDown className="size-3" />
            </button>
            <button
              onClick={toggleFileSortDir}
              title={fileSortDir === "desc" ? t("workspace.sort_desc") : t("workspace.sort_asc")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              {fileSortDir === "desc" ? (
                <ArrowDown className="size-3" />
              ) : (
                <ArrowUp className="size-3" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {!selectedFolderId ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <FolderOpen className="size-6 text-muted-foreground/50" />
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t("workspace.select_folder")}
            </p>
          </div>
        ) : filteredFiles.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            {t("workspace.no_files")}
          </p>
        ) : (
          filteredFiles.map((file) => (
            <DraggableFileRow
              key={file.id}
              file={file}
              isSelected={selectedItemId === file.id}
              isSummarizing={summarizingFileIds.has(file.id)}
              onSelect={() => selectItem(file.id, "file", file.title)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function formatShortDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${min}`;
  } catch {
    return dateStr;
  }
}

/* ── Draggable file row ── */
function DraggableFileRow({
  file,
  isSelected,
  isSummarizing,
  onSelect,
}: {
  file: WorkspaceItem;
  isSelected: boolean;
  isSummarizing: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `file-${file.id}`,
    data: { file, fileTitle: file.title },
  });

  const dateLabel = formatShortDate(file.createdAt);
  const visibleTags = file.tags?.slice(0, 2) ?? [];
  const hiddenTagCount = Math.max(0, (file.tags?.length ?? 0) - visibleTags.length);

  return (
    <button
      ref={setNodeRef}
      onClick={onSelect}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className={`flex w-full items-center gap-1 px-3 py-2 text-left transition-colors border-b border-border/50 ${
        isSelected
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/30"
      }`}
    >
      {/* Drag handle */}
      <span
        {...listeners}
        {...attributes}
        className="shrink-0 cursor-grab touch-none text-muted-foreground/30 hover:text-muted-foreground/60 active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="size-3" />
      </span>
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className={`truncate text-xs leading-snug ${isSelected ? "font-medium" : ""}`}>
          {file.title}
        </span>
        {visibleTags.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {visibleTags.map((tag) => (
              <span
                key={tag}
                className={`max-w-[5.5rem] truncate rounded px-1.5 py-0.5 text-[9px] leading-none ${
                  isSelected
                    ? "bg-background/35 text-accent-foreground/75"
                    : "bg-muted text-muted-foreground"
                }`}
                title={tag}
              >
                {tag}
              </span>
            ))}
            {hiddenTagCount > 0 ? (
              <span
                className={`rounded px-1.5 py-0.5 text-[9px] leading-none ${
                  isSelected
                    ? "bg-background/35 text-accent-foreground/75"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                +{hiddenTagCount}
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
          {isSummarizing ? (
            <>
              <Loader2 className="size-2.5 animate-spin text-violet-400" />
              <span className="bg-[linear-gradient(90deg,#38bdf8,#a78bfa,#34d399,#38bdf8)] bg-[length:240%_100%] bg-clip-text font-medium text-transparent animate-[ai-file-text-shimmer_1.8s_linear_infinite]">
                {t("workspace.summarizing")}
              </span>
            </>
          ) : (
            dateLabel
          )}
        </span>
      </div>
    </button>
  );
}
