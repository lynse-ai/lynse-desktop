"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { NotificationList } from "./notification-list";

export function NotificationsPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">{t("notifications.title")}</h2>
      </header>
      <div className="flex-1 overflow-y-auto">
        <NotificationList onItemClick={(item) => item.href && push(item.href)} />
      </div>
    </div>
  );
}
