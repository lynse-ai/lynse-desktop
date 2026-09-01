"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  Clock,
  Mic,
  Plus,
  Square,
} from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { StreamingMarkdown } from "@lynse/ui/markdown";
import { AssistantAvatar } from "../assistant";
import { useTranslation } from "@lynse/core/i18n/react";
import { useChat } from "../workspace/hooks/use-chat";
import { WaitingText } from "../workspace/hooks/waiting-text";
import { ConfirmDialog } from "../workspace/ConfirmDialog";
import { ChatAttachments } from "./chat-attachments";
import { ChatHistorySidebar } from "./chat-history-sidebar";

/**
 * Rotating "what the assistant is doing right now" captions shown while the
 * model is thinking. WorkBuddy-style: instead of a static spinner, the wait
 * is made legible (and a little playful) by cycling through the steps a reply
 * usually goes through. Picked by UI locale, falls back to zh.
 */
const THINKING_STEPS: Record<string, string[]> = {
  zh: [
    "正在理解你的问题…",
    "检索相关资料…",
    "梳理关键信息…",
    "组织回答思路…",
    "润色一下表述…",
  ],
  en: [
    "Understanding your question…",
    "Retrieving relevant material…",
    "Highlighting key points…",
    "Organizing the response…",
    "Polishing the wording…",
  ],
  ja: [
    "質問を理解しています…",
    "関連資料を検索中…",
    "重要なポイントを整理中…",
    "回答を構成中…",
    "表現を整えています…",
  ],
};

function ThinkingIndicator() {
  const { t, i18n } = useTranslation();
  const steps: string[] =
    THINKING_STEPS[i18n.language?.split("-")[0] ?? "zh"] ?? THINKING_STEPS.zh ?? [];
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    setStepIndex(0);
    const id = setInterval(() => {
      setStepIndex((prev) => (prev + 1) % steps.length);
    }, 1600);
    return () => clearInterval(id);
  }, [steps.length]);

  return (
    <div
      className="flex h-6 items-center gap-2 text-muted-foreground"
      aria-label={t("chat.thinking")}
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
      </span>
      <span key={stepIndex} className="text-[13px] animate-in fade-in duration-300">
        {steps[stepIndex]}
      </span>
    </div>
  );
}

export function ChatPage() {
  const [input, setInput] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();
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
  const streamingMessageId = isLoading ? messages[messages.length - 1]?.id : undefined;
  const suggestions = [
    t("chat.suggestion_summary"),
    t("chat.suggestion_actions"),
    t("chat.suggestion_notes"),
  ];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSend = (content = input) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || isLoading) return;
    sendMessage(trimmedContent);
    setInput("");
  };

  const handleNewChat = () => {
    clearMessages();
    setInput("");
    setCopiedMessageId(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleCopy = async (messageId: string, content: string) => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
    } catch {
      // Clipboard permission errors should not interrupt the conversation.
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header
        className="flex h-14 shrink-0 items-center border-b border-border/50 bg-background/80 px-4 backdrop-blur-xl select-none"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 pl-24">
          <span className="truncate text-[13px] font-semibold tracking-tight text-foreground">
            {t("chat.page_title")}
          </span>
          {isLoading && (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          )}
        </div>
        <div className="flex items-center gap-1" data-tauri-drag-region={false}>
          <Button
            variant="ghost"
            size="icon"
            className={`size-8 rounded-lg border transition-colors ${
              historyOpen
                ? "border-border bg-card text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground"
            }`}
            onClick={() => setHistoryOpen((open) => !open)}
            title={t("chat.history")}
            aria-label={t("chat.history")}
            aria-pressed={historyOpen}
          >
            <Clock className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg border border-transparent text-xs text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground"
            onClick={handleNewChat}
            title={t("chat.new_chat")}
          >
            <Plus className="size-3.5" />
            {t("chat.new_chat")}
          </Button>
        </div>
      </header>

      {historyOpen && (
        <aside className="absolute bottom-0 left-0 top-14 flex w-56 flex-col border-r border-border/60">
          <ChatHistorySidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            workingConversationIds={workingConversationIds}
            onSelect={selectConversation}
            onClose={() => setHistoryOpen(false)}
          />
        </aside>
      )}

      <main
        ref={scrollRef}
        className={`${historyOpen ? "ml-56" : "ml-0"} min-h-0 flex-1 overflow-y-auto transition-[margin] duration-150`}
      >
        {messages.length === 0 && !isLoading ? (
          <EmptyChat suggestions={suggestions} onSelect={handleSend} />
        ) : (
          <div className="lyse-chat-column mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm">
                    {message.content}
                  </div>
                </div>
              ) : (
                <article key={message.id} className="group flex items-start gap-3">
                  <AssistantAvatar size={36} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                      {t("chat.ai_assistant")}
                    </div>
                    <AssistantMessage
                      message={message}
                      isStreaming={message.id === streamingMessageId}
                      copied={copiedMessageId === message.id}
                      onCopy={() => handleCopy(message.id, message.content)}
                    />
                  </div>
                </article>
              ),
            )}
          </div>
        )}
      </main>

      <div
        className={`${historyOpen ? "ml-56" : "ml-0"} pointer-events-none shrink-0 bg-background/95 px-4 pb-4 pt-3 transition-[margin] duration-150 dark:bg-background/75 dark:backdrop-blur-xl`}
      >
        <div className="lyse-chat-column pointer-events-auto mx-auto max-w-3xl">
          <div className="rounded-xl border border-input bg-white p-2 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_14px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-neutral-400 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_3px_rgba(0,0,0,0.04)] dark:bg-card dark:shadow-[0_10px_35px_rgba(0,0,0,0.28)] dark:focus-within:border-white/20 dark:focus-within:shadow-[0_10px_35px_rgba(0,0,0,0.28),0_0_0_3px_rgba(255,255,255,0.05)]">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder={t("chat.page_placeholder")}
              className="max-h-40 min-h-12 resize-none border-0 bg-transparent px-2.5 py-2 text-[13px] text-foreground shadow-none placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
              disabled={isLoading}
              rows={1}
              autoFocus
            />
            <div className="flex items-center gap-1 px-0.5 pb-0.5 pt-1">
              <div className="flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-lg border-0 bg-transparent text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-white/[0.06]"
                  title={t("chat.context")}
                  aria-label={t("chat.context")}
                >
                  <Plus className="size-4" strokeWidth={1.8} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-lg border-0 bg-transparent text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-white/[0.06]"
                  title={t("chat.microphone")}
                  aria-label={t("chat.microphone")}
                >
                  <Mic className="size-4" strokeWidth={1.8} />
                </Button>
              </div>
              <span className="ml-1 min-w-0 flex-1 truncate text-[11px] text-muted-foreground/55 dark:text-muted-foreground/65">
                {isLoading ? t("chat.responding") : t("chat.input_hint")}
              </span>
              {isLoading ? (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-8 rounded-lg border-border bg-background text-foreground shadow-none transition-colors hover:bg-muted"
                  onClick={stopStreaming}
                  title={t("chat.stop")}
                  aria-label={t("chat.stop")}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  className="size-8 rounded-lg bg-foreground text-background shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-all hover:bg-foreground/85 hover:shadow-[0_2px_7px_rgba(0,0,0,0.12)] disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"
                  onClick={() => handleSend()}
                  disabled={!input.trim()}
                  title={t("chat.send")}
                  aria-label={t("chat.send")}
                >
                  <ArrowUp className="size-4" strokeWidth={2} />
                </Button>
              )}
            </div>
          </div>
          <p className="mt-2 text-center text-[10px] text-muted-foreground">
            {t("chat.disclaimer")}
          </p>
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
    </div>
  );
}

