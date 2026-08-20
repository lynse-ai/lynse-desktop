import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  ChatStreamEvent,
  ChatConfirm,
  ChatConversation,
  QoderChatSessionState,
} from "../types";
import {
  CloudChatTransport,
  QoderChatTransport,
  extractConfirmFromText,
  getDesktopQoderChatApi,
  type ChatTransport,
} from "../chat-transport";
import { useAuthStore } from "@lynse/core/auth";
import { redactMeetingIds } from "../meeting-id-redact";
import { conversationTitle, loadChatHistory, saveChatHistory } from "../chat-history";

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readLynseToken(): string | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem("lynse_token");
  } catch {
    /* ignore */
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through */
    }
  }
  return "Unknown error";
}

export interface UseChatOptions {
  persistHistory?: boolean;
}

export function useChat({ persistHistory = false }: UseChatOptions = {}) {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id ?? "user";
  const [initialHistory] = useState(() =>
    persistHistory
      ? loadChatHistory(userId)
      : { activeConversationId: null, conversations: [] as ChatConversation[] },
  );
  const initialConversation = initialHistory.conversations.find(
    (conversation) => conversation.id === initialHistory.activeConversationId,
  );
  const [messages, setMessages] = useState<ChatMessage[]>(initialConversation?.messages ?? []);
  const [isLoading, setIsLoading] = useState(false);
  const [conversations, setConversations] = useState<ChatConversation[]>(
    initialHistory.conversations,
  );
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    initialConversation?.id ?? null,
  );
  const transportRef = useRef<ChatTransport | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(initialConversation?.id ?? null);
  const messagesRef = useRef<ChatMessage[]>(initialConversation?.messages ?? []);
  const conversationsRef = useRef<ChatConversation[]>(initialHistory.conversations);
  const activeConversationIdRef = useRef<string | null>(initialConversation?.id ?? null);
  const qoderSessionStateRef = useRef<QoderChatSessionState | undefined>(
    initialConversation?.qoderSession,
  );
  const [pendingConfirm, setPendingConfirm] = useState<{ messageId: string; confirm: ChatConfirm } | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
    if (!persistHistory || !activeConversationIdRef.current) return;
    const conversationId = activeConversationIdRef.current;
    const updatedAt = messages.at(-1)?.timestamp ?? Date.now();
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, messages, updatedAt }
          : conversation,
      ),
    );
  }, [messages, persistHistory]);

  useEffect(() => {
    conversationsRef.current = conversations;
    if (!persistHistory) return;
    saveChatHistory(userId, { activeConversationId, conversations });
  }, [activeConversationId, conversations, persistHistory, userId]);

  const handleQoderSessionState = useCallback(
    (state: QoderChatSessionState) => {
      qoderSessionStateRef.current = state;
      if (!persistHistory || !activeConversationIdRef.current) return;
      const conversationId = activeConversationIdRef.current;
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, qoderSession: state }
            : conversation,
        ),
      );
    },
    [persistHistory],
  );

  const makeTransport = useCallback(
    (qoderSession?: QoderChatSessionState): ChatTransport => {
      return getDesktopQoderChatApi()
        ? new QoderChatTransport(qoderSession, handleQoderSessionState)
        : new CloudChatTransport();
    },
    [handleQoderSessionState],
  );

  const handleEvent = useCallback((evt: ChatStreamEvent, assistantId: string) => {
    switch (evt.type) {
      case "status":
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, status: evt.text } : m)),
        );
        break;
      case "content":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: redactMeetingIds(m.content + evt.delta) } : m,
          ),
        );
        break;
      case "meta":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  sources: evt.sources ? evt.sources.map(redactMeetingIds) : evt.sources,
                  attachments: evt.attachments,
                }
              : m,
          ),
        );
        break;
      case "done": {
        const current = messagesRef.current.find((m) => m.id === assistantId);
        const finalContent = evt.text ?? current?.content ?? "";
        const detected = extractConfirmFromText(finalContent);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            return {
              ...m,
              content: redactMeetingIds(finalContent),
              status: undefined,
              sources: evt.sources ? evt.sources.map(redactMeetingIds) : m.sources,
              attachments: evt.attachments ?? m.attachments,
              confirm: detected && !m.confirm ? detected : m.confirm,
            };
          }),
        );
        if (detected && !current?.confirm) {
          setPendingConfirm({ messageId: assistantId, confirm: detected });
        }
        break;
      }
      case "confirm":
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, confirm: evt.confirm } : m)),
        );
        setPendingConfirm({ messageId: assistantId, confirm: evt.confirm });
        break;
      case "error":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content || `Error: ${evt.message}`, error: true, status: undefined }
              : m,
          ),
        );
        break;
    }
  }, []);

  const runSend = useCallback(
    (content: string, fileId?: string, userSpecifiedFile = false) => {
      const userMsg: ChatMessage = {
        id: makeId("user"),
        role: "user",
        content,
        timestamp: Date.now(),
      };
      const assistantId = makeId("assistant");
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      if (persistHistory && !activeConversationIdRef.current) {
        const conversationId = makeId("conversation");
        const provider = getDesktopQoderChatApi() ? "qoder" : "cloud";
        const conversation: ChatConversation = {
          id: conversationId,
          title: conversationTitle(content),
          messages: [],
          provider,
          createdAt: userMsg.timestamp,
          updatedAt: assistantMsg.timestamp,
        };
        activeConversationIdRef.current = conversationId;
        qoderSessionStateRef.current = undefined;
        sessionIdRef.current = conversationId;
        setActiveConversationId(conversationId);
        setConversations((prev) => [conversation, ...prev]);
      }
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsLoading(true);

      if (!sessionIdRef.current) sessionIdRef.current = makeId("session");
      const sessionId = sessionIdRef.current;

      const transport = transportRef.current ?? makeTransport(qoderSessionStateRef.current);
      transportRef.current = transport;
      const controller = new AbortController();
      abortRef.current = controller;

      transport
        .send({
          query: content,
          sessionId,
          userId,
          fileIds: fileId ? [fileId] : [],
          userSpecifiedFile,
          token: readLynseToken(),
          signal: controller.signal,
          onEvent: (evt) => handleEvent(evt, assistantId),
        })
        .then(() => {
          if (abortRef.current === controller) {
            setIsLoading(false);
            abortRef.current = null;
          }
        })
        .catch((error: unknown) => {
          const message = errorMessage(error);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: m.content || `Error: ${message}`,
                    error: true,
                    status: undefined,
                  }
                : m,
            ),
          );
          if (abortRef.current === controller) {
            setIsLoading(false);
            abortRef.current = null;
          }
        });
    },
    [userId, makeTransport, handleEvent, persistHistory],
  );

  const sendMessage = useCallback(
    (content: string, fileId?: string, userSpecifiedFile = false) => {
      if (!content.trim() || isLoading) return;
      runSend(content, fileId, userSpecifiedFile);
    },
    [isLoading, runSend],
  );

  const answerConfirm = useCallback(
    (messageId: string, value: string) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, confirm: undefined } : m)),
      );
      setPendingConfirm(null);
      runSend(value);
    },
    [runSend],
  );

  const dismissConfirm = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, confirm: undefined } : m)),
    );
    setPendingConfirm(null);
  }, []);

  const stopStreaming = useCallback(() => {
    transportRef.current?.cancel();
    transportRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  const clearMessages = useCallback(() => {
    transportRef.current?.cancel();
    transportRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    sessionIdRef.current = null;
    activeConversationIdRef.current = null;
    qoderSessionStateRef.current = undefined;
    if (persistHistory) setActiveConversationId(null);
    setMessages([]);
    setPendingConfirm(null);
    setIsLoading(false);
  }, [persistHistory]);

  const selectConversation = useCallback(
    (conversationId: string) => {
      if (isLoading || conversationId === activeConversationIdRef.current) return;
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      transportRef.current = null;
      abortRef.current = null;
      activeConversationIdRef.current = conversation.id;
      qoderSessionStateRef.current = conversation.qoderSession;
      sessionIdRef.current = conversation.id;
      messagesRef.current = conversation.messages;
      setActiveConversationId(conversation.id);
      setMessages(conversation.messages);
      setPendingConfirm(null);
    },
    [isLoading],
  );

  return {
    messages,
    isLoading,
    conversations,
    activeConversationId,
    sendMessage,
    clearMessages,
    selectConversation,
    stopStreaming,
    pendingConfirm,
    answerConfirm,
    dismissConfirm,
  };
}
