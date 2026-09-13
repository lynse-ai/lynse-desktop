"use client";

import { useState } from "react";
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
import { DeleteConfirmDialog } from "../delete-confirm-dialog";

interface FolderContextMenuProps {
  folder: FolderInfo;
  children: React.ReactNode;
}

export function FolderContextMenu({ folder, children }: FolderContextMenuProps) {
  const { t } = useTranslation();
  const setEditingFolderId = useWorkspaceStore((s) => s.setEditingFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const deleteMutation = useDeleteFolder();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRename = () => {
    setEditingFolderId(folder.id);
  };

  const handleDelete = () => {
    setConfirmOpen(true);
  };

  const confirmDelete = () => {
    deleteMutation.mutate([folder.id], {
      onSuccess: () => {
        setConfirmOpen(false);
        // If we deleted the currently selected folder, fallback to "All"
        const selectedId = getWorkspaceState().selectedFolderId;
        if (selectedId === folder.id) {
          selectFolder("__all__");
        }
      },
    });
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleRename}>
            <Pencil className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
            <span>{t("layout.rename_folder")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={handleDelete}>
            <Trash2 className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
            <span>{t("layout.delete_folder")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <DeleteConfirmDialog
        open={confirmOpen}
        description={t("layout.delete_folder_confirm")}
        pending={deleteMutation.isPending}
        onConfirm={confirmDelete}
        onOpenChange={setConfirmOpen}
      />
    </>
  );
}
