"use client";

import { create } from "zustand";
import type { ContextInboxItem } from "@lynse/core/api";

export type NotificationType = "chat" | "transcription" | "sync" | "system" | "context";

export interface NotificationItem {
  /** Unique id. Chat notifications use `chat:<conversationId>` so they upsert. */
  id: string;
  type: NotificationType;
  /** Chat: conversation title. System: free text. Other types: ignored (UI localizes by type). */
  title: string;
  /** Chat only: number of unread replies in that conversation. */
  count?: number;
  /** Deep link opened when the item is clicked (e.g. `/chat`, `/notes`). */
  href?: string;
  /** When true, `href` is an external URL opened in the system browser instead of an internal route. */
  external?: boolean;
  createdAt: number;
  read: boolean;
  /** Volatile mirror only; the authenticated cloud inbox remains authoritative. */
  context?: { userId: string; item: ContextInboxItem; canDisplay: boolean };
}

interface NotificationState {
  items: NotificationItem[];
  /** Prepend a new notification (dedupes by id). */
  add: (item: Omit<NotificationItem, "createdAt" | "read"> & Partial<Pick<NotificationItem, "createdAt" | "read">>) => void;
  /** Insert or replace a notification by id (used for chat upserts). */
  upsert: (item: NotificationItem) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
  contextUserId: string | null;
  setContextUser: (userId: string | null) => void;
  mirrorContext: (userId: string, items: ContextInboxItem[], canDisplay: boolean) => void;
  /** True while the authenticated inbox sync keeps failing; drives the page hint. */
  contextUnavailable: boolean;
  setContextUnavailable: (unavailable: boolean) => void;
}

const STORAGE_KEY = "lynse_notifications_v1";
const MAX_ITEMS = 50;

function loadItems(): NotificationItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NotificationItem[]).filter((item) => item.type !== "context") : [];
  } catch {
    return [];
  }
}

function saveItems(items: NotificationItem[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.filter((item) => item.type !== "context").slice(0, MAX_ITEMS)));
  } catch {
    // ignore quota / private-mode errors
  }
}

/** An item is eligible while its snooze deadline is missing, stale, or unparseable. */
function isNotSnoozed(deadline: string | null): boolean {
  const timestamp = deadline ? Date.parse(deadline) : NaN;
  return !(Number.isFinite(timestamp) && timestamp > Date.now());
}

export const useNotificationStore = create<NotificationState>((set) => ({
  items: loadItems(),
  contextUserId: null,
  contextUnavailable: false,
  add: (item) =>
    set((s) => {
      const next: NotificationItem = { read: false, createdAt: Date.now(), ...item };
      const items = [next, ...s.items.filter((i) => i.id !== next.id)].slice(0, MAX_ITEMS);
      return { items };
    }),
  upsert: (item) =>
    set((s) => {
      const exists = s.items.some((i) => i.id === item.id);
      const items = exists
        ? s.items.map((i) => (i.id === item.id ? { ...i, ...item } : i))
        : [item, ...s.items];
      return { items: items.slice(0, MAX_ITEMS) };
    }),
  markRead: (id) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, read: true } : i)) })),
  markAllRead: () => set((s) => ({ items: s.items.map((i) => ({ ...i, read: true })) })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [] }),
  setContextUser: (userId) => set((s) => ({
    contextUserId: userId,
    items: s.contextUserId === userId ? s.items : s.items.filter((item) => item.type !== "context"),
  })),
  mirrorContext: (userId, records, canDisplay) => set((s) => {
    if (s.contextUserId !== userId) return s;
    const eligible = records.filter((item) => item.status === "pending" && isNotSnoozed(item.snoozed_until));
    const previousSelection = s.items.find((item) => item.context?.userId === userId && !item.context.item.displayed_at)?.context?.item.item_id;
    const selected = canDisplay ? eligible.find((item) => item.item_id === previousSelection && !item.displayed_at)
      ?? eligible.find((item) => !item.displayed_at) : undefined;
    const mirrors: NotificationItem[] = eligible
      .filter((item) => !!item.displayed_at || item === selected)
      .map((item) => ({
        id: `context:${item.item_id}`,
        type: "context",
        title: item.title,
        createdAt: Date.parse(item.created_at) || Date.now(),
        read: !!item.displayed_at || !!s.items.find((existing) => existing.id === `context:${item.item_id}`)?.read,
        context: { userId, item, canDisplay },
      }));
    return { items: [...mirrors, ...s.items.filter((item) => item.type !== "context")].slice(0, MAX_ITEMS) };
  }),
  setContextUnavailable: (unavailable) => set({ contextUnavailable: unavailable }),
}));

// Persist to localStorage whenever the list changes (client only).
if (typeof window !== "undefined") {
  useNotificationStore.subscribe((state) => saveItems(state.items));
}

/** Selector: total unread count (drives the Bell badge). */
export const selectUnreadCount = (s: NotificationState): number =>
  s.items.reduce((acc, i) => acc + (i.read ? 0 : 1), 0);

/**
 * Selector factory: unread count for the given notification types. Drives the
 * per-module dot badges in the sidebar (the Bell entry was retired; each
 * module's icon now carries its own unread marker).
 */
export const selectUnreadByTypes =
  (types: NotificationType[]) =>
  (s: NotificationState): number =>
    s.items.reduce(
      (acc, i) => (i.read || !types.includes(i.type) ? acc : acc + 1),
      0,
    );

/**
 * Marks every unread notification of the given types as read. Called when a
 * module is visited so its sidebar dot clears after the user has seen the
 * module (e.g. landing on Notes clears transcription/sync dots).
 */
export const markTypesRead = (types: NotificationType[]) => {
  useNotificationStore.setState((s) => ({
    items: s.items.map((i) =>
      i.read || !types.includes(i.type) ? i : { ...i, read: true },
    ),
  }));
};
