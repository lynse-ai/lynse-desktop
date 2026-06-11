"use client";

import { useMemo } from "react";
import { FolderOpen } from "../../icons";
import { useWorkspaceStore } from "../store";
import { useFolders } from "../hooks/use-folders";
import { useFiles } from "../hooks/use-files";

export function FolderTree() {
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const folderTreeWidth = useWorkspaceStore((s) => s.folderTreeWidth);

  const { data: folders } = useFolders();
  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });

  const folderItems = useMemo(() => {
    if (!Array.isArray(folders)) return [];
    return folders.map((f) => ({
      id: f.id,
      name: f.folderName,
      color: f.color,
    }));
  }, [folders]);

  const countsByFolder = useMemo(() => {
    const map = new Map<string, number>();
    let ungrouped = 0;
    if (Array.isArray(files)) {
      for (const f of files) {
        if (f.folderId) {
          map.set(f.folderId, (map.get(f.folderId) ?? 0) + 1);
        } else {
          ungrouped++;
        }
      }
    }
    return { map, ungrouped };
  }, [files]);

  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width: folderTreeWidth }}
    >
      <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">Folders</span>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {folderItems.map((folder) => (
          <button
            key={folder.id}
            onClick={() => selectFolder(folder.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
              selectedFolderId === folder.id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
          >
            {folder.color ? (
              <span
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: folder.color }}
              />
            ) : (
              <FolderOpen className="size-3.5 shrink-0" />
            )}
            <span className="flex-1 truncate text-left">{folder.name}</span>
            <span className="text-[10px] tabular-nums">
              {countsByFolder.map.get(folder.id) ?? 0}
            </span>
          </button>
        ))}

        {/* Uncategorized */}
        <button
          onClick={() => selectFolder("__uncategorized__")}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
            selectedFolderId === "__uncategorized__"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50"
          }`}
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="flex-1 truncate text-left">Uncategorized</span>
          <span className="text-[10px] tabular-nums">{countsByFolder.ungrouped}</span>
        </button>

        {folderItems.length === 0 && (
          <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            No folders yet
          </p>
        )}
      </div>
    </div>
  );
}
