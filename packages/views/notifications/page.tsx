"use client";

import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { openAppUpdateDialog } from "../app-update";
import { NotificationList } from "./notification-list";
import { openContextNotification } from "./context-inbox";

export function NotificationsPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex items-center justify-between border-b border-border/50 px-6 py-3 select-none"
        data-tauri-drag-region
      >
        <h2 className="text-sm font-medium text-foreground">{t("notifications.title")}</h2>
      </header>
      <div className="flex-1 overflow-y-auto px-4">
        <NotificationList
          onItemClick={(item) => {
            if (item.type === "context") {
              void openContextNotification(item, push).catch(() => toast.error(t("notifications.context_unavailable")));
              return;
            }
            // The app-update row opens the in-app update dialog rather than
            // navigating to the release page.
            if (item.id === "system:app-update") {
              openAppUpdateDialog();
              return;
            }
            if (item.href) push(item.href);
          }}
        />
      </div>
    </div>
  );
}
