export type ItemType = "recording" | "meeting" | "note" | "file";

import type { SttProviderConfig } from "./local-transcription";

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

export interface LocalTranscriptionSegment {
  id: string;
  text: string;
  startMs?: number;
  endMs?: number;
  speakerId?: string;
  speakerName?: string;
  rawSpeaker?: string;
  confidence?: number;
  voiceprintId?: string;
  /** @deprecated compatibility with first local records */
  speaker?: string;
}

export type LocalTranscriptionStatus = "queued" | "transcribing" | "completed" | "failed";

export interface LocalTranscriptionRecord {
  id: string;
  title: string;
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
  transcriptText: string;
  status: LocalTranscriptionStatus;
  progressPhase?: LocalTranscriptionStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  expectedSpeakers?: number;
  hotwordPackageId?: string;
  engine: "funasr" | "whisper" | "moss_transcribe_diarize";
  modelId?: string;
  providerConfig?: SttProviderConfig;
  segments: LocalTranscriptionSegment[];
  error?: string;
}

export interface LocalTranscriptionOptions {
  expectedSpeakers?: number;
  hotwordPackageId?: string;
  language?: string | null;
  providerConfig?: SttProviderConfig | null;
}

export interface LocalHotwordTerm {
  term: string;
  replacement?: string;
  enabled: boolean;
  weight?: number;
}

export interface LocalHotwordPackage {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  terms: LocalHotwordTerm[];
}

export interface LocalVoiceprint {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sampleRecordId: string;
  sampleSegmentIds: string[];
  embedding: number[];
  sampleText?: string;
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
  /** Transient progress text shown while the assistant is "thinking"/running tools. */
  status?: string;
  /** Sources (meeting titles / ids) referenced by the answer. */
  sources?: string[];
  /** Report / visual-card / image attachments. */
  attachments?: ChatAttachment[];
  /** Marks an errored assistant message so the UI can style it. */
  error?: boolean;
}

/** Which backend serves a chat session. */
export type ChatProvider = "cloud";

export interface ChatAttachment {
  id?: string;
  name?: string;
  type?: "pdf" | "image" | "file" | string;
  /** Render/preview URL (image) or download URL (pdf/file). */
  url?: string;
  downloadUrl?: string;
  thumbnailUrl?: string;
}

/**
 * Typed events emitted by a ChatTransport as the assistant responds.
 * Replaces the previous "guess done by content stability" heuristic.
 */
export type ChatStreamEvent =
  | { type: "status"; text: string }
  | { type: "content"; delta: string }
  | { type: "meta"; sources: string[]; attachments: ChatAttachment[] }
  | { type: "done"; text?: string; sources?: string[]; attachments?: ChatAttachment[] }
  | { type: "error"; message: string };

/** Stable identity for one conversation turn series. */
export interface ChatSessionMeta {
  sessionId: string;
  userId: string;
  provider: ChatProvider;
  fileIds: string[];
  userSpecifiedFile: boolean;
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

export interface TransFileStatusDetails {
  status: string;
  taskId?: string;
  [key: string]: unknown;
}

export type TransFileStatus = string | TransFileStatusDetails;
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
