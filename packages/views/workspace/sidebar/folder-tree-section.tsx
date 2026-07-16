"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@lynse/ui/lib/utils";
import {
  Layers,
  Trash2,
  FolderPlus,
  FileAudio,
  ChevronDown,
  ChevronRight,
  Circle,
} from "../../icons";
import {
  SidebarGroup,
  SidebarGroupContent,
} from "@lynse/ui/components/ui/sidebar";
import { useTranslation } from "@lynse/core/i18n/react";
import { useFolders } from "../hooks/use-folders";
import { useFolderCounts } from "../hooks/use-folder-counts";
import { useFiles } from "../hooks/use-files";
import { useCreateFolder, useEditFolder } from "../hooks/use-folder-mutations";
import { useWorkspaceStore, getWorkspaceState } from "../store";
import { isLocalFileId, LOCAL_TRANSCRIPTION_FOLDER_ID } from "../local-transcription";
import { FolderContextMenu } from "./folder-context-menu";
import type { FolderInfo } from "../types";

export function FolderTreeSection() {
  const { t } = useTranslation();
  const { data: folders } = useFolders();
  const { data: counts } = useFolderCounts();
  const { data: allFiles } = useFiles({ pageNum: 1, pageSize: 200, folderId: "__all__" });
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const sidebarSectionsCollapsed = useWorkspaceStore((s) => s.sidebarSectionsCollapsed);
  const toggleSidebarSection = useWorkspaceStore((s) => s.toggleSidebarSection);
  const editingFolderId = useWorkspaceStore((s) => s.editingFolderId);
  const setEditingFolderId = useWorkspaceStore((s) => s.setEditingFolderId);

  const createFolderMutation = useCreateFolder();
  const editFolderMutation = useEditFolder();

  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // The folder tree (All Files / folders / Trash) is part of the persistent
  // sidebar navigation, so it renders on every route — not just workspace ones.
  // (No early return before the hooks below: that would change the hook count
  // between routes and make React throw "Rendered fewer hooks".)

  const foldersCollapsed = sidebarSectionsCollapsed.has("folders");

  const folderList: FolderInfo[] = Array.isArray(folders) ? folders : [];
  const localTranscriptionCount = useMemo(
    () => Array.isArray(allFiles) ? allFiles.filter((file) => isLocalFileId(file.id)).length : 0,
    [allFiles],
  );

  // Build count map from server response
  const countMap = useMemo(() => {
    const map = new Map<string, number>();
    if (counts?.folderStats) {
      for (const stat of counts.folderStats) {
        map.set(stat.folderId, stat.count);
      }
    }
    return map;
  }, [counts]);

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) {
      setShowNewFolderInput(false);
      return;
    }
    createFolderMutation.mutate(
      { folderName: name },
      {
        onSuccess: () => {
          setNewFolderName("");
          setShowNewFolderInput(false);
        },
      },
    );
  };

  const handleEditFolder = (folder: FolderInfo, newName: string) => {
    const name = newName.trim();
    if (!name || name === folder.folderName) {
      setEditingFolderId(null);
      return;
    }
    editFolderMutation.mutate(
      { folderId: folder.id, body: { folderName: name } },
      { onSuccess: () => setEditingFolderId(null) },
    );
  };

  return (
    <SidebarGroup className="py-1">
      {/* Virtual items: All Files + Uncategorized */}
      <div className="space-y-px px-1 mb-1">
        <VirtualItem
          icon={Layers}
          label={t("layout.all_files")}
          count={counts?.all ?? 0}
          active={selectedFolderId === "__all__"}
          onClick={() => selectFolder("__all__")}
        />
        <VirtualItem
          icon={FileAudio}
          label={t("layout.local_transcriptions")}
          count={localTranscriptionCount}
          active={selectedFolderId === LOCAL_TRANSCRIPTION_FOLDER_ID}
          onClick={() => selectFolder(LOCAL_TRANSCRIPTION_FOLDER_ID)}
          iconClassName="opacity-70"
        />
        <VirtualItem
          icon={Circle}
          label={t("layout.uncategorized")}
          count={counts?.unclassified ?? 0}
          active={selectedFolderId === "__uncategorized__"}
          onClick={() => selectFolder("__uncategorized__")}
          iconClassName="opacity-40"
          droppableFolderId=""
        />
      </div>

      {/* Folders section header */}
      <div className="flex items-center justify-between px-2 py-1">
        <button
          onClick={() => toggleSidebarSection("folders")}
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:text-muted-foreground transition-colors"
        >
          {foldersCollapsed ? (
            <ChevronRight className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
          <span>{t("layout.folders")}</span>
        </button>
        <button
          onClick={() => {
            setShowNewFolderInput(true);
            // Auto-expand if collapsed
            if (foldersCollapsed) toggleSidebarSection("folders");
            setTimeout(() => newFolderInputRef.current?.focus(), 50);
          }}
          className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-muted-foreground"
          title={t("layout.new_folder")}
        >
          <FolderPlus className="size-3.5" />
        </button>
      </div>

      {/* Folders list */}
      {!foldersCollapsed && (
        <SidebarGroupContent>
          <div className="space-y-px px-1">
            {/* New folder inline input */}
            {showNewFolderInput && (
              <input
                ref={newFolderInputRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateFolder();
                  if (e.key === "Escape") {
                    setShowNewFolderInput(false);
                    setNewFolderName("");
                  }
                }}
                onBlur={handleCreateFolder}
                placeholder={t("layout.folder_name_placeholder")}
                className="w-full rounded-md border border-primary/50 bg-background px-2 py-1.5 text-[12px] outline-none"
              />
            )}

            {/* Folder items */}
            {folderList.length === 0 && !showNewFolderInput && (
              <p className="px-2 py-2 text-[11px] text-muted-foreground/50">
                {t("layout.no_folders")}
              </p>
            )}

            {folderList.map((folder: FolderInfo) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                count={countMap.get(folder.id) ?? 0}
                active={selectedFolderId === folder.id}
                editing={editingFolderId === folder.id}
                onEditDone={(newName) => handleEditFolder(folder, newName)}
                onClick={() => selectFolder(folder.id)}
              />
            ))}
          </div>
        </SidebarGroupContent>
      )}

      {/* Trash virtual item */}
      <div className="mt-1 border-t border-border/30 pt-1 space-y-px px-1">
        <VirtualItem
          icon={Trash2}
          label={t("layout.trash")}
          count={0}
          active={selectedFolderId === "__trash__"}
          onClick={() => selectFolder("__trash__")}
        />
      </div>
    </SidebarGroup>
  );
}

