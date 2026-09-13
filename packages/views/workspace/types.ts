export type ItemType = "recording" | "meeting" | "note" | "file";
export type RecordingMode = "meeting" | "call" | "import";

import type { SttProviderConfig } from "./local-transcription";

export interface WorkspaceItem {
  id: string;
  type: ItemType;
  title: string;
  updatedAt: string;
  createdAt: string;
  folderId?: string;
  tags?: string[];
  /** Recording source type from the backend file `mode` field. */
  recordingMode?: RecordingMode;
  /** Recording duration in seconds. */
  durationSeconds?: number;
  /** MIME type from the backend (e.g. audio/mpeg, video/mp4). Used to detect recordings. */
  contentType?: string;
  /** Local transcriptions only: whether the transcription pipeline has finished. */
  transcriptionCompleted?: boolean;
  /** Local transcriptions only: pipeline status. Drives the detail-panel
   *  progress pill and retry affordance — list cards show a local-recording
   *  badge instead of encoding this in `tags`. */
  localStatus?: LocalTranscriptionStatus;
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
  source?: "mic" | "system";
  translatedText?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  isFinal?: boolean;
  /** @deprecated compatibility with first local records */
  speaker?: string;
}

export type LocalTranscriptionStatus =
  | "queued"
  | "transcribing"
  | "completed"
  | "failed"
  // Terminal state of a live session that saved audio but never produced
  // transcript text (pure recording mode). Written by the Rust side and
  // normalized from legacy completed-with-empty-transcript records.
  | "recorded"
  // Frontend-only placeholder states for a session that started but has not
  // persisted its record yet (see live-translation/pending-recording-store).
  | "recording"
  | "saving";

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
  /** Real recording length in ms (probed from the audio); the live-translation
   *  engine writes it directly. */
  durationMs?: number;
  /** Wall-clock time the transcription took, in ms (batch engines only). */
  elapsedMs?: number;
  expectedSpeakers?: number;
  hotwordPackageId?: string;
  engine: "funasr" | "whisper" | "vibeasr" | "ilivedata_rtvt";
  modelId?: string;
  providerConfig?: SttProviderConfig;
  segments: LocalTranscriptionSegment[];
  error?: string;
  /** Set by the Rust side once the recording is uploaded ("synced") or
   * marked for retry ("pending") — see live_translation_finalize_local. */
  syncStatus?: string;
}

export interface LocalTranscriptionOptions {
  expectedSpeakers?: number;
  /** `null` explicitly disables hotwords for this task; `undefined` falls back
   *  to the engine's configured package. */
  hotwordPackageId?: string | null;
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

/** One tool invocation announced during an assistant turn (ZCode-style
 * activity row: icon + label + running/done state). */
export interface ChatToolUse {
  /** Backend tool-call id when provided; otherwise derived from the name. */
  id: string;
  /** Raw backend tool name, e.g. "search_meetings". */
  name: string;
  state: "running" | "done";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Transient progress text shown while the assistant is "thinking"/running tools. */
  status?: string;
  /** Chain-of-thought streamed before/around the answer (reasoning trace). */
  thinking?: string;
  /** True while reasoning deltas are still arriving (block shows live state). */
  thinkingActive?: boolean;
  /** Tool calls announced during the turn, in call order. */
  toolUses?: ChatToolUse[];
  /** Sources (meeting titles / ids) referenced by the answer. */
  sources?: string[];
  /** Report / visual-card / image attachments. */
  attachments?: ChatAttachment[];
  /** Marks an errored assistant message so the UI can style it. */
  error?: boolean;
  /** Structured confirmation prompt emitted by the assistant (a2UI-style). */
  confirm?: ChatConfirm;
  /** Human-handoff link; shown as a "contact support" button under the reply. */
  humanSupportLink?: ChatHumanSupportLink;
  /**
   * When the finished answer landed (poll delivers the whole turn at once).
   * The UI plays its two-phase reveal (text fades in, attachments follow)
   * only while this timestamp is fresh, so history and conversation switches
   * never replay the animation. Stripped before persisting.
   */
  revealedAt?: number;
}

/**
 * Which backend serves a chat session. `"qoder"` is legacy: conversations
 * stored by the removed Qoder Cloud Agent channel keep the marker so old
 * histories still load; everything now runs on the cloud channel.
 */
export type ChatProvider = "cloud" | "qoder";

/** Legacy resume state kept only so stored Qoder conversations still parse. */
export interface QoderChatSessionState {
  sessionId: string;
  afterEventId?: string;
  sessionOptionsKey: string;
}

/** A locally indexed conversation. */
export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  provider: ChatProvider;
  createdAt: number;
  updatedAt: number;
  qoderSession?: QoderChatSessionState;
}

export interface ChatAttachment {
  id?: string;
  name?: string;
  type?: "pdf" | "image" | "file" | string;
  /** Render/preview URL (image) or download URL (pdf/file). */
  url?: string;
  downloadUrl?: string;
  thumbnailUrl?: string;
}

/** A single selectable option in a confirmation prompt (a2UI-style). */
export interface ChatConfirmOption {
  /** Human-readable label shown on the option button. */
  label: string;
  /** Value sent back as the user's reply when this option is chosen. */
  value: string;
}

/** Structured confirmation request the assistant can emit (a2UI-compatible). */
export interface ChatConfirm {
  /** Short question / instruction shown above the options (card `title`). */
  question: string;
  /** Selectable options (2+). */
  options: ChatConfirmOption[];
  /** Backend card kind, e.g. "clear_todos_confirm". */
  kind?: string;
  /** Echoed back as `confirm_token` when the user picks one of the actions. */
  confirmToken?: string;
  /** Backend risk hint for the card ("low" | "medium" | "high"). */
  riskLevel?: string;
}

/** Human-handoff entry the backend attaches to a finished reply. */
export interface ChatHumanSupportLink {
  /** Button label from the backend (e.g. "联系人工"); UI falls back to a localized default. */
  label?: string;
  /** Clickable page or download URL. */
  url?: string;
}

/**
 * Typed events emitted by a ChatTransport as the assistant responds.
 * Replaces the previous "guess done by content stability" heuristic.
 */
export type ChatStreamEvent =
  | { type: "status"; text: string }
  | { type: "content"; delta: string }
  /** Chain-of-thought delta; an empty delta closes the reasoning trace. */
  | { type: "thinking"; delta: string }
  /** Tool activity; `id` optional, `state` defaults to "running". */
  | { type: "tool"; name: string; id?: string; state?: "running" | "done" }
  | { type: "meta"; sources: string[]; attachments: ChatAttachment[] }
  | {
      type: "done";
      text?: string;
      sources?: string[];
      attachments?: ChatAttachment[];
      humanSupportLink?: ChatHumanSupportLink;
    }
  | { type: "error"; message: string }
  | { type: "confirm"; confirm: ChatConfirm };

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
  templateId?: string;
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
