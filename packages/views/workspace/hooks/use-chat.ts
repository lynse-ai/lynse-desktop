import { useState, useCallback, useRef } from "react";
import { api } from "@lynse/core/api";
import type { ChatMessage } from "../types";

const CHAT_STREAM_PATH = "/api/business/ai/chat/stream";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    (content: string, fileId?: string) => {
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      const assistantId = `assistant-${Date.now()}`;
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      const body: Record<string, unknown> = {
        query: content,
      };
      if (fileId) body.fileIds = [fileId];
      if (sessionIdRef.current) body.seesionId = sessionIdRef.current;

      console.log("[chat] sending:", JSON.stringify(body));

      const controller = api().stream(
        CHAT_STREAM_PATH,
        body,
        (data) => {
          // Try to parse as JSON; fall back to raw text
          let text = data;
          try {
            const parsed = JSON.parse(data);
            if (typeof parsed === "string") {
              text = parsed;
            } else if (parsed.content) {
              text = parsed.content;
            } else if (parsed.text) {
              text = parsed.text;
            } else if (parsed.delta) {
              text = parsed.delta;
            } else if (parsed.choices?.[0]?.delta?.content) {
              text = parsed.choices[0].delta.content;
            }
          } catch {
            // raw text, use as-is
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + text }
                : m,
            ),
          );
        },
        (err) => {
          console.error("[chat] stream error:", err.message);
          // Try to parse JSON error from backend
          let displayMsg = err.message;
          try {
            const parsed = JSON.parse(err.message);
            displayMsg = parsed.msg || parsed.message || parsed.error || err.message;
          } catch {
            // not JSON, use as-is
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId && !m.content
                ? { ...m, content: `Error: ${displayMsg}` }
                : m,
            ),
          );
          setIsLoading(false);
        },
      );

      abortRef.current = controller;

      // Detect stream end via message content stability
      let lastLen = 0;
      let stableTicks = 0;
      const doneChecker = setInterval(() => {
        setMessages((prev) => {
          const msg = prev.find((m) => m.id === assistantId);
          if (!msg) return prev;
          if (msg.content.length === lastLen && msg.content.length > 0) {
            stableTicks++;
            if (stableTicks >= 2) {
              clearInterval(doneChecker);
              setIsLoading(false);
              // Generate a session ID from the conversation
              if (!sessionIdRef.current) {
                sessionIdRef.current = `session-${Date.now()}`;
              }
            }
          } else {
            stableTicks = 0;
          }
          lastLen = msg.content.length;
          return prev;
        });
      }, 500);
    },
    [],
  );

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sessionIdRef.current = null;
    setMessages([]);
    setIsLoading(false);
  }, []);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  return { messages, isLoading, sendMessage, clearMessages, stopStreaming };
}
