"use client";

import { memo } from "react";
import { Loader2, X } from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import type { ChatConversation } from "../workspace/types";

interface ChatHistorySidebarProps {
  conversations: readonly Pick<ChatConversation, "id" | "title" | "updatedAt">[];
  activeConversationId: string | null;
  /** Conversations streaming a reply right now — shown with a working marker. */
  workingConversationIds?: readonly string[];
  onSelect: (conversationId: string) => void;
  onClose?: () => void;
}

/**
 * Conversation list used to switch between saved chats. Positioning is left to
 * the parent (absolute wrapper) so it works both as a full-height drawer in the
 * workspace chat panel and as a below-header drawer on the dedicated chat page.
 * Switching is always allowed — conversations stream independently, so opening
 * one never interrupts another.
 */
export const ChatHistorySidebar = memo(function ChatHistorySidebar({
  conversations,
  activeConversationId,
  workingConversationIds,
  onSelect,
  onClose,
}: ChatHistorySidebarProps) {
  const { t } = useTranslation();
  const sortedConversations = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="flex h-full w-full flex-col bg-muted/20">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-3 text-xs font-semibold text-muted-foreground">
        <span>{t("chat.history")}</span>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:bg-card hover:text-foreground"
            title={t("chat.close")}
            aria-label={t("chat.close")}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-2 pb-3 [scrollbar-gutter:stable]">
        {sortedConversations.length === 0 ? (
          <p className="px-2 py-4 text-xs leading-5 text-muted-foreground/70">
            {t("chat.history_empty")}
          </p>
        ) : (
          sortedConversations.map((conversation) => {
            const working = workingConversationIds?.includes(conversation.id);
            return (
              <button
                key={conversation.id}
                type="button"
                className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                  conversation.id === activeConversationId
                    ? "bg-card text-foreground shadow-sm ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-card/70 hover:text-foreground"
                }`}
                onClick={() => onSelect(conversation.id)}
                title={conversation.title}
                aria-current={conversation.id === activeConversationId ? "page" : undefined}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {working && (
                    <Loader2 className="size-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
                  )}
                  <span className="truncate text-xs font-medium">{conversation.title}</span>
                </span>
                <span
                  className={`mt-1 block text-2xs tabular-nums ${
                    working ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  {working
                    ? t("chat.working")
                    : new Date(conversation.updatedAt).toLocaleString(undefined, {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}, (previous, next) => {
  // Streaming changes message buffers without changing list metadata. A
  // retained, closed drawer should not sort and redraw on every token.
  return previous.activeConversationId === next.activeConversationId
    && previous.workingConversationIds === next.workingConversationIds
    && previous.onSelect === next.onSelect
    && previous.onClose === next.onClose
    && previous.conversations.length === next.conversations.length
    && previous.conversations.every((item, index) => {
      const other = next.conversations[index]!;
      return item.id === other.id && item.title === other.title && item.updatedAt === other.updatedAt;
    });
});
