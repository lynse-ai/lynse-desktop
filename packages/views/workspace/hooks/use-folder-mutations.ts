import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import type { FolderAddOrEditReq, FolderSortUpdateReq } from "../types";

/** POST /api/business/file/folder/add */
export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FolderAddOrEditReq) =>
      api().post<unknown>("/api/business/file/folder/add", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folder-counts"] });
    },
  });
}

/** PUT /api/business/file/folder/{folderId} */
export function useEditFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, body }: { folderId: string; body: FolderAddOrEditReq }) =>
      api().put<unknown>(`/api/business/file/folder/${folderId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folder-counts"] });
    },
  });
}

/** DELETE /api/business/file/delete?folderIds=... (soft-delete to bin) */
export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderIds: string[]) =>
      api().delete<unknown>(
        `/api/business/file/delete?folderIds=${folderIds.join(",")}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["folder-counts"] });
    },
  });
}

/** PUT /api/business/file/folder/batch-update-sort */
export function useReorderFolders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FolderSortUpdateReq) =>
      api().put<unknown>("/api/business/file/folder/batch-update-sort", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

/** GET /api/business/file/changeFolder (mutation via GET — unusual but backend uses GET) */
export function useMoveFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      oldFolderId,
      newFolderId,
      fileIds,
    }: {
      oldFolderId: string;
      newFolderId: string;
      fileIds: string[];
    }) =>
      api().getWithParams<unknown>("/api/business/file/changeFolder", {
        oldFolderId: oldFolderId || "",
        newFolderId: newFolderId || "",
        fileIds: fileIds.join(","),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["folder-counts"] });
    },
  });
}
