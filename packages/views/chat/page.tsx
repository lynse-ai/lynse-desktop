"use client";

import { useState } from "react";
import { MessageSquare, Send } from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { ScrollArea } from "@lynse/ui/components/ui/scroll-area";
import { useTranslation } from "@lynse/core/i18n/react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const { t } = useTranslation();

  const handleSend = () => {
    if (!input.trim()) return;
    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    // TODO: call your AI backend
  };

  return (
    <div className="flex h-full flex-col">
      {/* ── Draggable strip at top (3 toolbar icons live in the sidebar) ── */}
      <div
        className="flex shrink-0 items-center border-b border-border bg-background/80 backdrop-blur-sm select-none"
        style={{ height: 38 }}
        data-tauri-drag-region
      >
        <div className="flex-1 px-4">
          <span className="text-xs text-muted-foreground">{t("chat.page_title")}</span>
        </div>
      </div>
      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <MessageSquare className="size-5 text-muted-foreground" />
          </div>
          <div className="text-center">
            <h3 className="text-sm font-medium">{t("chat.page_title")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("chat.page_description")}
            </p>
          </div>
        </div>
      ) : (
        <ScrollArea className="flex-1 p-4">
          <div className="mx-auto max-w-2xl space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={msg.role === "user" ? "flex justify-end" : ""}
              >
                <div
                  className={`rounded-lg px-3 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      <div className="border-t p-4">
        <div className="mx-auto flex max-w-2xl gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder={t("chat.page_placeholder")}
            className="flex-1"
          />
          <Button size="icon" onClick={handleSend} disabled={!input.trim()}>
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
