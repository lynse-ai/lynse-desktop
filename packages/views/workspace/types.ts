export type ItemType = "recording" | "meeting" | "note" | "file";
export type RecordingMode = "meeting" | "call" | "import";

import type { SttProviderConfig } from "./local-transcription";
import type { ConnectorConnectionRequest } from "@lynse/core/api";

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
  /** Cloud files only: owning team (needed by team-scoped write endpoints). */
  teamId?: string;
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

/** One selectable audio track of a dual-channel recording (mirrors the Rust
 *  `audio_contract::manifest::TrackEntry`). */
export interface RecordingTrackEntry {
  id: string;
  file: string;
  role: "mic" | "system";
  processed: boolean;
  sampleRate: number;
  channels: number;
  bitsPerSample?: number;
  sampleFormat?: string;
}

/** Versioned dual-track manifest (`tracks.json`, written by the capture
 *  sidecar / Windows engine next to the recording). */
export interface RecordingTrackManifest {
  version: number;
  /** `webrtc-aec3-1.3`, or `none` when the engine was unavailable. */
  engine: string;
  sampleRate: number;
  tracks: RecordingTrackEntry[];
  /** Half-open [startMs, endMs) spans that could not be echo-cancelled. */
  degradedIntervalsMs?: [number, number][];
}

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
  engine: "qwen3" | "funasr" | "whisper" | "vibeasr" | "mlx" | "moss" | "ilivedata_rtvt";
  modelId?: string;
  providerConfig?: SttProviderConfig;
  segments: LocalTranscriptionSegment[];
  error?: string;
  /** Set by the Rust side once the recording is uploaded ("synced") or
   * marked for retry ("pending") — see live_translation_finalize_local. */
  syncStatus?: string;
  /** Client-generated cloud fileId, persisted before the first upload
   * attempt so a retry re-runs the sync chain against the same cloud
   * placeholder instead of duplicating the record. */
  cloudFileId?: string;
  /** Dual-channel track manifest; absent for legacy single-file recordings. */
  trackManifest?: RecordingTrackManifest;
  /** True when any span of the recording could not be echo-cancelled. */
  aecDegraded?: boolean;
  /** Per-track offline-transcription results (dual-channel re-transcribe). */
  trackStatuses?: Partial<Record<"mic" | "system", { status: string; error?: string }>>;
  /** Present on recordings captured by the live-translation sidecar; needed
   *  for the detail panel's reprocess entry. */
  liveSessionId?: string;
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
  /** Embedding model family ("3dspeaker"); "campplus"/"mect" only appear on entries enrolled with previous engines, and they never match. */
  backend?: string;
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
  /**
   * Cloud file ids this turn referenced (@ mentions / the selected meeting).
   * Kept on the user message so reply actions — e.g. filing an assistant
   * reply as that note's summary — can still resolve the target file after
   * a history reload.
   */
  fileIds?: string[];
  /** Structured confirmation prompt emitted by the assistant (a2UI-style). */
  confirm?: ChatConfirm;
  /** Human-handoff link; shown as a "contact support" button under the reply. */
  humanSupportLink?: ChatHumanSupportLink;
  connectionRequests?: ConnectorConnectionRequest[];
  /**
   * When the finished answer landed (poll delivers the whole turn at once).
   * The UI plays its two-phase reveal (text first, attachments follow)
   * only while this timestamp is fresh, so history and conversation switches
   * never replay the animation. Stripped before persisting.
   */
  revealedAt?: number;
  /**
   * WorkBuddy thread: the server-side message id this local message mirrors.
   * Catch-up syncs dedupe against it so a reply is never appended twice.
   */
  serverId?: string;
  /**
   * The turn failed because WorkBuddy is not authorized (or the ticket
   * expired). Renders an inline authorize card instead of the error text.
   */
  workbuddyAuthRequired?: boolean;
  workbuddyAuthReason?: string;
  workbuddyStopReason?: string;
}

/**
 * Which backend serves a chat session. `"qoder"` is legacy: conversations
 * stored by the removed Qoder Cloud Agent channel keep the marker so old
 * histories still load. `"workbuddy"` uses independent cloud tasks on desktop;
 * old local-assistant histories have no workbuddySession marker.
 */
export type ChatProvider = "cloud" | "qoder" | "workbuddy";

