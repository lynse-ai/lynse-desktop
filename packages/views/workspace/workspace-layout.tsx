"use client";

import { useWorkspaceStore } from "./store";
import { FileList } from "./middle-panel/file-list";
import { ContentPanel } from "./content-panel";
import { ChatPanel } from "./right-panel/chat-panel";
import { ResizableHandle } from "./resizable-handle";

export function WorkspaceLayout() {
  const chatPanelVisible = useWorkspaceStore((s) => s.chatPanelVisible);
  const chatPanelWidth = useWorkspaceStore((s) => s.chatPanelWidth);
  const handleChatPanelResize = useWorkspaceStore((s) => s.handleChatPanelResize);
  const handleFileListResize = useWorkspaceStore((s) => s.handleFileListResize);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Middle panel: file list */}
      <FileList />
      <ResizableHandle onResize={handleFileListResize} side="right" />

      {/* Content panel: tabs + content + outline sidebar */}
      <div className="flex-1 min-w-0">
        <ContentPanel />
      </div>

      {/* Chat panel: slides in from right when "Ask AI" is clicked */}
      {chatPanelVisible && (
        <>
          <ResizableHandle onResize={handleChatPanelResize} side="right" />
          <div className="shrink-0 overflow-hidden" style={{ width: chatPanelWidth }}>
            <ChatPanel />
          </div>
        </>
      )}
    </div>
  );
}
