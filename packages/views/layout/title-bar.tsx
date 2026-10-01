"use client";

import { useMemo } from "react";
import { useWorkspaceStore } from "../workspace/store";
import { useFiles } from "../workspace/hooks/use-files";
import { useFolders } from "../workspace/hooks/use-folders";
import { useTranslation } from "@lynse/core/i18n/react";
import { EditorThemeSwitcher } from "../workspace/editor-theme-switcher";
import { TitleBarSlot, type MiddlePanelToggle } from "./app-title-bar";
import {
  ChevronRight,
  FileText,
  Bot,
  CodeXml,
} from "../icons";

/**
 * Headless registrar for the workspace / notes pages.
 *
 * Computes the folder › file breadcrumb and the outline / source / theme /
 * ask-AI actions from the workspace store and registers them into the unified
 * app title bar (ChatGPT-desktop style — one strip for the whole window).
 * With no file selected the breadcrumb is null and the bar falls back to the
 * route's default title. Renders nothing itself.
 */
export function WorkspaceTitleBarSlot({
  middleToggle,
}: {
  middleToggle?: MiddlePanelToggle;
}) {
  const { t } = useTranslation();
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedItemTitle = useWorkspaceStore((s) => s.selectedItemTitle);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const contentTab = useWorkspaceStore((s) => s.contentTab);
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);
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

  const title = folderName || fileTitle
    ? (
      <span className="flex min-w-0 items-center gap-1.5" data-tauri-drag-region>
        {folderName && (
          <span className="truncate text-xs text-muted-foreground">{folderName}</span>
        )}
        {folderName && fileTitle && (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
        )}
        {fileTitle && (
          <span className="flex min-w-0 items-center gap-1.5">
            <FileText className="size-3 shrink-0 text-muted-foreground/60" />
            <span className="truncate text-xs font-medium text-foreground">{fileTitle}</span>
          </span>
        )}
      </span>
    )
    : null;

  const actions = (
    <>
      {/* Source code view toggle — the raw markdown only makes sense on a
          summary tab */}
      {selectedItemId && contentTab.startsWith("summary") && (
        <TitleBarButton
          onClick={toggleSourceView}
          active={sourceViewVisible}
          title={t("workspace.view_source")}
        >
          <CodeXml className="size-3.5" />
        </TitleBarButton>
      )}

      {/* Editor typography theme switcher */}
      <EditorThemeSwitcher />

      {/* Ask AI button */}
      <button
        onClick={toggleChatPanel}
        className={
          chatPanelVisible
            ? "flex h-7 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/15 px-2.5 text-2xs font-medium text-accent-brand-text transition-colors"
            : "flex h-7 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-2xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground"
        }
        title={t("workspace.ask_ai")}
      >
        <Bot className="size-3.5" />
        <span>{t("workspace.ask_ai")}</span>
      </button>
    </>
  );

  return <TitleBarSlot title={title} actions={actions} middleToggle={middleToggle} />;
}

/** Compact icon button matching the title bar's right-side action style. */
function TitleBarButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "flex size-7 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors"
          : "flex size-7 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground"
      }
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
