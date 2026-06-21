"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { Bot, X, Send, FileText, Plus, Square } from "../../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";

import { useWorkspaceStore } from "../store";
import { useChat } from "../hooks/use-chat";
import { useFiles } from "../hooks/use-files";

export function ChatPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);
  const { messages, isLoading, sendMessage, clearMessages, stopStreaming } = useChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const { data: files } = useFiles({ pageSize: 200 });

  // Get file name for context display
  const selectedFileName = useMemo(() => {
    if (!selectedItemId || !files) return null;
    return files.find((f) => f.id === selectedItemId)?.title ?? null;
  }, [selectedItemId, files]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    sendMessage(input, selectedItemId ?? undefined);
    setInput("");
  };

  return (
    <aside
      className="flex h-full flex-col overflow-hidden border-l border-border bg-background"
    >
      {/* Header */}
      <div className="flex shrink-0 flex-col border-b border-border" style={{ padding: "8px 12px", gap: 6 }}>
        <div className="flex items-center gap-2">
          <Bot className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex flex-1 flex-col overflow-hidden">
            <span className="text-xs font-semibold text-muted-foreground">{t("chat.ai_assistant")}</span>
            <span className="truncate text-[11px] text-muted-foreground/60">{t("chat.ready")}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 p-0"
            onClick={clearMessages}
            title={t("chat.new_chat")}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 p-0"
            onClick={toggleChatPanel}
            title={t("chat.close")}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Context bar */}
      {selectedItemId && (
        <div
          className="flex shrink-0 items-center border-b border-border text-muted-foreground"
          style={{ padding: "6px 12px", gap: 6, fontSize: 11 }}
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate font-medium">{selectedFileName || selectedItemId}</span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto" style={{ padding: 12 }}>
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center pt-10 text-center text-muted-foreground">
            <Bot className="mb-2 size-6 opacity-50" />
            <p className="text-xs">{t("chat.empty_prompt")}</p>
            <p className="mt-1 text-[11px] opacity-60">
              {t("chat.empty_hint")}
            </p>
          </div>
        )}
        <div className="space-y-3">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={msg.role === "user" ? "flex justify-end" : ""}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                {msg.content ? (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div ref={scrollRef} />
      </div>

      {/* Composer */}
      <div className="flex shrink-0 border-t border-border" style={{ padding: "8px 12px" }}>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={t("workspace.chat_placeholder")}
              className="h-8 text-xs"
              disabled={isLoading}
            />
          </div>
          {isLoading ? (
            <Button
              size="icon"
              variant="destructive"
              className="size-8 shrink-0"
              onClick={stopStreaming}
              style={{ borderRadius: 8 }}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-8 shrink-0"
              onClick={handleSend}
              disabled={!input.trim()}
              style={{
                background: input.trim() ? "var(--primary)" : "var(--muted)",
                color: input.trim() ? "var(--primary-foreground)" : "var(--muted-foreground)",
                borderRadius: 8,
              }}
            >
              <Send className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
