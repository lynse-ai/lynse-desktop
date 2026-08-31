"use client";

import { useEffect } from "react";
import { useAppUpdate } from "../app-update";
import { useNotificationStore } from "./use-notification-store";

const APP_UPDATE_ID = "system:app-update";

/**
 * Mirrors the desktop "a new version is available" signal into the unified
 * notification center, so it shows up in the Bell drawer (not only the avatar
 * upgrade arrow). Mount once near the app root — it returns null.
 *
 * Read state is preserved across re-polls: once the user marks it read (or
 * clicks it), a later background check won't re-badge it until the update is
 * gone (hasUpdate flips to false).
 */
export function AppUpdateNotifier() {
  const { update } = useAppUpdate();

  useEffect(() => {
    const store = useNotificationStore.getState();
    if (update?.hasUpdate) {
      const existing = store.items.find((i) => i.id === APP_UPDATE_ID);
      store.upsert({
        id: APP_UPDATE_ID,
        type: "system",
        title: update.latestVersion ?? "",
        href: update.releaseUrl ?? "",
        external: true,
        createdAt: existing?.createdAt ?? Date.now(),
        read: existing?.read ?? false,
      });
    } else {
      store.remove(APP_UPDATE_ID);
    }
  }, [update]);

  return null;
}
