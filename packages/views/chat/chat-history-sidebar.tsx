"use client";

import { Loader2, X } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import type { ChatConversation } from "../workspace/types";

interface ChatHistorySidebarProps {
  conversations: ChatConversation[];
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
export function ChatHistorySidebar({
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
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            title={t("chat.close")}
            aria-label={t("chat.close")}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
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
                className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                  conversation.id === activeConversationId
                    ? "bg-card text-foreground shadow-sm ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-card/70 hover:text-foreground"
                }`}
                onClick={() => onSelect(conversation.id)}
                aria-current={conversation.id === activeConversationId ? "page" : undefined}
              >
                <span className="flex items-center gap-1.5">
                  {working && (
                    <Loader2 className="size-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
                  )}
                  <span className="truncate text-xs font-medium">{conversation.title}</span>
                </span>
                <span
                  className={`mt-1 block text-[10px] ${
                    working ? "text-primary/80" : "text-muted-foreground/70"
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
}
