import type { Query, QueryCacheNotifyEvent, QueryClient } from "@tanstack/react-query";
import type { StorageAdapter } from "./types/storage";

/**
 * Disk persistence for the big list queries (notes / files / folders).
 *
 * The global QueryClient keeps list data in memory only, so every app start
 * re-downloads the user's whole list and paints a skeleton until it lands.
 * This module mirrors selected queries into storage and re-seeds them on
 * boot: the app paints the last known list immediately and the (freshness-
 * checked) background refetch replaces it moments later.
 *
 * Only the list families below are persisted — never tokens, presigned
 * URLs, per-file detail queries or transcription poll state.
 */

const STORAGE_KEY = "lynse.query-cache.v2";
/** v1 could persist non-array payloads when a query's data shape changed
 *  under a running app (HMR / upgrade); it is dropped on sight. */
const LEGACY_STORAGE_KEYS = ["lynse.query-cache.v1"];
/** Entries older than this are dropped on hydrate and never written. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 1500;
/** Cap rows per list. The persisted copy exists for instant paint; the
 *  authoritative full list always arrives via the background refetch, so a
 *  trimmed tail is invisible in practice and keeps us inside the ~5 MB
 *  storage quota even with tens of thousands of records. */
const MAX_ROWS_PER_LIST = 2000;
const MAX_QUERIES = 40;

interface PersistedQueryEntry {
  key: unknown[];
  data: unknown;
  dataUpdatedAt: number;
}

interface PersistedPayload {
  version: 1;
  savedAt: number;
  queries: PersistedQueryEntry[];
}

function isPersistableListKey(key: readonly unknown[]): boolean {
  const head = key[0];
  return head === "notes" || head === "files" || head === "folders";
}

/** Every persisted list family stores an array. Anything else in storage is
 *  a stale-shape leftover (a query's data model changed under a running app)
 *  and must never be seeded back into the cache — an object here crashed the
 *  home feed with "is not iterable" on every launch. */
function isListPayload(data: unknown): data is unknown[] {
  return Array.isArray(data);
}

/** Keep the newest rows when a list has to be trimmed. Rows are plain
 *  records; anything without a recognizable timestamp keeps its position. */
function trimRows(data: unknown, maxRows: number): unknown {
  if (!Array.isArray(data) || data.length <= maxRows) return data;
  const rowTime = (row: unknown): string => {
    if (typeof row !== "object" || row === null) return "";
    const record = row as Record<string, unknown>;
    return String(record.updatedAt ?? record.updateTime ?? record.createdAt ?? record.createTime ?? "");
  };
  return [...data].sort((a, b) => rowTime(b).localeCompare(rowTime(a))).slice(0, maxRows);
}

function collectEntries(client: QueryClient): PersistedQueryEntry[] {
  return client
    .getQueryCache()
    .getAll()
    .filter(
      (query: Query) =>
        isPersistableListKey(query.queryKey) &&
        isListPayload(query.state.data) &&
        !query.state.isInvalidated,
    )
    .slice(0, MAX_QUERIES)
    .map((query) => ({
      key: [...query.queryKey],
      data: trimRows(query.state.data, MAX_ROWS_PER_LIST),
      dataUpdatedAt: query.state.dataUpdatedAt,
    }));
}

function writeCache(client: QueryClient, storage: StorageAdapter, maxRows: number): boolean {
  const payload: PersistedPayload = {
    version: 1,
    savedAt: Date.now(),
    queries: collectEntries(client).map((entry) => ({
      ...entry,
      data: trimRows(entry.data, maxRows),
    })),
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Mirror whitelisted list queries into storage (debounced). Attached once
 *  by `QueryProvider`; every failure is swallowed — persistence must never
 *  disturb the UI. */
export function attachListQueryPersistence(
  client: QueryClient,
  storage: StorageAdapter,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    // First attempt at full size; on quota pressure retry once with half
    // the rows, then give up silently.
    if (!writeCache(client, storage, MAX_ROWS_PER_LIST)) {
      writeCache(client, storage, Math.floor(MAX_ROWS_PER_LIST / 2));
    }
  };
  const cache = client.getQueryCache();
  const unsubscribe = cache.subscribe((event: QueryCacheNotifyEvent) => {
    if (event.type !== "updated") return;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, WRITE_DEBOUNCE_MS);
  });
  // The debounce can outlive a quick "open, glance, quit" session; flush
  // synchronously when the page goes away so the next start still hits.
  const flushOnHide = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushOnHide);
  }
  return () => {
    flushOnHide();
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", flushOnHide);
    }
    unsubscribe();
  };
}

/** Drop the persisted mirror entirely — used on logout so the next sign-in
 *  (possibly a different account on the same machine) never paints the
 *  previous user's lists from disk. */
export function clearListQueryCache(storage: StorageAdapter): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Seed the cache with the persisted lists from the previous session. Runs
 *  synchronously during provider init so the very first paint already has
 *  data. Restored entries keep their original `dataUpdatedAt`, so they count
 *  as stale and are revalidated by the usual staleTime rules. */
export function hydrateListQueryCache(client: QueryClient, storage: StorageAdapter): void {
  // Drop superseded / possibly poisoned payloads from older storage keys.
  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    try {
      storage.removeItem(legacyKey);
    } catch {
      /* ignore */
    }
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let payload: PersistedPayload;
  try {
    payload = JSON.parse(raw) as PersistedPayload;
  } catch {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.queries)) return;
  if (Date.now() - payload.savedAt > MAX_AGE_MS) return;

  const now = Date.now();
  for (const entry of payload.queries) {
    if (!Array.isArray(entry.key) || !isPersistableListKey(entry.key)) continue;
    if (typeof entry.dataUpdatedAt !== "number" || now - entry.dataUpdatedAt > MAX_AGE_MS) continue;
    if (!isListPayload(entry.data)) continue;
    client.setQueryData(entry.key, entry.data, { updatedAt: entry.dataUpdatedAt });
  }
}
