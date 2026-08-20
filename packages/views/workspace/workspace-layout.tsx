"use client";

import { useEffect, useCallback, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useWorkspaceStore } from "./store";
import { FileList } from "./middle-panel/file-list";
import { ContentPanel } from "./content-panel";
import { ChatPanel } from "./right-panel/chat-panel";
import { ResizableHandle } from "./resizable-handle";
import { TitleBar } from "../layout/title-bar";
import { useTranslation } from "@lynse/core/i18n/react";
import { useDndBridge } from "./dnd-provider";
import { useMoveFiles } from "./hooks/use-folder-mutations";
import type { WorkspaceItem } from "./types";
import type { DragEndEvent } from "@dnd-kit/core";

export function WorkspaceLayout() {
  const { t } = useTranslation();
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const chatPanelWidth = useWorkspaceStore((s) => s.chatPanelWidth);
  const handleChatPanelResize = useWorkspaceStore((s) => s.handleChatPanelResize);
  const handleFileListResize = useWorkspaceStore((s) => s.handleFileListResize);

  const [isChatResizing, setIsChatResizing] = useState(false);
  const reduceMotion = useReducedMotion();

  const { setOnDragEnd } = useDndBridge();
  const moveFilesMutation = useMoveFiles();

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const fileData = active.data.current as { file?: WorkspaceItem } | undefined;
      const folderData = over.data.current as { folderId?: string } | undefined;
      if (!fileData?.file || folderData?.folderId === undefined) return;

      const file = fileData.file;
      const targetFolderId = folderData.folderId;
      const currentFolderId = file.folderId ?? "";
      if (currentFolderId === targetFolderId) return;

      moveFilesMutation.mutate({
        oldFolderId: currentFolderId,
        newFolderId: targetFolderId,
        fileIds: [file.id],
      });
    },
    [moveFilesMutation],
  );

  useEffect(() => {
    setOnDragEnd(handleDragEnd);
    return () => setOnDragEnd(null);
  }, [setOnDragEnd, handleDragEnd]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      {/* Left panel: file list (full height) */}
      <FileList />
      <ResizableHandle
        label={t("workspace.resize_file_list")}
        onResize={handleFileListResize}
        side="right"
      />

      {/* Right column: title bar + content panel + chat panel */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {/* Primary content panel */}
          <div className="min-w-0 flex-1 bg-background">
            <ContentPanel />
          </div>

          {/* Chat panel: slides in from right when "Ask AI" is clicked */}
          <AnimatePresence initial={false}>
            {chatPanelVisible && (
              <motion.div
                key="chat-panel"
                className="flex shrink-0 overflow-hidden border-l border-border/50 bg-card/95 shadow-[-12px_0_34px_rgba(0,0,0,0.14)] backdrop-blur-xl"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: chatPanelWidth, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={
                  isChatResizing || reduceMotion
                    ? { duration: 0 }
                    : { duration: 0.26, ease: [0.23, 1, 0.32, 1] }
                }
              >
                <ResizableHandle
                  label={t("workspace.resize_chat_panel")}
                  onResize={handleChatPanelResize}
                  onResizeStart={() => setIsChatResizing(true)}
                  onResizeEnd={() => setIsChatResizing(false)}
                  side="left"
                />
                <div className="h-full overflow-hidden" style={{ width: chatPanelWidth }}>
                  <ChatPanel />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
