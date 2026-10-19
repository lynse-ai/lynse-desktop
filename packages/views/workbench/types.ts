import type { RequestModelOverride } from "../workspace/model-override";

export interface SourceRef {
  kind: string;
  id: string;
  revision: string;
  segmentId?: string;
  startMs?: number;
  endMs?: number;
  quote: string;
}
export interface WorkbenchEntry {
  id: string;
  kind: string;
  title: string;
  revision: string;
  status: "pending" | "synced" | "awaiting_transcription" | "failed" | "conflict";
  excluded: boolean;
  error: string;
}
export interface MemoryItem {
  id: string;
  text: string;
  kind: "observation" | "proposal" | "decision" | "unresolved";
  sourceId: string;
  sourceTitle: string;
  citations: SourceRef[];
  pinned?: boolean;
  excluded?: boolean;
  stale?: boolean;
  userEdited?: boolean;
  updatedAt?: string;
}
export interface TodoSuggestion {
  id: string;
  title: string;
  dueDate?: string;
  citations: SourceRef[];
  accepted?: boolean;
}
export interface SynthesisResult {
  summary: string;
  memoryItems: MemoryItem[];
  todoSuggestions: TodoSuggestion[];
  citations: SourceRef[];
  insufficientEvidence?: boolean;
}
export interface WorkbenchStatus {
  scope: string;
  userId: string;
  enabled: boolean;
  allowAi: boolean;
  initialComplete: boolean;
  phase: "disabled" | "pending" | "discovering" | "syncing" | "ready" | "failed" | "incomplete" | "processing";
  updatedAt: string;
  error: string;
  discovered: number;
  synced: number;
  awaitingTranscription: number;
  failed: number;
  conflicts: number;
  entries: WorkbenchEntry[];
  memories: MemoryItem[];
}
export interface KnowledgeDocument {
  id: string;
  kind: string;
  title: string;
  revision: string;
  transcript: string;
  outline: string;
  segments: { id: string; text?: string; recognizedText?: string; startMs?: number; endMs?: number; speakerName?: string }[];
  conclusions: { id?: string; templateName?: string; conclusionText: string }[];
  todos: Record<string, unknown>[];
  aiContextEnabled?: boolean;
  playbackPath?: string;
  cloudFileId?: string;
  markers?: import("../live-translation/types").RecordingMarker[];
}
export interface WorkbenchReadResult {
  document: KnowledgeDocument;
  markdown: string;
  artifacts: { summaries: { id: string; markdown: string; createdAt: string }[]; todoSuggestions: TodoSuggestion[] } | null;
}
export interface SearchResult {
  items: { id: string; title: string; kind: string; excerpt: string; source: SourceRef }[];
  initialComplete: boolean;
}
export interface DesktopContext {
  version: 1;
  scope: string;
  sources: SearchResult["items"];
}
export interface DesktopWorkbenchApi {
  bind(request: { baseUrl: string; agentUrl?: string; token: string; locale: string; modelOverride?: RequestModelOverride | null }): Promise<WorkbenchStatus>;
  unbind(): Promise<void>;
  status(): Promise<WorkbenchStatus>;
  configure(enabled: boolean, allowAi: boolean): Promise<WorkbenchStatus>;
  sync(retryFailed?: boolean): Promise<void>;
  search(query: string, aiOnly?: boolean): Promise<SearchResult>;
  read(id: string): Promise<WorkbenchReadResult>;
  review(query: string): Promise<SynthesisResult>;
  exclude(id: string, excluded: boolean): Promise<void>;
  editMemory(id: string, text: string, pinned: boolean, excluded: boolean): Promise<void>;
  clear(): Promise<void>;
  confirmTodos(id: string, suggestions: Pick<TodoSuggestion, "id" | "title" | "dueDate">[]): Promise<unknown[]>;
  saveSummary(id: string, summaryId: string, markdown: string): Promise<void>;
  regenerate(id: string): Promise<void>;
  removeSource(id: string): Promise<void>;
  resolveConflict(id: string, keepLocal: boolean): Promise<void>;
  context(query: string): Promise<DesktopContext | null>;
  onUpdate(callback: (status: WorkbenchStatus) => void): Promise<() => void>;
}
