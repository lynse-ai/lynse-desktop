"use client";

import { useEffect, useCallback } from "react";
import { useWorkspaceStore } from "./store";
import { FileList } from "./middle-panel/file-list";
import { ContentPanel } from "./content-panel";
import { ChatPanel } from "./right-panel/chat-panel";
import { ResizableHandle } from "./resizable-handle";
import { TitleBar } from "../layout/title-bar";
import { useDndBridge } from "./dnd-provider";
import { useMoveFiles } from "./hooks/use-folder-mutations";
import type { WorkspaceItem } from "./types";
import type { DragEndEvent } from "@dnd-kit/core";

export function WorkspaceLayout() {
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const chatPanelWidth = useWorkspaceStore((s) => s.chatPanelWidth);
  const handleChatPanelResize = useWorkspaceStore((s) => s.handleChatPanelResize);
  const handleFileListResize = useWorkspaceStore((s) => s.handleFileListResize);

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
    setOnDragEnd(() => handleDragEnd);
    return () => setOnDragEnd(null);
  }, [setOnDragEnd, handleDragEnd]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Left panel: file list (full height) */}
      <FileList />
      <ResizableHandle onResize={handleFileListResize} side="right" />

      {/* Right column: title bar + content panel + chat panel */}
      <div className="flex flex-1 min-w-0 flex-col">
        <TitleBar />
        <div className="flex flex-1 min-h-0">
          {/* Content panel: tabs + content + outline sidebar */}
          <div className="flex-1 min-w-0">
            <ContentPanel />
          </div>

          {/* Chat panel: slides in from right when "Ask AI" is clicked */}
          {chatPanelVisible && (
            <>
              <ResizableHandle onResize={handleChatPanelResize} side="left" />
              <div className="shrink-0 overflow-hidden" style={{ width: chatPanelWidth }}>
                <ChatPanel />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
