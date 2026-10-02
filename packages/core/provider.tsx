"use client";

import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient, setActiveQueryClient } from "./query-client";
import {
  attachListQueryPersistence,
  hydrateListQueryCache,
} from "./query-persistence";
import { defaultStorage } from "./platform/storage";
import type { ReactNode } from "react";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const client = createQueryClient();
    setActiveQueryClient(client);
    // Seed last session's list data before the first render, then keep the
    // mirror fresh — both best-effort, failures never surface in the UI.
    try {
      hydrateListQueryCache(client, defaultStorage);
      attachListQueryPersistence(client, defaultStorage);
    } catch {
      /* storage unavailable (private mode etc.) — cache stays memory-only */
    }
    return client;
  });
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
