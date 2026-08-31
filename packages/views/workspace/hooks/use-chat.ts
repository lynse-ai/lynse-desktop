import { useEffect } from "react";
import { useChatStore } from "./use-chat-store";
import { useAuthStore } from "@lynse/core/auth";

export { WAITING_POOL, classifyStatus } from "./use-chat-store";

export interface UseChatOptions {
  persistHistory?: boolean;
}

/**
 * Thin React binding over the module-level chat store. All chat state and the
 * streaming engine live in `useChatStore`, so the conversation survives page
 * navigation — the assistant keeps working in the background and the result is
 * preserved. This hook only (re)hydrates history and tracks whether a chat UI
 * is currently on screen (so the store can notify on background completion).
 */
export function useChat(_options?: UseChatOptions) {
  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
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

  const userId = useAuthStore((s) => s.user?.id ?? "user");
  useEffect(() => {
    useChatStore.getState().setUserId(userId);
  }, [userId]);

  useEffect(() => {
    useChatStore.getState().hydrate();
    useChatStore.getState().setChatVisible(true);
    return () => useChatStore.getState().setChatVisible(false);
  }, []);

  return {
    messages,
    isLoading,
    conversations,
    activeConversationId,
    workingConversationIds,
    unreadCount,
    sendMessage,
    clearMessages,
    selectConversation,
    stopStreaming,
    pendingConfirm,
    answerConfirm,
    dismissConfirm,
  };
}
