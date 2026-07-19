"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  Copy,
  FileText,
  Plus,
  Sparkles,
  Square,
} from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { StreamingMarkdown } from "@lynse/ui/markdown";
import { useTranslation } from "@lynse/core/i18n/react";
import { useChat } from "../workspace/hooks/use-chat";

export function ChatPage() {
  const [input, setInput] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();
  const { messages, isLoading, sendMessage, clearMessages, stopStreaming } = useChat();
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
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <header
        className="flex h-10 shrink-0 items-center border-b border-border/60 bg-background/80 px-3 backdrop-blur-md select-none"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 pl-24">
          <span className="truncate text-xs font-medium text-foreground/80">
            {t("chat.page_title")}
          </span>
          {isLoading && (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground"
          onClick={handleNewChat}
          title={t("chat.new_chat")}
          data-tauri-drag-region={false}
        >
          <Plus className="size-3.5" />
          {t("chat.new_chat")}
        </Button>
      </header>

      <main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && !isLoading ? (
          <EmptyChat suggestions={suggestions} onSelect={handleSend} />
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-8">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-6 text-foreground">
                    {message.content}
                  </div>
                </div>
              ) : (
                <article key={message.id} className="group grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                  <div className="flex size-7 items-center justify-center rounded-lg border border-border/70 bg-background shadow-xs">
                    <Bot className="size-3.5 text-foreground/70" />
                  </div>
                  <div className="min-w-0 pt-0.5">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
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

      <div className="pointer-events-none shrink-0 bg-gradient-to-t from-background via-background to-transparent px-4 pb-4 pt-6">
        <div className="pointer-events-auto mx-auto max-w-3xl">
          <div className="rounded-2xl border border-border/80 bg-background p-2 shadow-[0_8px_30px_rgba(0,0,0,0.08)] transition-shadow focus-within:border-ring/50 focus-within:shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.28)]">
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
              className="max-h-40 min-h-12 resize-none border-0 bg-transparent px-2.5 py-2 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
              disabled={isLoading}
              rows={1}
              autoFocus
            />
            <div className="flex items-center justify-between gap-3 px-1 pt-1">
              <span className="truncate text-[11px] text-muted-foreground/70">
                {isLoading ? t("chat.responding") : t("chat.input_hint")}
              </span>
              {isLoading ? (
                <Button
                  size="icon"
                  variant="outline"
                  className="size-8 rounded-full"
                  onClick={stopStreaming}
                  title={t("chat.stop")}
                  aria-label={t("chat.stop")}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className="size-8 rounded-full"
                  onClick={() => handleSend()}
                  disabled={!input.trim()}
                  title={t("chat.send")}
                  aria-label={t("chat.send")}
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
          <p className="mt-2 text-center text-[10px] text-muted-foreground/60">
            {t("chat.disclaimer")}
          </p>
        </div>
      </div>
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
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-border/70 bg-gradient-to-b from-muted/40 to-muted shadow-sm">
        <Sparkles className="size-5 text-foreground/70" />
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {t("chat.welcome_title")}
      </h1>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {t("chat.page_description")}
      </p>
      <div className="mt-7 grid w-full max-w-xl gap-2 sm:grid-cols-3">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSelect(suggestion)}
            className="rounded-xl border border-border/70 bg-background px-3 py-3 text-left text-xs leading-5 text-foreground/80 transition-colors hover:border-border hover:bg-muted/60"
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
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm leading-6 text-destructive">
          {message.content}
        </div>
      ) : message.content ? (
        <div className="text-sm leading-6 text-foreground">
          <StreamingMarkdown content={message.content} isStreaming={isStreaming} mode="minimal" />
        </div>
      ) : message.status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          {message.status}
        </div>
      ) : (
        <div className="flex h-6 items-center gap-1.5 text-muted-foreground" aria-label={t("chat.responding")}>
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
        </div>
      )}

      {message.sources && message.sources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {message.sources.map((source, index) => (
            <span
              key={`${source}-${index}`}
              className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {source}
            </span>
          ))}
        </div>
      )}

      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {message.attachments.map((attachment, index) => {
            const href = attachment.downloadUrl || attachment.url || attachment.thumbnailUrl;
            if (!href) return null;
            return (
              <a
                key={attachment.id || `${href}-${index}`}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-2 rounded-xl border border-border/70 bg-background px-3 py-2 text-xs text-foreground transition-colors hover:bg-muted/50"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{attachment.name || href}</span>
              </a>
            );
          })}
        </div>
      )}

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