/**
 * Which assistant the chat UI is talking to: the Lynse cloud channel
 * ("小灵助手") or the user's authorized WorkBuddy assistant.
 */
export type ChatAssistant = "lynse" | "workbuddy";

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
  /** Missing on legacy local-assistant history. Never contains credentials. */
  workbuddySession?: WorkBuddyCloudSession;
}

export interface WorkBuddyCloudSession {
  mode: "cloud";
  taskId?: string;
}

export interface ChatAttachment {
  id?: string;
  name?: string;
  type?: "pdf" | "image" | "file" | string;
  /** Render/preview URL (image) or download URL (pdf/file). */
  url?: string;
  downloadUrl?: string;
  thumbnailUrl?: string;
  text?: string;
  workbuddyArtifact?: { taskId: string; uri: string; revision?: string };
  /**
   * When the signed download URL expires (server-provided, often absent).
   * lynclaw signed URLs die after ~1h regardless; `id` (the artifact id)
   * enables re-signing via the refresh endpoint when that happens.
   */
  expiresAt?: string;
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
  /** Frozen context action fields shown to the user before authorization. */
  preview?: Record<string, ChatConfirmPreviewValue>;
  workbuddy?: {
    requestId: string | number;
    questions?: { id: string; question: string; multiSelect: boolean; options: ChatConfirmOption[] }[];
  };
}

export type ChatConfirmPreviewValue = string | number | boolean | null | ChatConfirmPreviewValue[] | { [key: string]: ChatConfirmPreviewValue };

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
  | { type: "meta"; sources: string[]; attachments: ChatAttachment[]; connectionRequests?: ConnectorConnectionRequest[] }
  | {
      type: "done";
      text?: string;
      sources?: string[];
      attachments?: ChatAttachment[];
      humanSupportLink?: ChatHumanSupportLink;
      connectionRequests?: ConnectorConnectionRequest[];
      workbuddyStopReason?: string;
    }
  | { type: "error"; message: string; /** True when the fix is re-authorizing WorkBuddy. */ workbuddyAuthRequired?: boolean }
  | { type: "workbuddy_session"; session: WorkBuddyCloudSession }
  | { type: "confirm_resolved"; requestId: string | number }
  /**
   * WorkBuddy transport: a server history message is now mirrored by a local
   * message (the assistant placeholder for "assistant", the just-sent user
   * message for "user"). The server id lets thread catch-ups dedupe.
   */
  | { type: "workbuddy_seen"; serverId: string; role: "user" | "assistant" }
  | { type: "confirm"; confirm: ChatConfirm }
  | { type: "connection_request"; request: ConnectorConnectionRequest };

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

/** Body shared by POST /api/business/file/sync/pre/create and /sync/pre/sts
 *  (backend SyncPreUploadReq). `fileId` is generated on the client and must
 *  be reused across retries of the same recording — create upserts the
 *  placeholder by it, so a constant id is what keeps re-uploads from
 *  producing duplicate cloud records. */
export interface SyncPreUploadReq {
  fileId: string;
  /** Saved filename including extension, e.g. "20260923_142501.wav". */
  saveFilename: string;
  /** File size in bytes. */
  fileSize: number;
  /** Audio duration in whole seconds. */
  bizDuration: number;
  contentType?: string;
  folderId?: string;
  macAddress?: string;
  location?: string;
  /** Audio mode (meeting/call). */
  mode?: string;
  teamId?: string;
  /** Hex md5 of the file content. */
  md5?: string;
  /** Recording start time, "yyyy-MM-dd HH:mm:ss" (GMT+8) — the backend
   *  aligns the file's create time with it on first notify. */
  recordStartTime?: string;
  /** Recording marker points, in ms. */
  recordMarks?: number[];
}

/** STS temporary credentials returned by POST /api/business/file/sync/pre/sts
 *  (backend StsTokenVO). The direct upload target is
 *  `https://{bucket}.{endpoint}/{objectKey}`; `objectKey` (path + server-side
 *  UUID name) is authoritative — never assembled on the client. */
export interface StsTokenVO {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  /** ISO8601 instant; the upload must finish (or re-fetch) before it. */
  expiration: string;
  bucket: string;
  /** OSS endpoint without the protocol prefix. */
  endpoint: string;
  objectKey: string;
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
