"use client";

import { create } from "zustand";

export type NotificationType = "chat" | "transcription" | "sync" | "system";

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
}

const STORAGE_KEY = "lynse_notifications_v1";
const MAX_ITEMS = 50;

function loadItems(): NotificationItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NotificationItem[]) : [];
  } catch {
    return [];
  }
}

function saveItems(items: NotificationItem[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    // ignore quota / private-mode errors
  }
}

export const useNotificationStore = create<NotificationState>((set) => ({
  items: loadItems(),
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
}));

// Persist to localStorage whenever the list changes (client only).
if (typeof window !== "undefined") {
  useNotificationStore.subscribe((state) => saveItems(state.items));
}

/** Selector: total unread count (drives the Bell badge). */
export const selectUnreadCount = (s: NotificationState): number =>
  s.items.reduce((acc, i) => acc + (i.read ? 0 : 1), 0);
