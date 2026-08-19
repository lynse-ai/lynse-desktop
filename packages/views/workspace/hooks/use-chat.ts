import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatStreamEvent, ChatConfirm } from "../types";
import {
  CloudChatTransport,
  QoderChatTransport,
  extractConfirmFromText,
  getDesktopQoderChatApi,
  type ChatTransport,
} from "../chat-transport";
import { useAuthStore } from "@lynse/core/auth";
import { redactMeetingIds } from "../meeting-id-redact";

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

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const transportRef = useRef<ChatTransport | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<{ messageId: string; confirm: ChatConfirm } | null>(null);

  const user = useAuthStore((s) => s.user);
  const userId = user?.id ?? "user";

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const makeTransport = useCallback((): ChatTransport => {
    return getDesktopQoderChatApi() ? new QoderChatTransport() : new CloudChatTransport();
  }, []);

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
        const finalContent =
          evt.text && evt.text.length >= (current?.content.length ?? 0)
            ? evt.text
            : (current?.content ?? "");
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
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsLoading(true);

      if (!sessionIdRef.current) sessionIdRef.current = makeId("session");
      const sessionId = sessionIdRef.current;

      const transport = transportRef.current ?? makeTransport();
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
        .catch((err: Error) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: m.content || `Error: ${err.message}`,
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
    [userId, makeTransport, handleEvent],
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
    setMessages([]);
    setPendingConfirm(null);
    setIsLoading(false);
  }, []);

  return {
    messages,
    isLoading,
    sendMessage,
    clearMessages,
    stopStreaming,
    pendingConfirm,
    answerConfirm,
    dismissConfirm,
  };
}
