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
 * In-app: sonner toasts with a jump action. Desktop additionally fires a
 * system notification through the bridge when OS permission is granted.
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

      const jump = () => navigate.push("/todo");
      if (due.length === 1) {
        const first = due[0];
        if (!first) return;
        const { todo } = first;
        const time = formatDueDisplay(todo);
        const description = time ? t("todo.due_toast_body", { time }) : undefined;
        toast(todo.title, { description, duration: 8000, action: { label: t("todo.due_open_page"), onClick: jump } });
        notifySystem(t("todo.due_notification_title"), todo.title);
      } else {
        const titles = due.map(({ todo }) => todo.title).join("、");
        toast(t("todo.due_batch_title", { n: due.length }), {
          description: titles,
          duration: 8000,
          action: { label: t("todo.due_open_page"), onClick: jump },
        });
        notifySystem(t("todo.due_batch_title", { n: due.length }), titles);
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

function notifySystem(title: string, body: string): void {
  const api = todoNotificationsApi();
  api?.send?.(title, body).catch(() => {
    /* OS surface unavailable — the in-app toast already fired */
  });
}
