"use client";

import { useState, useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useWorkspaceStore } from "../workspace/store";
import { ContentPanel } from "../workspace/content-panel";
import { ChatPanel } from "../workspace/right-panel/chat-panel";
import { ResizableHandle } from "../workspace/resizable-handle";
import { TitleBar } from "../layout/title-bar";
import { UploadDialog } from "../workspace/upload-dialog";
import { useNotes } from "../workspace/hooks/use-files";
import { useFolders } from "../workspace/hooks/use-folders";
import { filterWorkspaceFilesByFolder } from "../workspace/middle-panel/file-list-filter";
import { LOCAL_TRANSCRIPTION_FOLDER_ID, isLocalFileId } from "../workspace/local-transcription";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { Button } from "@lynse/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import {
  FolderOpen,
  Upload,
  Mic,
  FileAudio,
  MoreHorizontal,
  Link,
  Layers,
  Trash2,
  Circle,
  Filter,
  LayoutGrid,
  List,
} from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import { useUserCredits } from "../layout/use-user-credits";
import type { WorkspaceItem, FolderInfo } from "../workspace/types";

type NotesTab = "all" | "recent" | "recordings";
type ViewMode = "list" | "grid";

const TAB_ALL: NotesTab = "all";
const TAB_RECENT: NotesTab = "recent";
const TAB_RECORDINGS: NotesTab = "recordings";

