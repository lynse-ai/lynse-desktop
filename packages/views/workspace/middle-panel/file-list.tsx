"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Search, FolderOpen, GripVertical, ArrowUpDown, ArrowDown, ArrowUp, Loader2, X } from "../../icons";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";
import { useWorkspaceStore } from "../store";
import {
  useFiles,
  useDeleteFiles,
  useRenameFile,
  useTemplateCategories,
  useRerunSummary,
  useTranscriptionStatus,
  isTranscriptionCompleted,
} from "../hooks/use-files";
import { useMoveFiles } from "../hooks/use-folder-mutations";
import { useFolders } from "../hooks/use-folders";
import type { WorkspaceItem } from "../types";
import { filterWorkspaceFilesByFolder } from "./file-list-filter";
import { LOCAL_TRANSCRIPTION_FOLDER_ID } from "../local-transcription";
import { FileRowContextMenu } from "./file-row-context-menu";

/** Press-and-hold duration (ms) before a row enters multi-select mode. */
const LONG_PRESS_MS = 400;

export function FileList() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const selectedFileIds = useWorkspaceStore((s) => s.selectedFileIds);
  const toggleFileSelected = useWorkspaceStore((s) => s.toggleFileSelected);
  const selectAllFiles = useWorkspaceStore((s) => s.selectAllFiles);
  const clearFileSelection = useWorkspaceStore((s) => s.clearFileSelection);
  const setFileSummarizing = useWorkspaceStore((s) => s.setFileSummarizing);
  const fileListWidth = useWorkspaceStore((s) => s.fileListWidth);
  const searchQuery = useWorkspaceStore((s) => s.searchQuery);
  const setSearchQuery = useWorkspaceStore((s) => s.setSearchQuery);
  const fileSortField = useWorkspaceStore((s) => s.fileSortField);
  const fileSortDir = useWorkspaceStore((s) => s.fileSortDir);
  const toggleFileSortField = useWorkspaceStore((s) => s.toggleFileSortField);
  const toggleFileSortDir = useWorkspaceStore((s) => s.toggleFileSortDir);
  const summarizingFileIds = useWorkspaceStore((s) => s.summarizingFileIds);
  const filterTags = useWorkspaceStore((s) => s.filterTags);
  const filterDate = useWorkspaceStore((s) => s.filterDate);
  const { t } = useTranslation();

  const { data: files } = useFiles({
    pageNum: 1,
    pageSize: 200,
    folderId: selectedFolderId ?? undefined,
  });
  const { data: folders } = useFolders();
  const { data: templateCategories } = useTemplateCategories();

  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  // Tracks the file the user just right-clicked (may not be in the selection).
  // Used to decide the "转写" vs "重新生成" label for that file in the menu.
  const [rightClickedId, setRightClickedId] = useState<string | null>(null);

  // Multi-select mode is entered by long-pressing a row; checkboxes are only
  // visible while at least one file is selected.
  const multiMode = selectedFileIds.size > 0;

  const defaultTemplateId = useMemo(() => {
    const all = templateCategories?.flatMap((c) => c.templates) ?? [];
    return all.find((tpl) => tpl.isDefault === 1)?.id ?? all[0]?.id ?? "";
  }, [templateCategories]);

  const deleteMutation = useDeleteFiles();
  const renameMutation = useRenameFile();
  const moveMutation = useMoveFiles();
  const rerunMutation = useRerunSummary();

  // Which selected/right-clicked files have already been transcribed? Drives
  // the menu label: "转写"/"生成" for first-time, "重新生成" for re-runs.
  const statusFileIds = useMemo(() => {
    const ids = Array.from(selectedFileIds);
    if (rightClickedId && !ids.includes(rightClickedId)) ids.push(rightClickedId);
    return ids.sort();
  }, [selectedFileIds, rightClickedId]);
  const { data: transStatus } = useTranscriptionStatus(statusFileIds);
  const transcribedIds = useMemo(() => {
    const set = new Set<string>();
    if (transStatus) {
      for (const id of statusFileIds) {
        if (isTranscriptionCompleted(transStatus[id])) set.add(id);
      }
    }
    return set;
  }, [transStatus, statusFileIds]);

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
    if (filterDate !== "all") {
      const days = filterDate === "7d" ? 7 : 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      result = result.filter((f) => {
        const time = new Date(f.createdAt || 0).getTime();
        return !isNaN(time) && time >= cutoff;
      });
    }
    if (filterTags.length > 0) {
      result = result.filter((f) => (f.tags ?? []).some((tag) => filterTags.includes(tag)));
    }
    // Sort by field and direction
    const dir = fileSortDir === "asc" ? 1 : -1;
    return [...result].sort((a, b) => {
      const aTime = new Date(a[fileSortField] || 0).getTime();
      const bTime = new Date(b[fileSortField] || 0).getTime();
      return (aTime - bTime) * dir;
    });
  }, [files, selectedFolderId, searchQuery, filterTags, filterDate, fileSortField, fileSortDir]);

  const allSelected = filteredFiles.length > 0 && filteredFiles.every((f) => selectedFileIds.has(f.id));
  const someSelected = filteredFiles.some((f) => selectedFileIds.has(f.id));

  const handleRenameRequest = (fileId: string, currentName: string) => {
    setEditingFileId(fileId);
    setEditingName(currentName);
  };

  const commitRename = () => {
    if (!editingFileId) return;
    const name = editingName.trim();
    if (name) {
      renameMutation.mutate({ fileId: editingFileId, newOriginalFilename: name });
    }
    setEditingFileId(null);
  };

  const cancelRename = () => setEditingFileId(null);

  const handleMove = (targetIds: string[], newFolderId: string, oldFolderId: string) => {
    moveMutation.mutate({ oldFolderId, newFolderId, fileIds: targetIds });
    setRightClickedId(null);
    clearFileSelection();
  };

  const handleDelete = (targetIds: string[]) => {
    if (window.confirm(t("workspace.delete_confirm"))) {
      deleteMutation.mutate(targetIds, {
        onSuccess: () => {
          if (targetIds.includes(selectedItemId ?? "")) {
            selectItem(null, null);
          }
          clearFileSelection();
        },
      });
    }
    setRightClickedId(null);
  };

  const handleTranscribe = async (targetIds: string[]) => {
    if (!defaultTemplateId) return;
    if (targetIds.length === 0) {
      clearFileSelection();
      return;
    }
    // The backend processes ONE transcription at a time per account. Firing all
    // three concurrently makes files 2 & 3 hang server-side (only the first ever
    // reaches "completed"), so they'd sit in "summarizing" forever — which is
    // exactly the bug we saw. So we run them SEQUENTIALLY: each file's full
    // pipeline (transcribe + summarize) settles before the next starts, and we
    // clear that file's spinner as soon as ITS pipeline settles. All selected
    // files will eventually complete; they just progress one after another.
    for (const id of targetIds) {
      setFileSummarizing(id, true);
      try {
        await rerunMutation.mutateAsync({ fileId: id, templateId: defaultTemplateId });
      } catch {
        // A single file's failure must not abort the rest of the batch. Its
        // spinner is cleared in `finally`; the failure surfaces via the rerun
        // mutation's own error UI / cache invalidation.
      } finally {
        setFileSummarizing(id, false);
      }
    }
    setRightClickedId(null);
    clearFileSelection();
  };

  // Long-press a row to enter multi-select mode and select that row.
  const handleLongPressSelect = (fileId: string) => {
    if (!selectedFileIds.has(fileId)) toggleFileSelected(fileId);
  };

  const toggleSelectAll = () => {
    if (allSelected) clearFileSelection();
    else selectAllFiles(filteredFiles.map((f) => f.id));
  };

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width: fileListWidth }}
    >
      {/* Left window-drag region — absolute overlay so it doesn't shrink the
          list; sits over the left padding only, never over interactive rows. */}
      <div
        className="absolute inset-y-0 left-0 w-2 select-none"
        data-tauri-drag-region
      />
      {/* Right window-drag region — absolute overlay over the right padding.
          Its right ~6px overlaps the resize handle's hit zone (resize wins
          there), the rest drags the window. */}
      <div
        className="absolute inset-y-0 right-0 w-3 select-none"
        data-tauri-drag-region
      />
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
        <div
          className="flex shrink-0 select-none flex-col border-b border-border"
          data-tauri-drag-region
        >
          <div className="flex items-center gap-2 px-3 py-2">
            {folderColor ? (
              <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: folderColor }} />
            ) : null}
            <span className="truncate text-xs font-medium">{folderName}</span>
            {multiMode ? (
              <>
                <input
                  type="checkbox"
                  aria-label={t("workspace.select_all")}
                  className="ml-1 size-3.5 shrink-0 cursor-pointer accent-violet-500"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={toggleSelectAll}
                  onClick={(e) => e.stopPropagation()}
                  data-tauri-drag-region={false}
                />
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {t("workspace.selected_count", { count: selectedFileIds.size })}
                </span>
                <button
                  onClick={clearFileSelection}
                  title={t("workspace.cancel_selection")}
                  className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  data-tauri-drag-region={false}
                >
                  <X className="size-3" />
                  {t("workspace.cancel")}
                </button>
              </>
            ) : (
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {filteredFiles.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 px-2 pb-2">
            <div className="relative flex-1 select-text" data-tauri-drag-region={false}>
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
              title={fileSortField === "createdAt" ? t("workspace.sort_by_created") : t("workspace.sort_by_generated")}
              className="flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              data-tauri-drag-region={false}
            >
              <span>{fileSortField === "createdAt" ? t("workspace.sort_field_date") : t("workspace.sort_field_generated")}</span>
              <ArrowUpDown className="size-3" />
            </button>
            <button
              onClick={toggleFileSortDir}
              title={fileSortDir === "desc" ? t("workspace.sort_desc") : t("workspace.sort_asc")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              data-tauri-drag-region={false}
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
          filteredFiles.map((file) => {
            const isChecked = selectedFileIds.has(file.id);
            const targetIds =
              isChecked && selectedFileIds.size > 0 ? Array.from(selectedFileIds) : [file.id];
            return (
              <FileRowContextMenu
                key={file.id}
                file={file}
                targetIds={targetIds}
                folders={folders}
                canTranscribe={!!defaultTemplateId}
                transcribedIds={transcribedIds}
                onRename={handleRenameRequest}
                onMove={handleMove}
                onDelete={handleDelete}
                onTranscribe={handleTranscribe}
              >
                <DraggableFileRow
                  file={file}
                  isSelected={selectedItemId === file.id}
                  isSummarizing={summarizingFileIds.has(file.id)}
                  isChecked={isChecked}
                  multiMode={multiMode}
                  onOpen={() => selectItem(file.id, "file", file.title)}
                  onToggleSelect={() => toggleFileSelected(file.id)}
                  onLongPressSelect={() => handleLongPressSelect(file.id)}
                  onContextMenu={() => setRightClickedId(file.id)}
                  editing={editingFileId === file.id}
                  editingName={editingName}
                  onEditingNameChange={setEditingName}
                  onCommitRename={commitRename}
                  onCancelRename={cancelRename}
                />
              </FileRowContextMenu>
            );
          })
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
  isChecked,
  multiMode,
  onOpen,
  onToggleSelect,
  onLongPressSelect,
  onContextMenu,
  editing,
  editingName,
  onEditingNameChange,
  onCommitRename,
  onCancelRename,
}: {
  file: WorkspaceItem;
  isSelected: boolean;
  isSummarizing: boolean;
  isChecked: boolean;
  multiMode: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onLongPressSelect: () => void;
  onContextMenu?: () => void;
  editing: boolean;
  editingName: string;
  onEditingNameChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `file-${file.id}`,
    data: { file, fileTitle: file.title },
    disabled: multiMode,
  });

  const longPressTimer = useRef<number | null>(null);
  const didLongPress = useRef(false);
  const didDrag = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // If a drag starts, cancel any pending long-press so we don't enter
  // multi-select mode mid-drag, and remember a drag happened so we can
  // swallow the synthetic click that follows a drop.
  useEffect(() => {
    if (isDragging) {
      clearLongPress();
      didDrag.current = true;
    }
  }, [isDragging]);

  const handlePointerDown = (e: React.PointerEvent) => {
    // Only the left button triggers long-press; right-click opens the context menu.
    if (e.button !== 0) return;
    didLongPress.current = false;
    didDrag.current = false;
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      didLongPress.current = true;
      onLongPressSelect();
    }, LONG_PRESS_MS);
  };

  const handleClick = () => {
    clearLongPress();
    // Suppress the synthetic click that follows a long-press or a drag.
    if (didLongPress.current) {
      didLongPress.current = false;
      return;
    }
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    if (multiMode) onToggleSelect();
    else onOpen();
  };

  const dateLabel = formatShortDate(file.createdAt);
  const visibleTags = file.tags?.slice(0, 2) ?? [];
  const hiddenTagCount = Math.max(0, (file.tags?.length ?? 0) - visibleTags.length);

  return (
    <button
      ref={setNodeRef}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={clearLongPress}
      onPointerLeave={clearLongPress}
      onContextMenu={() => onContextMenu?.()}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className={`group flex w-full items-center gap-1 px-3 py-2 text-left transition-colors border-b border-border/50 ${
        isSelected
          ? "bg-accent text-accent-foreground"
          : isChecked
            ? "bg-accent/40"
            : "text-foreground hover:bg-accent/30"
      }`}
    >
      {/* Leading slot: drag handle in normal mode, selection checkbox in
          multi-select mode. Both occupy the same fixed w-4 slot so entering
          multi-select neither shifts the row content nor indents the checkbox. */}
      {!editing && !multiMode ? (
        <span
          {...listeners}
          {...attributes}
          onClick={(e) => e.stopPropagation()}
          className="flex w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground active:cursor-grabbing"
          title={t("workspace.drag_to_move")}
        >
          <GripVertical className="size-3.5" />
        </span>
      ) : multiMode ? (
        <span className="flex w-4 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            aria-label={t("workspace.select_file", { name: file.title })}
            checked={isChecked}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="size-3.5 cursor-pointer accent-violet-500"
          />
        </span>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        {editing ? (
          <Input
            autoFocus
            value={editingName}
            onChange={(e) => onEditingNameChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") onCommitRename();
              else if (e.key === "Escape") onCancelRename();
            }}
            onBlur={onCommitRename}
            className="h-6 text-xs"
          />
        ) : (
          <span className={`truncate text-xs leading-snug ${isSelected ? "font-medium" : ""}`}>
            {file.title}
          </span>
        )}
        {!editing && visibleTags.length > 0 ? (
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
        {!editing && (
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
        )}
      </div>
    </button>
  );
}
