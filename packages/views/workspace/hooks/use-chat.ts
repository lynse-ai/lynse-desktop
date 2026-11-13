import { useEffect, useLayoutEffect } from "react";
import { useChatStore } from "./use-chat-store";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";
import { getWorkspaceState } from "../store";
import i18next from "i18next";
import { toast } from "sonner";

export { WAITING_POOL, classifyStatus } from "./use-chat-store";

export function sendSelectedNotePrompt(prompt: string) {
  const workspace = getWorkspaceState();
  const fileId = workspace.selectedItemId;
  if (!fileId) return;
  const session = getAuthStore()?.getState();
  const userId = session?.isAuthenticated ? session.user?.id : undefined;
  if (!userId) {
    toast.info(i18next.t("workspace.loading"));
    return;
  }
  if (!workspace.chatPanelVisible) workspace.toggleChatPanel();
  const chat = useChatStore.getState();
  chat.switchUser(userId);
  chat.setActiveAssistant("lynse");
  chat.openFileChat(fileId);
  chat.sendMessage(prompt, fileId, true, undefined, { assistant: "lynse", contextFileId: fileId });
}

/** Bind history and background runs to the current account across page changes. */
export function useChatSession() {
  const userId = useAuthStore((s) => s.isAuthenticated ? s.user?.id ?? null : null);
  useLayoutEffect(() => {
    useChatStore.getState().switchUser(userId);
  }, [userId]);
}

/**
 * Thin React binding over the module-level chat store. All chat state and the
 * streaming engine live in `useChatStore`, so the conversation survives page
 * navigation — the assistant keeps working in the background and the result is
 * preserved. Track whether a chat UI is visible for background notifications.
 */
export function useChat() {
  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeAssistant = useChatStore((s) => s.activeAssistant);
  const pendingConfirm = useChatStore((s) => s.pendingConfirm);
  const workingConversationIds = useChatStore((s) => s.workingConversationIds);
  const unreadCount = useChatStore((s) =>
    Object.values(s.unreadCounts).reduce((sum, count) => sum + count, 0),
  );
  const sendMessage = useChatStore((s) => s.sendMessage);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const answerConfirm = useChatStore((s) => s.answerConfirm);
  const dismissConfirm = useChatStore((s) => s.dismissConfirm);
  const setActiveAssistant = useChatStore((s) => s.setActiveAssistant);
  const syncWorkBuddyThread = useChatStore((s) => s.syncWorkBuddyThread);

  const userId = useAuthStore((s) => s.user?.id || null);
  const activeUserId = useChatStore((s) => s.userId);

  useEffect(() => {
    useChatStore.getState().setChatVisible(true);
    return () => useChatStore.getState().setChatVisible(false);
  }, []);

  return {
    messages,
    ready: userId !== null && userId === activeUserId,
    isLoading,
    conversations,
    activeConversationId,
    activeAssistant,
    workingConversationIds,
    unreadCount,
    sendMessage,
    clearMessages,
    selectConversation,
    stopStreaming,
    pendingConfirm,
    answerConfirm,
    dismissConfirm,
    setActiveAssistant,
    syncWorkBuddyThread,
  };
}