interface EmptyChatProps {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
}

function EmptyChat({ suggestions, onSelect }: EmptyChatProps) {
  const { t } = useTranslation();

  return (
    <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center overflow-hidden px-6 py-12 text-center">
      <AssistantAvatar size={148} className="relative mb-4" />
      <h1 className="relative text-xl font-semibold tracking-tight text-foreground">
        {t("chat.welcome_title")}
      </h1>
      <p className="relative mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {t("chat.page_description")}
      </p>
      <div className="relative mt-7 grid w-full max-w-xl gap-2 sm:grid-cols-3">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSelect(suggestion)}
            className="rounded-xl border border-border bg-card/80 px-3 py-3 text-left text-xs leading-5 text-foreground/80 shadow-sm transition-[border-color,background-color,color] hover:border-primary/25 hover:bg-accent/50 hover:text-foreground"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

interface AssistantMessageProps {
  message: ReturnType<typeof useChat>["messages"][number];
  isStreaming: boolean;
  copied: boolean;
  onCopy: () => void;
}

function AssistantMessage({ message, isStreaming, copied, onCopy }: AssistantMessageProps) {
  const { t } = useTranslation();

  return (
    <>
      {message.error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm leading-6 text-destructive">
          {message.content}
        </div>
      ) : message.content ? (
        <div className="rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3.5 text-sm leading-6 text-foreground shadow-sm">
          <StreamingMarkdown content={message.content} isStreaming={isStreaming} mode="minimal" />
        </div>
      ) : message.status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          <WaitingText status={message.status} />
        </div>
      ) : (
        <ThinkingIndicator />
      )}

      {message.content && message.status && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          <WaitingText status={message.status} />
        </div>
      )}

      {message.sources && message.sources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {message.sources.map((source, index) => (
            <span
              key={`${source}-${index}`}
              className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] text-accent-brand-text"
            >
              {source}
            </span>
          ))}
        </div>
      )}

      <ChatAttachments attachments={message.attachments} />

      {message.content && !message.error && (
        <div className="mt-2 flex items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={onCopy}
            title={copied ? t("chat.copied") : t("chat.copy")}
            aria-label={copied ? t("chat.copied") : t("chat.copy")}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </Button>
        </div>
      )}
    </>
  );
}
