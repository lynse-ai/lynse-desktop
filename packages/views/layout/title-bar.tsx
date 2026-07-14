"use client";

import { useMemo } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { useWorkspaceStore } from "../workspace/store";
import { useFiles } from "../workspace/hooks/use-files";
import { useFolders } from "../workspace/hooks/use-folders";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  ChevronRight,
  FileText,
  Bot,
  List,
  Code,
} from "../icons";

const TITLE_BAR_HEIGHT = 38;

/**
 * Full-width title bar for the desktop app (Tauri / macOS Overlay style).
 *
 * Layout (matching VS Code – style reference):
 *
 *   [traffic lights] [split][search][edit]  ← drag region (breadcrumb) →  [actions...]
 *
 *   - Left of drag: 3 toolbar icons placed right after macOS traffic lights
 *   - Center:        large draggable region showing folder > file breadcrumb
 *   - Right:         action buttons (outline, source, AI chat)
 */
export function TitleBar() {
  const { t } = useTranslation();
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedItemTitle = useWorkspaceStore((s) => s.selectedItemTitle);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const contentTab = useWorkspaceStore((s) => s.contentTab);
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);
  const outlineSidebarVisible = useWorkspaceStore((s) => s.outlineSidebarVisible);
  const toggleOutlineSidebar = useWorkspaceStore((s) => s.toggleOutlineSidebar);
  const sourceViewVisible = useWorkspaceStore((s) => s.sourceViewVisible);
  const toggleSourceView = useWorkspaceStore((s) => s.toggleSourceView);
  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });
  const { data: folders } = useFolders();

  const folderName = useMemo(() => {
    if (selectedFolderId === "__all__") return t("layout.all_files");
    if (selectedFolderId === "__uncategorized__") return t("layout.uncategorized");
    if (selectedFolderId === "__trash__") return t("layout.trash");
    if (!Array.isArray(folders)) return null;
    const found = folders.find((f) => String(f.id) === selectedFolderId);
    return found?.folderName ?? null;
  }, [selectedFolderId, folders, t]);

  const fileTitle = useMemo(() => {
    if (!selectedItemId) return null;
    if (!Array.isArray(files)) return selectedItemTitle;
    const found = files.find((f) => f.id === selectedItemId);
    return found?.title || selectedItemTitle;
  }, [selectedItemId, files, selectedItemTitle]);

  return (
    <div
      className="flex shrink-0 items-center border-b border-border bg-background/80 backdrop-blur-sm select-none"
      style={{ height: TITLE_BAR_HEIGHT }}
      data-tauri-drag-region
    >
      {/* ── Draggable breadcrumb (left-aligned, no traffic lights here) ── */}
      <div className="flex-1 flex items-center gap-1.5 min-w-0 px-4">
        {folderName && (
          <>
            <span className="truncate text-xs text-muted-foreground">{folderName}</span>
            {fileTitle && (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
            )}
          </>
        )}
        {fileTitle ? (
          <div className="flex items-center gap-1.5 min-w-0">
            <FileText className="size-3 shrink-0 text-muted-foreground/60" />
            <span className="truncate text-xs font-medium">{fileTitle}</span>
          </div>
        ) : (
          !folderName && (
            <span className="text-xs text-muted-foreground/50">{t("app_name")}</span>
          )
        )}
      </div>

      {/* ── Right: Action icons ── */}
      <div
        className="flex items-center gap-0.5 shrink-0 px-2"
        data-tauri-drag-region={false}
      >
        {/* Outline toggle — only visible when viewing outline tab with headings */}
        {selectedItemId && contentTab === "outline" && (
          <button
            onClick={toggleOutlineSidebar}
            className={cn(
              "flex items-center justify-center rounded-md p-1 transition-colors",
              outlineSidebarVisible
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
            title={t("workspace.toggle_outline")}
          >
            <List className="size-3.5" />
          </button>
        )}

        {/* Source code view toggle — visible for outline and summary tabs */}
        {selectedItemId && (
          <button
            onClick={toggleSourceView}
            className={cn(
              "flex items-center justify-center rounded-md p-1 transition-colors",
              sourceViewVisible
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
            title={t("workspace.view_source")}
          >
            <Code className="size-3.5" />
          </button>
        )}

        {/* Ask AI button */}
        <button
          onClick={toggleChatPanel}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
            chatPanelVisible
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
          title={t("workspace.ask_ai")}
        >
          <Bot className="size-3.5" />
          <span>{t("workspace.ask_ai")}</span>
        </button>
      </div>
    </div>
  );
}
