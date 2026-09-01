"use client";

import * as React from "react";
import { Bell, MessageSquare, FileAudio, Cloud, Info } from "../icons";
import { AssistantAvatar } from "../assistant";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNotificationStore, type NotificationItem, type NotificationType } from "./use-notification-store";

const TYPE_ICON: Record<NotificationType, React.ComponentType<{ className?: string }>> = {
  chat: MessageSquare,
  transcription: FileAudio,
  sync: Cloud,
  system: Info,
};

export function NotificationList({
  onItemClick,
}: {
  /** Called after the item is marked read. Parent handles navigation / closing. */
  onItemClick?: (item: NotificationItem) => void;
}) {
  const { t } = useTranslation();
  const items = useNotificationStore((s) => s.items);
  const markRead = useNotificationStore((s) => s.markRead);

  const textFor = (item: NotificationItem): string => {
    switch (item.type) {
      case "chat":
        return item.title.trim()
          ? t("notifications.chat_unread", { name: item.title.trim(), count: item.count ?? 1 })
          : t("notifications.chat_unread_untitled", { count: item.count ?? 1 });
      case "transcription":
        // Titled rows are pipeline completions pushed by the workspace flows
        // (they carry the file name); untitled ones are the legacy
        // "uploaded, transcribing" events from live-recording sync.
        return item.title.trim()
          ? t("notifications.transcription_complete_named", { name: item.title.trim() })
          : t("notifications.transcription_done");
      case "sync":
        return t("notifications.sync_local");
      case "system":
        return item.id === "system:app-update"
          ? t("notifications.update_available", { version: item.title })
          : item.title;
      default:
        return item.title;
    }
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
          <Bell className="size-5 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium text-foreground">{t("notifications.title")}</h3>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">{t("notifications.empty_hint")}</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col">
      {items.map((item) => {
        const Icon = TYPE_ICON[item.type];
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => {
                markRead(item.id);
                onItemClick?.(item);
              }}
              className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
            >
              {item.type === "chat" ? (
                // AI-assistant rows carry the Lynse mascot itself, so they
                // read as "a reply from the assistant" at a glance instead of
                // a generic document-ish glyph.
                <AssistantAvatar size={28} interactive={false} className="mt-0.5" />
              ) : (
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={item.read ? "text-sm text-muted-foreground" : "text-sm font-medium text-foreground"}>
                    {textFor(item)}
                  </span>
                  {!item.read && <span className="size-1.5 shrink-0 rounded-full bg-red-500" aria-label="unread" />}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
