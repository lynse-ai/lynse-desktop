import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
import type { FileCategoryCount } from "../types";

/** GET /api/business/file/category/count — server-computed file counts per folder */
export function useFolderCounts() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["folder-counts"],
    queryFn: () =>
      api().get<FileCategoryCount>("/api/business/file/category/count"),
    enabled: isAuthenticated,
    staleTime: 30_000, // 30s — counts change on file ops
  });
}
