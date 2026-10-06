"use client";

import * as React from "react";
import { Bell, Bot, FileAudio, Cloud, Info } from "../icons";
import { AssistantAvatar } from "../assistant";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNotificationStore, type NotificationItem, type NotificationType } from "./use-notification-store";
import { actOnContextNotification } from "./context-inbox";

const TYPE_ICON: Record<NotificationType, React.ComponentType<{ className?: string }>> = {
  chat: Bot,
  transcription: FileAudio,
  sync: Cloud,
  system: Info,
  context: Bot,
};

export function NotificationList({
  onItemClick,
}: {
  /** Called after the item is marked read. Parent handles navigation / closing. */
  onItemClick?: (item: NotificationItem) => void;
}) {
  const { t } = useTranslation();
  const allItems = useNotificationStore((s) => s.items);
  const contextUserId = useNotificationStore((s) => s.contextUserId);
  const items = allItems.filter((item) => item.type !== "context" || item.context?.userId === contextUserId);
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
      {items.map((item) => (
        <NotificationRow key={item.id} item={item} text={textFor(item)} onClick={() => {
          markRead(item.id);
          onItemClick?.(item);
        }} />
      ))}
    </ul>
  );
}

function NotificationRow({ item, text, onClick }: { item: NotificationItem; text: string; onClick: () => void }) {
  const { t } = useTranslation();
  const row = React.useRef<HTMLLIElement>(null);
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const Icon = TYPE_ICON[item.type];

  React.useEffect(() => {
    const element = row.current;
    if (!element || !item.context?.canDisplay || item.context.item.displayed_at) return;
    const acknowledge = () => {
      if (document.visibilityState !== "visible") return;
      void actOnContextNotification(item, "displayed").catch(() => undefined);
    };
    // Fetching or adding a badge is not delivery. Only a visible, rendered row is.
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) acknowledge();
      });
      observer.observe(element);
      return () => observer.disconnect();
    }
    const frame = requestAnimationFrame(() => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0 && bounds.top < window.innerHeight && bounds.bottom > 0) acknowledge();
    });
    return () => cancelAnimationFrame(frame);
  }, [item]);

  const action = (kind: "dismiss" | "snooze") => {
    setPending(true);
    setFailed(false);
    void actOnContextNotification(item, kind)
      .catch(() => setFailed(true))
      .finally(() => setPending(false));
  };

  return (
    <li ref={row}>
      <button type="button" onClick={onClick} className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent">
        {item.type === "chat" || item.type === "context" ? (
          <AssistantAvatar size={28} interactive={false} className="mt-0.5" />
        ) : (
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="size-4" /></span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={item.read ? "text-sm text-muted-foreground" : "text-sm font-medium text-foreground"}>{text}</span>
            {!item.read && <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-label="unread" />}
          </span>
          {item.context && <span className="mt-1 block text-xs text-muted-foreground">{item.context.item.body}</span>}
          <span className="mt-0.5 block text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
        </span>
      </button>
      {item.context && (
        <div className="mb-2 ml-12 flex items-center gap-3 text-xs text-muted-foreground">
          <button type="button" disabled={pending} onClick={() => action("dismiss")} className="hover:text-foreground disabled:opacity-50">{t("notifications.context_dismiss")}</button>
          <button type="button" disabled={pending} onClick={() => action("snooze")} className="hover:text-foreground disabled:opacity-50">{t("notifications.context_snooze")}</button>
          {failed && <span role="alert">{t("notifications.context_unavailable")}</span>}
        </div>
      )}
    </li>
  );
}
