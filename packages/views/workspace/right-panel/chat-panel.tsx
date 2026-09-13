"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { X, Send, FileText, Plus, Square, Clock, Image as ImageIcon, Headphones } from "../../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { StreamingMarkdown } from "@lynse/ui/markdown";
import { AssistantAvatar } from "../../assistant";
import { useTranslation } from "@lynse/core/i18n/react";

import { useWorkspaceStore } from "../store";
import { useChat } from "../hooks/use-chat";
import { WaitingText } from "../hooks/waiting-text";
import { useFiles } from "../hooks/use-files";
import { ConfirmDialog } from "../ConfirmDialog";
import { isFreshlyRevealed } from "../chat-reveal";
import { ChatAttachments } from "../../chat/chat-attachments";
import { ChatHistorySidebar } from "../../chat/chat-history-sidebar";

export function ChatPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedItemTitle = useWorkspaceStore((s) => s.selectedItemTitle);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);
  const {
    messages,
    isLoading,
    conversations,
    activeConversationId,
    workingConversationIds,
    sendMessage,
    clearMessages,
    selectConversation,
    stopStreaming,
    pendingConfirm,
    answerConfirm,
    dismissConfirm,
  } = useChat({ persistHistory: true });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const { data: files } = useFiles({ pageSize: 200 });

  const selectedFileName = useMemo(() => {
    if (!selectedItemId) return null;
    const listedTitle = files?.find((f) => f.id === selectedItemId)?.title ?? null;
    return listedTitle || selectedItemTitle;
  }, [selectedItemId, files, selectedItemTitle]);

  // Stick-to-bottom: follow the newest message while the user is parked near
  // the bottom, and never yank the view if they scrolled up to re-read.
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleListScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    // A selected meeting scopes the assistant to that meeting.
    sendMessage(input, selectedItemId ?? undefined, !!selectedItemId);
    setInput("");
  };

  return (
    <aside className="relative flex h-full flex-col overflow-hidden border-l border-border bg-background">
      {/* Header */}
      <div className="flex shrink-0 flex-col border-b border-border" style={{ padding: "8px 12px", gap: 6 }}>
        <div className="flex items-center gap-2">
          <AssistantAvatar size={90} />
          <div className="flex flex-1 flex-col overflow-hidden">
            <span className="text-xs font-semibold text-muted-foreground">{t("chat.ai_assistant")}</span>
            <span className="truncate text-2xs text-muted-foreground/60">{t("chat.ready")}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={`size-6 p-0 ${historyOpen ? "bg-card text-foreground" : ""}`}
            onClick={() => setHistoryOpen((open) => !open)}
            title={t("chat.history")}
          >
            <Clock className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6 p-0" onClick={clearMessages} title={t("chat.new_chat")}>
            <Plus className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6 p-0" onClick={toggleChatPanel} title={t("chat.close")}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {historyOpen && (
        <aside className="absolute inset-y-0 left-0 z-20 flex w-56 flex-col border-r border-border/60 bg-background">
          <ChatHistorySidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            workingConversationIds={workingConversationIds}
            onSelect={(id) => {
              selectConversation(id);
              setHistoryOpen(false);
            }}
            onClose={() => setHistoryOpen(false)}
          />
        </aside>
      )}

      {/* Context bar */}
      {selectedItemId && (
        <div className="text-2xs flex shrink-0 items-center border-b border-border text-muted-foreground" style={{ padding: "6px 12px", gap: 6 }}>
          <FileText className="size-3 shrink-0" />
          <span className="truncate font-medium">{selectedFileName || selectedItemId}</span>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleListScroll}
        className="flex-1 overflow-y-auto overscroll-contain"
        style={{ padding: 12 }}
      >
        {messages.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center pt-10 text-center text-muted-foreground">
            <AssistantAvatar size={179} className="mb-2 opacity-90" />
            <p className="text-xs">{t("chat.empty_prompt")}</p>
            <p className="mt-1 text-2xs opacity-60">{t("chat.empty_hint")}</p>
          </div>
        )}
        <div className="space-y-3">
          {messages.map((msg) => {
            // The transport types the answer out itself; `revealedAt` only
            // staggers attachments / support link in after the text lands.
            const revealed = msg.role === "assistant" && isFreshlyRevealed(msg);
            return (
            <div key={msg.id} className={msg.role === "user" ? "flex justify-end" : ""}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : msg.error
                      ? "border border-destructive/40 bg-destructive/10 text-destructive"
                      : "bg-muted text-foreground"
                }`}
              >
                {msg.role === "user" ? (
                  <>
                    {(msg.attachments?.length ?? 0) > 0 && (
                      <div className="mb-1.5 flex flex-wrap justify-end gap-1">
                        {msg.attachments!.map((attachment, index) => (
                          <span
                            key={attachment.id ?? `${attachment.name}-${index}`}
                            className="flex max-w-40 items-center gap-1 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-1.5 py-0.5 text-3xs text-primary-foreground"
                            title={attachment.name}
                          >
                            {attachment.type === "image" ? (
                              <ImageIcon className="size-3 shrink-0" />
                            ) : (
                              <FileText className="size-3 shrink-0" />
                            )}
                            <span className="min-w-0 truncate">{attachment.name}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {msg.content ? (
                      <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                    ) : (
                      <span className="text-muted-foreground">{msg.status || "…"}</span>
                    )}
                  </>
                ) : msg.error ? (
                  <div className="whitespace-pre-wrap break-words text-destructive">{msg.content}</div>
                ) : msg.content ? (
                  <StreamingMarkdown content={msg.content} isStreaming={isLoading} mode="minimal" />
                ) : msg.status ? (
                  <span className="text-muted-foreground">
                    <WaitingText status={msg.status} />
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                )}
                {msg.role === "assistant" && msg.content && msg.status && (
                  <div className="mt-2 flex items-center gap-1.5 text-3xs text-muted-foreground">
                    <span className="size-1.5 animate-pulse rounded-full bg-current" />
                    <WaitingText status={msg.status} />
                  </div>
                )}
                {msg.role === "assistant" && msg.humanSupportLink?.url && (
                  <a
                    href={msg.humanSupportLink.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`mt-2 flex w-fit items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-3xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent ${
                      revealed ? "animate-in fade-in duration-300 delay-[350ms] fill-mode-backwards" : ""
                    }`}
                  >
                    <Headphones className="size-3 shrink-0 text-primary/70" />
                    {msg.humanSupportLink.label?.trim() || t("chat.contact_support")}
                  </a>
                )}
                {msg.role === "assistant" ? (
                  <div
                    className={
                      revealed ? "animate-in fade-in duration-300 delay-[350ms] fill-mode-backwards" : undefined
                    }
                  >
                    <ChatAttachments attachments={msg.attachments} compact />
                  </div>
                ) : (
                  <ChatAttachments attachments={msg.attachments} compact />
                )}
              </div>
            </div>
            );
          })}
        </div>
      </div>

      {/* Composer */}
      <div className="flex shrink-0 border-t border-border" style={{ padding: "8px 12px" }}>
        <div className="flex w-full items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={t("workspace.chat_placeholder")}
              className="h-8 text-xs"
            />
          </div>
          {isLoading ? (
            <Button size="icon" variant="destructive" className="size-8 shrink-0" onClick={stopStreaming} style={{ borderRadius: 8 }} title={t("chat.stop")}>
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

      <ConfirmDialog
        confirm={pendingConfirm?.confirm ?? null}
        onSelect={(value) => {
          if (pendingConfirm) answerConfirm(pendingConfirm.messageId, value);
        }}
        onDismiss={() => {
          if (pendingConfirm) dismissConfirm(pendingConfirm.messageId);
        }}
      />
    </aside>
  );
}
