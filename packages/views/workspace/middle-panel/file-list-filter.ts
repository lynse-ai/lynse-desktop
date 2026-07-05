import type { WorkspaceItem } from "../types";
import { isLocalFileId, LOCAL_TRANSCRIPTION_FOLDER_ID } from "../local-transcription";

export function filterWorkspaceFilesByFolder(
  files: WorkspaceItem[],
  selectedFolderId: string | null,
): WorkspaceItem[] {
  return files.filter((file) => {
    const isLocalFile = isLocalFileId(file.id);
    if (selectedFolderId === "__all__") return true;
    if (selectedFolderId === LOCAL_TRANSCRIPTION_FOLDER_ID) return isLocalFile;
    if (selectedFolderId === "__uncategorized__") return !isLocalFile && !file.folderId;
    if (selectedFolderId === "__trash__") return false;
    if (selectedFolderId && !selectedFolderId.startsWith("__")) return file.folderId === selectedFolderId;
    return file.folderId === selectedFolderId;
  });
}
