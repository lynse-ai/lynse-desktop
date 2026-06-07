export type ItemType = "recording" | "meeting" | "note" | "file";

export interface WorkspaceItem {
  id: string;
  type: ItemType;
  title: string;
  updatedAt: string;
  createdAt: string;
  folderId?: string;
}

export interface FileItem {
  id: string;
  originalFilename: string;
  createdAt: string;
  updatedAt: string;
  folderId?: string;
  fileSize?: number;
  status?: string;
}

export interface FilePageResponse {
  list: FileItem[];
  total: number;
  pages: number;
}

export interface FileDetail {
  id: string;
  originalFilename: string;
  createdAt: string;
  updatedAt: string;
  folderId?: string;
  fileSize?: number;
  status?: string;
  [key: string]: unknown;
}

export interface FileConclusion {
  id: string;
  fileId: string;
  conclusionText: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface FileOutline {
  id: string;
  fileId: string;
  content: string;
  [key: string]: unknown;
}

export interface FileTranscription {
  id: string;
  fileId: string;
  taskId: string;
  content: string;
  [key: string]: unknown;
}

export interface Folder {
  id: string;
  name: string;
  parentId?: string;
  createdAt?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type EditorMode = "edit" | "preview" | "split";
