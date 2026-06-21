import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
import type {
  FileDetail,
  FileConclusion,
  FileOutline,
  FileTranscription,
  WorkspaceItem,
  PromptTemplateCategory,
  PreSignedUrlVO,
  TransferFileReq,
  TransferFileResult,
  TransStatusMap,
  AiTaskAddReq,
} from "../types";

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

/**
 * Get a presigned download URL for the file's original audio/media.
 */
export function useFileAudioUrl(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file-audio-url", fileId],
    queryFn: async () => {
      try {
        const data = await api().getWithParams<string>("/api/business/file/presign/download", {
          fileId: fileId!,
        });
        return data;
      } catch {
        return null;
      }
    },
    enabled: !!fileId && isAuthenticated,
    staleTime: 5 * 60 * 1000, // presigned URLs expire, but cache for 5 min
    retry: false, // don't retry — endpoint may not exist
  });
}

/** Update a conclusion's text content. */
export function useUpdateConclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conclusionId, conclusionText }: { conclusionId: string; conclusionText: string }) =>
      api().post<unknown>("/api/business/file/conclusion/update", {
        id: conclusionId,
        conclusionText,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-conclusions"] });
    },
  });
}

export function useInvalidateOnAuth() {
  const queryClient = useQueryClient();

  return function invalidateAll() {
    queryClient.invalidateQueries();
  };
}

// ── Template & Upload pipeline hooks ─────────────────────

/** Fetch all prompt template categories (50+ templates). */
export function useTemplateCategories() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: ["template-categories"],
    queryFn: () =>
      api().get<PromptTemplateCategory[]>("/api/business/translate/prompt/categories"),
    enabled: isAuthenticated,
    staleTime: 10 * 60 * 1000, // templates rarely change
  });
}

/**
 * Upload a file to OSS via presigned URL, then notify the backend.
 * Returns the fileId assigned by the server.
 */
export async function uploadFileToOSS(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<string> {
  // 1. Get presigned URL
  const presign = await api().post<PreSignedUrlVO>(
    "/api/business/file/presign/upload",
    { originalFilename: file.name, fileSize: file.size },
  );
  const { url, headers, fileId } = presign;

  // 2. Upload file directly to OSS
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    // Apply presigned headers (e.g., x-oss-*, Content-Type)
    for (const [k, v] of Object.entries(headers ?? {})) {
      xhr.setRequestHeader(k, v);
    }
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`OSS upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("OSS upload network error"));
    xhr.send(file);
  });

  // 3. Notify backend that upload is complete
  await api().getWithParams("/api/business/file/upload/notify", { fileId });

  return fileId;
}

/** Trigger transcription + summarization pipeline for an uploaded file. */
export function useTransferFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: TransferFileReq) =>
      api().post<TransferFileResult>("/api/business/file/trans", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

/**
 * Poll transcription/summarization status for a set of files.
 * Polls every 3s until all statuses are terminal (completed/failed).
 */
export function useTranscriptionStatus(fileIds: string[]) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const enabled = fileIds.length > 0 && isAuthenticated;

  return useQuery({
    queryKey: ["trans-status", fileIds],
    queryFn: () =>
      api().post<TransStatusMap>("/api/business/file/trans/status", {
        fileIds,
      }),
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data as TransStatusMap | undefined;
      if (!data) return 3000;
      // Stop polling when all files are in terminal state
      const allDone = fileIds.every((id) => {
        const s = data[id]?.status;
        return s === "completed" || s === "failed" || s === "COMPLETED" || s === "FAILED";
      });
      return allDone ? false : 3000;
    },
  });
}

/**
 * Trigger re-summarization for an existing file (no re-upload needed).
 * Uses POST /api/business/file/ai with aiTaskType="conclusion".
 */
export function useResummarize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: AiTaskAddReq) =>
      api().post<string>("/api/business/file/ai", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-conclusions"] });
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}
