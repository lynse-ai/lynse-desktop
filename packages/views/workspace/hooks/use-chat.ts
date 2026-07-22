import { useCallback, useRef, useState } from "react";
import type { ChatMessage, ChatStreamEvent } from "../types";
import { CloudChatTransport, type ChatTransport } from "../chat-transport";
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

  const user = useAuthStore((s) => s.user);
  const userId = user?.id ?? "user";

  const makeTransport = useCallback((): ChatTransport => {
    return new CloudChatTransport();
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
      case "done":
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            // Reconcile: ensure the final text matches done.text for consistency,
            // but NEVER append done.text again (avoids duplication).
            const finalContent =
              evt.text && evt.text.length >= m.content.length ? evt.text : m.content;
            return {
              ...m,
              content: redactMeetingIds(finalContent),
              status: undefined,
              sources: evt.sources ? evt.sources.map(redactMeetingIds) : m.sources,
              attachments: evt.attachments ?? m.attachments,
            };
          }),
        );
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

  const sendMessage = useCallback(
    (content: string, fileId?: string, userSpecifiedFile = false) => {
      if (!content.trim() || isLoading) return;

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

      const transport = makeTransport();
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
          setIsLoading(false);
          transportRef.current = null;
          abortRef.current = null;
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
          setIsLoading(false);
          transportRef.current = null;
          abortRef.current = null;
        });
    },
    [isLoading, userId, makeTransport, handleEvent],
  );

  const stopStreaming = useCallback(() => {
    transportRef.current?.cancel();
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  const clearMessages = useCallback(() => {
    transportRef.current?.cancel();
    transportRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    sessionIdRef.current = null;
    setMessages([]);
    setIsLoading(false);
  }, []);

  return {
    messages,
    isLoading,
    sendMessage,
    clearMessages,
    stopStreaming,
  };
}
