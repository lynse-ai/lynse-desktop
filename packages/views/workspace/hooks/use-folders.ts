import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
import type { FolderInfo } from "../types";
import { LIST_STALE_TIME_MS } from "./use-files";

export function useFolders() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["folders"],
    queryFn: () => api().get<FolderInfo[]>("/api/business/file/folder/list"),
    enabled: isAuthenticated,
    // Folders change rarely; remounts inside the window are instant and the
    // persisted copy keeps them available across app restarts.
    staleTime: LIST_STALE_TIME_MS,
  });
}
