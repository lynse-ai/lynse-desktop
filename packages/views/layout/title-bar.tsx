"use client";

import { useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@lynse/ui/lib/utils";
import { isTauri } from "./use-maximized";
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

  // Double-clicking the title bar toggles maximize/restore (native macOS zoom
  // style). Ignored when the double-click lands on an action button.
  const handleTitleBarDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (!isTauri) return;
    getCurrentWindow().toggleMaximize().catch(() => {});
  };
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
      className="flex shrink-0 select-none items-center border-b border-border/50 bg-background/80 backdrop-blur-xl"
      style={{ height: TITLE_BAR_HEIGHT }}
      data-tauri-drag-region
      onDoubleClick={handleTitleBarDoubleClick}
    >
      {/* ── Draggable breadcrumb (left-aligned, no traffic lights here) ── */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-5">
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
        className="flex shrink-0 items-center gap-1 px-3"
        data-tauri-drag-region={false}
      >
        {/* Outline toggle — only visible when viewing outline tab with headings */}
        {selectedItemId && contentTab === "outline" && (
          <button
            onClick={toggleOutlineSidebar}
            className={cn(
              "flex size-7 items-center justify-center rounded-lg border border-transparent transition-colors",
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
              "flex size-7 items-center justify-center rounded-lg border border-transparent transition-colors",
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
            "flex h-7 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-[11px] font-medium transition-colors",
            chatPanelVisible
              ? "border-primary/30 bg-primary/15 text-accent-brand-text"
              : "text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
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
