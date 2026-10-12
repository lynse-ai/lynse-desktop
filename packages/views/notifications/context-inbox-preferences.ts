"use client";

import { useSyncExternalStore } from "react";

export const CONTEXT_INBOX_STORAGE_PREFIX = "lynse_context_inbox_enabled_v1:";
const listeners = new Set<() => void>();

function storageKey(userId: string) {
  return `${CONTEXT_INBOX_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

/** Receiving suggestions is opt-in on this device, independently per account. */
export function getContextInboxEnabled(userId: string | null): boolean {
  if (!userId || typeof window === "undefined") return false;
  try { return window.localStorage.getItem(storageKey(userId)) === "1"; }
  catch { return false; }
}

export function setContextInboxEnabled(userId: string, enabled: boolean): void {
  if (!userId || typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(userId), enabled ? "1" : "0");
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(CONTEXT_INBOX_STORAGE_PREFIX)) listener();
  };
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}

export function useContextInboxEnabled(userId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => getContextInboxEnabled(userId), () => false);
}
