import type { ChatConversation, ChatMessage } from "./types";

const CHAT_HISTORY_STORAGE_PREFIX = "lynse_ai_chat_history_v1";

export interface StoredChatHistory {
  activeConversationId: string | null;
  conversations: ChatConversation[];
}

function storageKey(userId: string): string {
  return `${CHAT_HISTORY_STORAGE_PREFIX}:${userId || "user"}`;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    typeof message.timestamp === "number"
  );
}

function isConversation(value: unknown): value is ChatConversation {
  if (!value || typeof value !== "object") return false;
  const conversation = value as Partial<ChatConversation>;
  return (
    typeof conversation.id === "string" &&
    typeof conversation.title === "string" &&
    (conversation.provider === "cloud" || conversation.provider === "qoder") &&
    typeof conversation.createdAt === "number" &&
    typeof conversation.updatedAt === "number" &&
    Array.isArray(conversation.messages) &&
    conversation.messages.every(isChatMessage) &&
    (conversation.qoderSession === undefined ||
      (typeof conversation.qoderSession.sessionId === "string" &&
        conversation.qoderSession.sessionId.startsWith("sess_") &&
        typeof conversation.qoderSession.sessionOptionsKey === "string" &&
        (conversation.qoderSession.afterEventId === undefined ||
          typeof conversation.qoderSession.afterEventId === "string")))
  );
}

function messagesForStorage(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.role !== "assistant" || !!message.content || !!message.error)
    .map(({ status: _status, ...message }) => message);
}

export function conversationTitle(firstMessage: string): string {
  const title = firstMessage.trim().replace(/\s+/g, " ");
  if (!title) return "新对话";
  return title.length > 36 ? `${title.slice(0, 36)}…` : title;
}

export function loadChatHistory(userId: string): StoredChatHistory {
  if (typeof window === "undefined") {
    return { activeConversationId: null, conversations: [] };
  }
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return { activeConversationId: null, conversations: [] };
    const parsed = JSON.parse(raw) as Partial<StoredChatHistory>;
    const conversations = Array.isArray(parsed.conversations)
      ? parsed.conversations.filter(isConversation)
      : [];
    const activeConversationId =
      typeof parsed.activeConversationId === "string" &&
      conversations.some((conversation) => conversation.id === parsed.activeConversationId)
        ? parsed.activeConversationId
        : null;
    return { activeConversationId, conversations };
  } catch {
    return { activeConversationId: null, conversations: [] };
  }
}

export function saveChatHistory(userId: string, history: StoredChatHistory): void {
  if (typeof window === "undefined") return;
  const conversations = history.conversations.map((conversation) => ({
    ...conversation,
    messages: messagesForStorage(conversation.messages),
  }));
  try {
    window.localStorage.setItem(
      storageKey(userId),
      JSON.stringify({ activeConversationId: history.activeConversationId, conversations }),
    );
  } catch {
    // A full or unavailable local store must not interrupt an active chat.
  }
}
