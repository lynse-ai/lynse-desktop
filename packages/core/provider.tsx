"use client";

import { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient, getActiveQueryClient, setActiveQueryClient } from "./query-client";
import {
  attachListQueryPersistence,
  clearListQueryCache,
  hydrateListQueryCache,
} from "./query-persistence";
import { defaultStorage } from "./platform/storage";
import type { ReactNode } from "react";
import type { StorageAdapter } from "./types/storage";

export function QueryProvider({
  children,
  storage = defaultStorage,
}: {
  children: ReactNode;
  storage?: StorageAdapter;
}) {
  const [queryClient] = useState(() => {
    const client = createQueryClient();
    try {
      if (storage.getItem("lynse_token") || storage.getItem("lynse_api_key")) {
        hydrateListQueryCache(client, storage);
      } else {
        clearListQueryCache(storage);
      }
    } catch {
      /* storage unavailable (private mode etc.) — cache stays memory-only */
    }
    return client;
  });

  useEffect(() => {
    setActiveQueryClient(queryClient);
    const detach = attachListQueryPersistence(queryClient, storage);
    return () => {
      detach();
      if (getActiveQueryClient() === queryClient) setActiveQueryClient(null);
    };
  }, [queryClient, storage]);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
