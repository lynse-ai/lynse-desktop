import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  attachListQueryPersistence,
  clearListQueryCache,
  hydrateListQueryCache,
} from "./query-persistence";
import type { StorageAdapter } from "./types/storage";

function memoryStorage(): StorageAdapter & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

const NOW = Date.now();

function payloadOf(entries: unknown[], savedAt: number = NOW): string {
  return JSON.stringify({ version: 1, savedAt, queries: entries });
}

describe("hydrateListQueryCache", () => {
  it("seeds valid array entries and preserves dataUpdatedAt", () => {
    const storage = memoryStorage();
    storage.setItem(
      "lynse.query-cache.v2",
      payloadOf([
        { key: ["notes", "a", "b", true], data: [{ id: "n1" }], dataUpdatedAt: NOW - 1000 },
      ]),
    );
    const client = new QueryClient();
    hydrateListQueryCache(client, storage);
    const state = client.getQueryState(["notes", "a", "b", true]);
    expect(state?.data).toEqual([{ id: "n1" }]);
    expect(state?.dataUpdatedAt).toBe(NOW - 1000);
  });

  it("drops stale-shape (non-array) entries instead of seeding them", () => {
    // Regression: a v1 payload captured while a query still returned the
    // {cloudItems, localRecords} wrapper must never reach the cache — the
    // home feed iterated it and crashed every launch.
    const storage = memoryStorage();
    storage.setItem(
      "lynse.query-cache.v2",
      payloadOf([
        {
          key: ["notes", "a", "b", true],
          data: { cloudItems: [], localRecords: [] },
          dataUpdatedAt: NOW - 1000,
        },
      ]),
    );
    const client = new QueryClient();
    hydrateListQueryCache(client, storage);
    expect(client.getQueryState(["notes", "a", "b", true])?.data).toBeUndefined();
  });

  it("removes the legacy v1 payload on hydrate", () => {
    const storage = memoryStorage();
    storage.setItem("lynse.query-cache.v1", payloadOf([]));
    hydrateListQueryCache(new QueryClient(), storage);
    expect(storage.getItem("lynse.query-cache.v1")).toBeNull();
  });

  it("ignores payloads older than the retention window", () => {
    const storage = memoryStorage();
    storage.setItem(
      "lynse.query-cache.v2",
      payloadOf(
        [{ key: ["notes", "a", "b", true], data: [{ id: "n1" }], dataUpdatedAt: NOW - 1000 }],
        NOW - 8 * 24 * 60 * 60 * 1000,
      ),
    );
    const client = new QueryClient();
    hydrateListQueryCache(client, storage);
    expect(client.getQueryState(["notes", "a", "b", true])?.data).toBeUndefined();
  });
});

describe("attachListQueryPersistence", () => {
  it("persists only whitelisted, array-shaped list queries", () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    const detach = attachListQueryPersistence(client, storage);

    client.setQueryData(["notes", "a", "b", true], [{ id: "n1" }]);
    client.setQueryData(["folders"], [{ id: "f1" }]);
    client.setQueryData(["user", "credits"], { balance: 1 });
    client.setQueryData(["files", { pageNum: 1 }, true], { cloudItems: [] });
    // Flushing synchronously via the detach cleanup keeps the test off the
    // debounced write path.
    detach();

    const written = JSON.parse(storage.dump()["lynse.query-cache.v2"] ?? "{}");
    const persistedKeys = (written.queries ?? []).map((entry: { key: unknown[] }) => entry.key[0]);
    expect(persistedKeys).toContain("notes");
    expect(persistedKeys).toContain("folders");
    expect(persistedKeys).not.toContain("user");
    // The files entry is a non-array stale shape — never written.
    expect(persistedKeys).not.toContain("files");
  });

  it("clearListQueryCache removes the mirror (logout path)", () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    const detach = attachListQueryPersistence(client, storage);
    client.setQueryData(["notes", "a", "b", true], [{ id: "n1" }]);
    detach();
    expect(storage.getItem("lynse.query-cache.v2")).not.toBeNull();
    clearListQueryCache(storage);
    expect(storage.getItem("lynse.query-cache.v2")).toBeNull();
  });
});