/** Format a Date as the backend's `YYYY-MM-DDTHH:MM:SS` (no timezone suffix). */
function toApiDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function NotesPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const reduceMotion = useReducedMotion();

  const [activeTab, setActiveTab] = useState<NotesTab>(TAB_ALL);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const chatPanelWidth = useWorkspaceStore((s) => s.chatPanelWidth);
  const handleChatPanelResize = useWorkspaceStore((s) => s.handleChatPanelResize);

  const { data: files } = useNotes({
    // Wide range → effectively "all my meetings" (recordings + their notes).
    startTime: "2020-01-01T00:00:00",
    endTime: toApiDateTime(new Date()),
  });
  const { data: folders } = useFolders();
  const { data: user } = useUserCredits();

  const folderList: FolderInfo[] = Array.isArray(folders) ? folders : [];

  const currentFolderName = useMemo(() => {
    if (selectedFolderId === "__all__") return t("layout.all_files");
    if (selectedFolderId === LOCAL_TRANSCRIPTION_FOLDER_ID) return t("layout.local_transcriptions");
    if (selectedFolderId === "__uncategorized__") return t("layout.uncategorized");
    if (selectedFolderId === "__trash__") return t("layout.trash");
    const found = folderList.find((f) => String(f.id) === selectedFolderId);
    return found?.folderName ?? t("layout.all_files");
  }, [selectedFolderId, folderList, t]);

  const filteredFiles = useMemo(() => {
    if (!Array.isArray(files)) return [];
    let result = filterWorkspaceFilesByFolder(files, selectedFolderId);

    if (activeTab === TAB_RECORDINGS) {
      // Local transcriptions + any cloud file whose MIME type is audio/video.
      result = result.filter(
        (f) =>
          isLocalFileId(f.id) ||
          (f.contentType ? /^audio\/|video\//i.test(f.contentType) : false),
      );
    } else if (activeTab === TAB_RECENT) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      result = result.filter((f) => new Date(f.createdAt || 0).getTime() > cutoff);
    }

    return result;
  }, [files, selectedFolderId, activeTab]);

  const handleSelectFolder = (folderId: string | null) => {
    selectFolder(folderId);
  };

  const tabs: { key: NotesTab; label: string }[] = [
    { key: TAB_ALL, label: t("notes.tab_all_files") },
    { key: TAB_RECENT, label: t("notes.tab_recent") },
    { key: TAB_RECORDINGS, label: t("notes.tab_recordings") },
  ];

  const ownerName = (user?.nickname as string) || "Me";
  const ownerInitials = ownerName.slice(0, 2).toUpperCase();

  const folderDropdownItems = (
    <DropdownMenuContent align="end" className="w-52">
      <DropdownMenuItem onClick={() => handleSelectFolder("__all__")}>
        <Layers className="mr-2 size-4" />
        {t("layout.all_files")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handleSelectFolder(LOCAL_TRANSCRIPTION_FOLDER_ID)}>
        <FileAudio className="mr-2 size-4" />
        {t("layout.local_transcriptions")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handleSelectFolder("__uncategorized__")}>
        <Circle className="mr-2 size-4" />
        {t("layout.uncategorized")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {folderList.length === 0 && (
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("layout.no_folders")}</div>
      )}
      {folderList.map((folder) => (
        <DropdownMenuItem key={folder.id} onClick={() => handleSelectFolder(String(folder.id))}>
          {folder.color ? (
            <span className="mr-2 size-2.5 rounded-full" style={{ backgroundColor: folder.color }} />
          ) : (
            <Circle className="mr-2 size-4" />
          )}
          {folder.folderName}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => handleSelectFolder("__trash__")}>
        <Trash2 className="mr-2 size-4" />
        {t("layout.trash")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      {/* Left: file list area */}
      <div
        className={cn(
          "flex min-w-0 flex-col overflow-hidden transition-[width] duration-300",
          selectedItemId ? "w-1/2 border-r border-border/50" : "flex-1"
        )}
      >
        {/* Header: tabs + actions */}
        <div
          className="flex shrink-0 select-none items-start justify-between border-b border-border/50 bg-background/80 px-4 py-3 backdrop-blur-xl"
          data-tauri-drag-region
        >
          <div className="flex items-center gap-2 pt-1" data-tauri-drag-region={false}>
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                  activeTab === tab.key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col items-end gap-2" data-tauri-drag-region={false}>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-lg border-border bg-card text-xs text-foreground shadow-sm hover:bg-accent"
                onClick={() => setUploadOpen(true)}
              >
                <Upload className="size-3.5" />
                {t("notes.upload")}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5 rounded-lg bg-primary text-xs text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={() => push("/recording")}
              >
                <Mic className="size-3.5" />
                {t("notes.record")}
              </Button>
            </div>

            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger
                  title={`${t("notes.filter")}: ${currentFolderName}`}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    selectedFolderId && selectedFolderId !== "__all__" ? "text-foreground" : ""
                  )}
                  data-tauri-drag-region={false}
                >
                  <Filter className="size-4" />
                </DropdownMenuTrigger>
                {folderDropdownItems}
              </DropdownMenu>

              <button
                type="button"
                onClick={() => setViewMode("grid")}
                title={t("notes.grid_view")}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg transition-colors",
                  viewMode === "grid"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <LayoutGrid className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                title={t("notes.list_view")}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg transition-colors",
                  viewMode === "list"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <List className="size-4" />
              </button>
            </div>
          </div>
        </div>

        {/* File list / grid */}
        <div className="flex-1 overflow-y-auto">
          {filteredFiles.length === 0 ? (
            <EmptyState />
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
              {filteredFiles.map((file) => (
                <GridCard
                  key={file.id}
                  file={file}
                  ownerName={ownerName}
                  ownerInitials={ownerInitials}
                  isSelected={selectedItemId === file.id}
                  onClick={() => selectItem(file.id, "file", file.title)}
                />
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border/40 px-4">
              {filteredFiles.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  ownerName={ownerName}
                  ownerInitials={ownerInitials}
                  isSelected={selectedItemId === file.id}
                  onClick={() => selectItem(file.id, "file", file.title)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: content + chat panels */}
      <AnimatePresence initial={false}>
        {selectedItemId && (
          <motion.div
            key="detail-panel"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "50%", opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
            className="flex min-w-0 flex-col bg-background"
          >
            <TitleBar />
            <div className="flex min-h-0 flex-1">
              <ContentPanel />
              <AnimatePresence initial={false}>
                {chatPanelVisible && (
                  <motion.div
                    key="chat-panel"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: chatPanelWidth, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
                    className="flex shrink-0 overflow-hidden border-l border-border/50 bg-card/95 shadow-[-12px_0_34px_rgba(0,0,0,0.14)] backdrop-blur-xl"
                  >
                    <ResizableHandle onResize={handleChatPanelResize} side="left" />
                    <div className="h-full overflow-hidden" style={{ width: chatPanelWidth }}>
                      <ChatPanel />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}

function FileRow({
  file,
  ownerName,
  ownerInitials,
  isSelected,
  onClick,
}: {
  file: WorkspaceItem;
  ownerName: string;
  ownerInitials: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-4 rounded-lg px-3 py-3 text-left transition-colors",
        isSelected ? "bg-accent/60" : "hover:bg-accent/30"
      )}
    >
      {/* Thumbnail */}
      <div className="relative flex h-[72px] w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-muted via-muted/60 to-primary/5">
        <FileAudio className="size-8 text-muted-foreground/45 group-hover:text-primary/50" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-foreground">{file.title}</h3>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("notes.permission_private")}</span>
        </div>
      </div>

      {/* Owner + actions */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-[9px] font-medium text-accent-brand-text">
            {ownerInitials}
          </div>
          <span className="max-w-[80px] truncate text-xs text-muted-foreground">{ownerName}</span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            // Share action not yet implemented
          }}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("notes.share")}
        >
          <Link className="size-4" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            // More actions not yet implemented
          }}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("notes.more")}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
    </button>
  );
}

function GridCard({
  file,
  ownerName,
  ownerInitials,
  isSelected,
  onClick,
}: {
  file: WorkspaceItem;
  ownerName: string;
  ownerInitials: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex flex-col rounded-xl border border-border/60 bg-card p-3 text-left transition-colors hover:border-primary/20 hover:bg-accent/30",
        isSelected ? "border-primary/40 bg-accent/40 ring-1 ring-primary/30" : ""
      )}
    >
      {/* Thumbnail */}
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-muted via-muted/60 to-primary/5">
        <FileAudio className="size-10 text-muted-foreground/40 group-hover:text-primary/40" />
      </div>

      {/* Title */}
      <h3 className="mt-2.5 line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-foreground">{file.title}</h3>

      {/* Footer: owner + actions */}
      <div className="mt-auto flex items-center justify-between pt-3">
        <div className="flex items-center gap-1.5">
          <div className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[8px] font-medium text-accent-brand-text">
            {ownerInitials}
          </div>
          <span className="max-w-[70px] truncate text-xs text-muted-foreground">{ownerName}</span>
        </div>

        <div className="flex items-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // Share action not yet implemented
            }}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("notes.share")}
          >
            <Link className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // More actions not yet implemented
            }}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("notes.more")}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </div>
      </div>
    </button>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
        <FolderOpen className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium text-foreground">{t("files.empty")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("files.empty_hint")}</p>
    </div>
  );
}
