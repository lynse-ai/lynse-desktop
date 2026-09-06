"use client";

import { useSyncExternalStore } from "react";

/**
 * Client-side "has the user opened this note since its transcription finished?"
 * store backing the unread dot in the notes list.
 *
 * Seen state maps fileId → the item's `updatedAt` at the moment it was opened,
 * so an item re-dots when the pipeline produces newer content (updatedAt bumps).
 * Everything already completed when the feature first ran counts as read via a
 * one-time seed timestamp — only transcriptions finishing after that dot.
 */

const SEEN_KEY = "lynse_notes_seen_v1";
const SEED_KEY = "lynse_notes_seen_seed_v1";
const SEEN_LIMIT = 1000;

type SeenMap = Record<string, string>;

let seen: SeenMap = loadSeen();
let seedMs: number | null = null;
const listeners = new Set<() => void>();

function loadSeen(): SeenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SeenMap)
      : {};
  } catch {
    return {};
  }
}

function persist() {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Best-effort (quota / private mode): the dot just resets on next launch.
  }
}

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Install timestamp of this feature. Computed lazily on first use; everything
 * whose transcription completed before it is treated as already read, so the
 * first launch never dots the whole back catalog.
 */
export function seenSeedTime(): number {
  if (seedMs !== null) return seedMs;
  if (typeof window === "undefined") return Number.MAX_SAFE_INTEGER;
  try {
    const raw = localStorage.getItem(SEED_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(parsed)) {
      seedMs = parsed;
    } else {
      seedMs = Date.now();
      localStorage.setItem(SEED_KEY, String(seedMs));
    }
  } catch {
    seedMs = Date.now();
  }
  return seedMs;
}

/** Record that the user opened `fileId` while its content version was `versionMarker`. */
export function markNoteSeen(fileId: string, versionMarker: string) {
  if (!fileId || seen[fileId] === versionMarker) return;
  seen = { ...seen, [fileId]: versionMarker };
  // Keep the map bounded: drop the oldest entries past the cap.
  const ids = Object.keys(seen);
  for (const id of ids.slice(0, Math.max(0, ids.length - SEEN_LIMIT))) {
    delete seen[id];
  }
  persist();
  emit();
}

/**
 * True when the note's transcription is complete but the user has not opened it
 * since — either never opened, or the content was regenerated after the last open.
 */
export function isNoteUnread(
  file: { id: string; updatedAt: string },
  completed: boolean,
  currentSeen: SeenMap,
): boolean {
  if (!completed) return false;
  if (currentSeen[file.id] === file.updatedAt) return false;
  const updatedMs = new Date(file.updatedAt).getTime();
  // Pre-seed history stays read; unparseable dates fall through to the marker check.
  if (Number.isFinite(updatedMs) && updatedMs < seenSeedTime()) return false;
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SeenMap {
  return seen;
}

/** React binding: re-renders the caller whenever any note is marked seen. */
export function useSeenMap(): SeenMap {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
