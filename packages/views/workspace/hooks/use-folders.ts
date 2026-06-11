import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
import type { FolderInfo } from "../types";

export function useFolders() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["folders"],
    queryFn: () => api().get<FolderInfo[]>("/api/business/file/folder/list"),
    enabled: isAuthenticated,
  });
}
