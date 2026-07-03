export type ItemType = "recording" | "meeting" | "note" | "file";

export interface WorkspaceItem {
  id: string;
  type: ItemType;
  title: string;
  updatedAt: string;
  createdAt: string;
  folderId?: string;
  tags?: string[];
}

export interface FileItem {
  id: string;
  originalFilename: string;
  createdAt: string;
  updatedAt: string;
  folderId?: string;
  tags?: string[];
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
  templateName?: string;
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

/** Backend-aligned folder type (matches FolderInfoVO) */
export interface FolderInfo {
  id: string;
  folderName: string;
  color?: string;
  sort?: number;
  createTime?: string;
}

export interface FolderAddOrEditReq {
  id?: string;
  folderName: string;
  color?: string;
  sort?: number;
}

export interface FolderSortUpdateReq {
  folderSortList: Array<{ folderId: string; sort: number }>;
}

export interface FolderStatItem {
  folderId: string;
  folderName: string;
  count: number;
}

export interface FileCategoryCount {
  all: number;
  classified: number;
  unclassified: number;
  folderStats: FolderStatItem[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type EditorMode = "edit" | "preview" | "split";

// ── Template types ─────────────────────────────────────────

export interface PromptTemplate {
  id: string;
  name: string;
  alias: string;
  category: string;
  tags: string;
  isDefault: number;
  status: number;
  sortOrder: number;
  iconUrl: string;
  contentFormat: string;
}

export interface PromptTemplateCategory {
  category: string;
  templates: PromptTemplate[];
  count: number;
  sortOrder: number;
  isDefault: number;
}

// ── Upload & transcription pipeline types ─────────────────

export interface PreSignedUrlVO {
  url: string;
  headers: Record<string, string>;
  fileId: string;
}

export interface TransferFileReq {
  fileId: string;
  templateId: string;
  modelId?: string;
  languageId?: string;
}

export interface TransferFileResult {
  taskId: string;
  requiredPoints?: number;
}

export interface TransFileStatus {
  status: string;
  taskId?: string;
  [key: string]: unknown;
}

export type TransStatusMap = Record<string, TransFileStatus>;

export type UploadPhase = "idle" | "uploading" | "transcribing" | "summarizing" | "complete" | "error";

// ── AI task types (re-summarize without re-upload) ─────

export interface AiTaskAddReq {
  aiTaskType: "CONCLUSION";
  fileId: string;
  templateId?: string;
  teamId?: string;
  isOnlyMe?: number;
}

export interface AiTaskResultVO {
  status: string;
  taskId: string;
  conclusion?: FileConclusion;
  outline?: FileOutline;
}
