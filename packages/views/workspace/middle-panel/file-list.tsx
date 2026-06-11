"use client";

import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Search, FolderOpen, GripVertical } from "../../icons";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";
import { useWorkspaceStore } from "../store";
import { useFiles } from "../hooks/use-files";
import { useFolders } from "../hooks/use-folders";
import type { WorkspaceItem } from "../types";

export function FileList() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const fileListWidth = useWorkspaceStore((s) => s.fileListWidth);
  const [search, setSearch] = useState("");
  const { t } = useTranslation();

  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });
  const { data: folders } = useFolders();

  const folderName = useMemo(() => {
    if (selectedFolderId === "__all__") return t("layout.all_files");
    if (selectedFolderId === "__uncategorized__") return t("layout.uncategorized");
    if (selectedFolderId === "__trash__") return t("layout.trash");
    if (!Array.isArray(folders)) return t("workspace.files");
    const found = folders.find(
      (f) => String(f.id) === selectedFolderId,
    );
    return found?.folderName ?? t("workspace.files");
  }, [selectedFolderId, folders, t]);

  const folderColor = useMemo(() => {
    if (!selectedFolderId || selectedFolderId.startsWith("__")) return null;
    if (!Array.isArray(folders)) return null;
    const found = folders.find(
      (f) => String(f.id) === selectedFolderId,
    );
    return found?.color ?? null;
  }, [selectedFolderId, folders]);

  const filteredFiles = useMemo(() => {
    if (!Array.isArray(files)) return [];
    const inFolder = files.filter((f) => {
      if (selectedFolderId === "__all__") return true;
      if (selectedFolderId === "__uncategorized__") return !f.folderId;
      if (selectedFolderId === "__trash__") return false; // No API yet
      return f.folderId === selectedFolderId;
    });
    if (!search.trim()) return inFolder;
    const q = search.toLowerCase();
    return inFolder.filter((f) => f.title.toLowerCase().includes(q));
  }, [files, selectedFolderId, search]);

  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width: fileListWidth }}
    >
      {/* Header */}
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
        <div className="px-2 pb-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("workspace.search_files")}
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
      </div>

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
              onSelect={() => selectItem(file.id, "file")}
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
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${hour}:${min}`;
  } catch {
    return dateStr;
  }
}

/* ── Draggable file row ── */
function DraggableFileRow({
  file,
  isSelected,
  onSelect,
}: {
  file: WorkspaceItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `file-${file.id}`,
    data: { file, fileTitle: file.title },
  });

  const dateLabel = formatShortDate(file.createdAt);

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
        <span className="text-[10px] text-muted-foreground tabular-nums">{dateLabel}</span>
      </div>
    </button>
  );
}
