"use client";

import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { type TodoItem } from "./todo-api";
import {
  collectDueTodos,
  pickUnnotified,
  readNotifiedMap,
  updateNotified,
  writeNotifiedMap,
} from "./due-logic";
import { formatDueDisplay } from "./grouping";
import { useTodoStore } from "./use-todos";
import { useNavigation } from "../navigation";

/**
 * App-wide due-reminder watcher. Mounted once in the dashboard layout next
 * to the meeting-reminder banner: polls the shared todo store every 30s
 * (plus on focus) and announces open todos that passed their due instant —
 * once per (todo, due instant) via the due-logic ledger, catch-up included
 * after a launch, so a deadline that passed while the app was closed still
 * announces.
 *
 * The unified surface is the OS notification center (desktop bridge):
 * in-app popups overflow the window when several long titles land at once.
 * The in-app sonner toast — with a jump action — survives only as the
 * fallback on the web and while OS permission is missing (the first
 * firing reminder raises the prompt once; a denial keeps the fallback).
 * The whole system is opt-out via the bell toggle on the todo page, whose
 * enable path is also where the OS prompt is requested.
 */

export const REMINDER_ENABLED_KEY = "lynse.todos.reminderEnabled";
const POLL_MS = 30_000;

/** Bell toggle state; reminders default on. */
export function todoRemindersEnabled(): boolean {
  try {
    return localStorage.getItem(REMINDER_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setTodoRemindersEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(REMINDER_ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Desktop notification surface exposed by the tauri bridge; null on web. */
type NotificationsApi = {
  status?: () => Promise<"granted" | "not-granted">;
  request?: () => Promise<"granted" | "denied" | "default">;
  send?: (title: string, body?: string) => Promise<void>;
};

export function todoNotificationsApi(): NotificationsApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { desktopAPI?: { notifications?: NotificationsApi } })
    .desktopAPI?.notifications;
  return api ?? null;
}

/** Request OS notification permission (called when the bell is turned on).
 *  Returns whether it ended up granted; null when there is no OS surface. */
export async function requestTodoNotificationPermission(): Promise<boolean | null> {
  const api = todoNotificationsApi();
  if (!api?.request) return null;
  try {
    return (await api.request()) === "granted";
  } catch {
    return false;
  }
}

export function TodoDueRemindersWatcher() {
  const { t } = useTranslation();
  const navigate = useNavigation();

  const announce = useCallback(
    (todos: TodoItem[]) => {
      if (!todoRemindersEnabled() || todos.length === 0) return;
      const now = new Date();
      const candidates = collectDueTodos(todos, now);
      if (candidates.length === 0) return;
      const notified = readNotifiedMap();
      const due = pickUnnotified(candidates, notified);
      if (due.length === 0) return;
      writeNotifiedMap(updateNotified(due, todos, notified));

      // The unified surface is the OS notification center; the in-app toast
      // (with its jump action) only covers the web and an ungranted desktop
      // permission, where a several-titles batch would overflow the window.
      const jump = () => navigate.push("/todo");
      const toastFallback = (title: string, description?: string) =>
        toast(title, { description, duration: 8000, action: { label: t("todo.due_open_page"), onClick: jump } });

      if (due.length === 1) {
        const first = due[0];
        if (!first) return;
        const { todo } = first;
        const time = formatDueDisplay(todo);
        const timeText = time ? t("todo.due_toast_body", { time }) : undefined;
        void notifyDue(
          t("todo.due_notification_title"),
          timeText ? `${todo.title} · ${timeText}` : todo.title,
          () => toastFallback(todo.title, timeText),
        );
      } else {
        const titles = due.map(({ todo }) => todo.title);
        // Keep the OS notification body readable — list the first few only.
        const body = titles.slice(0, 5).join("、") + (titles.length > 5 ? "…" : "");
        void notifyDue(t("todo.due_batch_title", { n: due.length }), body, () =>
          toastFallback(t("todo.due_batch_title", { n: due.length }), titles.join("、")),
        );
      }
    },
    [t, navigate],
  );

  useEffect(() => {
    void useTodoStore.getState().load({ initial: true });
    const tick = () => announce(useTodoStore.getState().todos);
    tick();
    const timer = setInterval(tick, POLL_MS);
    const onFocus = () => tick();
    window.addEventListener("focus", onFocus);
    window.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("visibilitychange", onFocus);
    };
  }, [announce]);

  return null;
}

/** Send a due reminder through the OS notification center when the desktop
 *  permission is granted; otherwise run the in-app toast fallback. When the
 *  OS surface exists but was never asked, raise the prompt once so future
 *  reminders land in the notification center (a denial just keeps the
 *  fallback — the request itself is a silent no-op then). */
async function notifyDue(title: string, body: string, fallback: () => void): Promise<void> {
  const api = todoNotificationsApi();
  if (!api) {
    fallback();
    return;
  }
  let granted = false;
  try {
    granted = (await api.status?.()) === "granted";
    const request = api.request;
    if (!granted && request) request().catch(() => {
      /* prompt failed — keep the toast fallback */
    });
  } catch {
    /* treat as ungranted */
  }
  if (!granted) {
    fallback();
    return;
  }
  try {
    await api.send?.(title, body);
  } catch {
    fallback();
  }
}
