"use client";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@lynse/ui/components/ui/context-menu";
import { Pencil, Trash2 } from "../../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { useDeleteFolder } from "../hooks/use-folder-mutations";
import { useWorkspaceStore, getWorkspaceState } from "../store";
import type { FolderInfo } from "../types";

interface FolderContextMenuProps {
  folder: FolderInfo;
  children: React.ReactNode;
}

export function FolderContextMenu({ folder, children }: FolderContextMenuProps) {
  const { t } = useTranslation();
  const setEditingFolderId = useWorkspaceStore((s) => s.setEditingFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const deleteMutation = useDeleteFolder();

  const handleRename = () => {
    setEditingFolderId(folder.id);
  };

  const handleDelete = () => {
    if (window.confirm(t("layout.delete_folder_confirm"))) {
      deleteMutation.mutate([folder.id], {
        onSuccess: () => {
          // If we deleted the currently selected folder, fallback to "All"
          const selectedId = getWorkspaceState().selectedFolderId;
          if (selectedId === folder.id) {
            selectFolder("__all__");
          }
        },
      });
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleRename}>
          <Pencil className="size-3.5" />
          <span>{t("layout.rename_folder")}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={handleDelete}>
          <Trash2 className="size-3.5" />
          <span>{t("layout.delete_folder")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
