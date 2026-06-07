import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
import type { FileDetail, FileConclusion, FileOutline, FileTranscription, WorkspaceItem } from "../types";

// Lynse API returns { code, data: [...files], total, msg }
// ApiClient unwraps to the inner data field (the file array)
type FileListResponse = Record<string, unknown>[];

export function useFiles(params: {
  pageNum?: number;
  pageSize?: number;
  originalFilename?: string;
}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["files", params],
    queryFn: async () => {
      const data = await api().getWithParams<FileListResponse | Record<string, unknown>>("/api/business/file/page", {
        pageNum: params.pageNum ?? 1,
        pageSize: params.pageSize ?? 100,
        originalFilename: params.originalFilename,
      });
      // After unwrapping, data might be the file array directly
      // or an object with list/records/data key
      if (Array.isArray(data)) return data;
      for (const key of ["list", "records", "data"]) {
        const arr = (data as Record<string, unknown>)[key];
        if (Array.isArray(arr)) return arr;
      }
      return [];
    },
    select: (items): WorkspaceItem[] =>
      items.map((f) => ({
        id: String((f as Record<string, unknown>).id ?? ""),
        type: "file" as const,
        title: String((f as Record<string, unknown>).originalFilename ?? ""),
        updatedAt: String((f as Record<string, unknown>).updateTime ?? ""),
        createdAt: String((f as Record<string, unknown>).createTime ?? ""),
        folderId: (f as Record<string, unknown>).folderId as string | undefined,
      })),
    enabled: isAuthenticated,
  });
}

export function useFileDetail(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file", fileId],
    queryFn: () =>
      api().getWithParams<FileDetail>("/api/business/file/info", {
        fileId: fileId!,
      }),
    enabled: !!fileId && isAuthenticated,
  });
}

export function useFileConclusions(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file-conclusions", fileId],
    queryFn: () =>
      api().getWithParams<FileConclusion[]>("/api/business/file/conclusion/list", {
        fileId: fileId!,
      }),
    enabled: !!fileId && isAuthenticated,
  });
}

export function useFileOutline(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file-outline", fileId],
    queryFn: () =>
      api().getWithParams<FileOutline>("/api/business/file/outline/get", {
        fileId: fileId!,
      }),
    enabled: !!fileId && isAuthenticated,
  });
}

export function useFileTranscription(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file-transcription", fileId],
    queryFn: () =>
      api().getWithParams<FileTranscription>("/api/business/file/trans/get", {
        fileId: fileId!,
      }),
    enabled: !!fileId && isAuthenticated,
  });
}

export function useInvalidateOnAuth() {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return function invalidateAll() {
    queryClient.invalidateQueries();
  };
}
