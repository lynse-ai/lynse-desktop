import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: 1,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

let activeQueryClient: QueryClient | null = null;

/** Remember the app's live QueryClient so non-hook modules (e.g. the todo
 *  data layer) can share its cache instead of firing parallel requests.
 *  Registered by `QueryProvider`; the last created client wins, which is
 *  what single-provider apps want. */
export function setActiveQueryClient(client: QueryClient): void {
  activeQueryClient = client;
}

export function getActiveQueryClient(): QueryClient | null {
  return activeQueryClient;
}
