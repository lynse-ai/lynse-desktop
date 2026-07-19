"use client";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@lynse/ui/components/ui/context-menu";
import { FolderOpen, Pencil, Trash2, RefreshCw } from "../../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import type { FolderInfo } from "../types";

interface FileRowContextMenuProps {
  file: { id: string; title: string; folderId?: string };
  /** Files the action applies to: the whole selection if `file` is selected, else just `file`. */
  targetIds: string[];
  folders: FolderInfo[] | undefined;
  canTranscribe: boolean;
  /** Ids whose transcription has already completed — drives the "重新生成" vs "转写" label. */
  transcribedIds: Set<string>;
  onRename: (fileId: string, currentName: string) => void;
  onMove: (targetIds: string[], newFolderId: string, oldFolderId: string) => void;
  onDelete: (targetIds: string[]) => void;
  onTranscribe: (targetIds: string[]) => void;
  children: React.ReactNode;
}

export function FileRowContextMenu({
  file,
  targetIds,
  folders,
  canTranscribe,
  transcribedIds,
  onRename,
  onMove,
  onDelete,
  onTranscribe,
  children,
}: FileRowContextMenuProps) {
  const { t } = useTranslation();
  const moveFolders = (folders ?? []).filter(
    (f) => String(f.id) !== (file.folderId ?? "") && !String(f.id).startsWith("__"),
  );
  const multi = targetIds.length > 1;
  // Same underlying pipeline (rerun / trans) as the "生成" button in the content
  // panel. Label it as a re-run when every targeted file already has a completed
  // transcription; otherwise it's a first-time generation.
  const alreadyTranscribed = targetIds.every((id) => transcribedIds.has(id));
  const transcribeLabel = multi
    ? alreadyTranscribed
      ? t("workspace.regenerate_selected")
      : t("workspace.transcribe_selected")
    : alreadyTranscribed
      ? t("workspace.regenerate")
      : t("workspace.transcribe");

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onClick={() => onRename(file.id, file.title)}>
          <Pencil className="size-3.5" />
          <span>{t("workspace.rename")}</span>
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderOpen className="size-3.5" />
            <span>{t("workspace.move_to")}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-64 overflow-y-auto">
            {moveFolders.length === 0 ? (
              <span className="block px-2 py-1.5 text-[11px] text-muted-foreground">
                {t("layout.no_folders")}
              </span>
            ) : (
              moveFolders.map((f) => (
                <ContextMenuItem
                  key={f.id}
                  onClick={() => onMove(targetIds, f.id, file.folderId ?? "")}
                >
                  <span className="truncate">{f.folderName}</span>
                </ContextMenuItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem variant="destructive" onClick={() => onDelete(targetIds)}>
          <Trash2 className="size-3.5" />
          <span>{multi ? t("workspace.delete_selected") : t("workspace.delete")}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onTranscribe(targetIds)} disabled={!canTranscribe}>
          <RefreshCw className="size-3.5" />
          <span>{transcribeLabel}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