/* ── Virtual item (All Files, Uncategorized, Trash) ── */
function VirtualItem({
  icon: Icon,
  label,
  count,
  active,
  onClick,
  iconClassName,
  droppableFolderId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  iconClassName?: string;
  droppableFolderId?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `virtual-${droppableFolderId ?? "none"}`,
    data: droppableFolderId ? { folderId: droppableFolderId } : undefined,
    disabled: !droppableFolderId,
  });

  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        isOver && "ring-2 ring-primary/50 bg-primary/10",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", iconClassName)} />
      <span className="flex-1 truncate text-left">{label}</span>
      <span className="text-[10px] tabular-nums text-muted-foreground/50">
        {count}
      </span>
    </button>
  );
}

/* ── Individual folder row with context menu + inline rename ── */
function FolderRow({
  folder,
  count,
  active,
  editing,
  onEditDone,
  onClick,
}: {
  folder: FolderInfo;
  count: number;
  active: boolean;
  editing: boolean;
  onEditDone: (newName: string) => void;
  onClick: () => void;
}) {
  const [editValue, setEditValue] = useState(folder.folderName);
  const editRef = useRef<HTMLInputElement>(null);
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-${folder.id}`,
    data: { folderId: folder.id },
  });

  useEffect(() => {
    if (editing) {
      setEditValue(folder.folderName);
      editRef.current?.focus();
      editRef.current?.select();
    }
  }, [editing, folder.folderName]);

  const button = (
    <button
      ref={setNodeRef}
      onClick={onClick}
      onDoubleClick={(e) => {
        e.preventDefault();
        // Trigger inline edit on double-click
        getWorkspaceState().setEditingFolderId(folder.id);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        isOver && "ring-2 ring-primary/50 bg-primary/10",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50",
      )}
    >
      {editing ? (
        <input
          ref={editRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEditDone(editValue);
            if (e.key === "Escape") onEditDone(folder.folderName);
          }}
          onBlur={() => onEditDone(editValue)}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 rounded border border-primary/50 bg-background px-1 py-0.5 text-[12px] outline-none min-w-0"
        />
      ) : (
        <>
          {folder.color ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: folder.color }}
            />
          ) : (
            <Circle className="size-2 shrink-0 fill-current" />
          )}
          <span className="flex-1 truncate text-left">{folder.folderName}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground/50">
            {count}
          </span>
        </>
      )}
    </button>
  );

  if (editing) return button;

  return (
    <FolderContextMenu folder={folder}>
      {button}
    </FolderContextMenu>
  );
}
