"use client";

import { useRef, useEffect, useState } from "react";
import { Bot, X, Send, FileText, Plus } from "lucide-react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";

import { useWorkspaceStore } from "../store";
import { useChat } from "../hooks/use-chat";

export function ChatPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);
  const { messages, isLoading, sendMessage, clearMessages } = useChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

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
            <span className="text-xs font-semibold text-muted-foreground">AI Assistant</span>
            <span className="truncate text-[11px] text-muted-foreground/60">Ready</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 p-0"
            onClick={clearMessages}
            title="New chat"
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 p-0"
            onClick={toggleChatPanel}
            title="Close"
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
          <span className="truncate font-medium">{selectedItemId}</span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto" style={{ padding: 12 }}>
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center pt-10 text-center text-muted-foreground">
            <Bot className="mb-2 size-6 opacity-50" />
            <p className="text-xs">Ask questions about your files</p>
            <p className="mt-1 text-[11px] opacity-60">
              Select a file and start chatting
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
                {msg.content || (
                  <span className="flex items-center gap-1">
                    <span className="animate-pulse">Thinking</span>
                    <span className="animate-pulse">...</span>
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
              placeholder="Ask about this file..."
              className="h-8 text-xs"
              disabled={isLoading}
            />
          </div>
          <Button
            size="icon"
            className="size-8 shrink-0"
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            style={{
              background: input.trim() ? "var(--primary)" : "var(--muted)",
              color: input.trim() ? "var(--primary-foreground)" : "var(--muted-foreground)",
              borderRadius: 8,
            }}
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
