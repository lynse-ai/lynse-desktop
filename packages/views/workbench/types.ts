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
export interface MemoryFile {
  path: string;
  title: string;
  kind: "note" | "entry" | "snapshot";
  editable: boolean;
  syncState?: "synced" | "pending" | "conflict" | "offline" | "template";
  memoryStatus?: string;
  memoryType?: string;
  syncError?: string;
}
export interface MemoryDocument extends MemoryFile {
  markdown: string;
  revision: string;
  citations: SourceRef[];
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
  phase: "disabled" | "pending" | "discovering" | "syncing" | "ready" | "failed" | "incomplete" | "processing" | "waiting_configuration";
  updatedAt: string;
  error: string;
  wikiProgress?: WikiProgress | null;
  discovered: number;
  synced: number;
  awaitingTranscription: number;
  failed: number;
  conflicts: number;
  entries: WorkbenchEntry[];
  memories: MemoryItem[];
}
export interface WikiProgress {
  stage: "preparing" | "analyzing" | "compiling" | "embedding" | "complete";
  completed: number;
  total: number;
  currentTitle: string;
  topicTitle: string;
  failed: number;
}
export interface KnowledgeDocument {
  citations?: SourceRef[];
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
  bind(request: { baseUrl: string; agentUrl?: string; token: string; locale: string; betaEnabled?: boolean; gmailPluginEnabled?: boolean; modelOverride?: RequestModelOverride | null }): Promise<WorkbenchStatus>;
  unbind(): Promise<void>;
  status(): Promise<WorkbenchStatus>;
  wiki(request: WikiRequest): Promise<WikiState>;
  configure(enabled: boolean, allowAi: boolean): Promise<WorkbenchStatus>;
  sync(retryFailed?: boolean, refreshExisting?: boolean): Promise<void>;
  search(query: string, aiOnly?: boolean): Promise<SearchResult>;
  read(id: string): Promise<WorkbenchReadResult>;
  review(query: string): Promise<SynthesisResult>;
  exclude(id: string, excluded: boolean): Promise<void>;
  editMemory(id: string, text: string, pinned: boolean, excluded: boolean): Promise<void>;
  memoryFiles(scope: string): Promise<MemoryFile[]>;
  readMemoryFile(scope: string, path: string): Promise<MemoryDocument>;
  reloadMemoryFile(scope: string, path: string): Promise<MemoryDocument>;
  saveMemoryFile(scope: string, path: string, markdown: string, revision: string): Promise<MemoryDocument>;
  createMemoryFile(scope: string, title: string): Promise<MemoryDocument>;
  clear(): Promise<void>;
  confirmTodos(id: string, suggestions: Pick<TodoSuggestion, "id" | "title" | "dueDate">[]): Promise<unknown[]>;
  saveSummary(id: string, summaryId: string, markdown: string): Promise<void>;
  regenerate(id: string): Promise<void>;
  removeSource(id: string): Promise<void>;
  resolveConflict(id: string, keepLocal: boolean): Promise<void>;
  context(query: string): Promise<DesktopContext | null>;
  onUpdate(callback: (status: WorkbenchStatus) => void): Promise<() => void>;
}

export interface WikiModel { baseUrl: string; model: string }
export interface WikiModelsConfig { embedding: WikiModel; revision?: string; textRevision?: string }
export interface WikiRevision { id: string; markdown: string; citations: SourceRef[]; fingerprint: string; createdAt: string; reviewedAt: string; review: string }
export interface WikiTopic { id: string; mergedIds?: string[]; title: string; purpose: string; notes: string; pinned: boolean; excluded: boolean; stale: boolean; candidate: WikiRevision | null; published: WikiRevision | null; error: string }
export interface WikiSources { gmailEnabled: boolean; gmailAccountId: string; integrationsUrl: string; error?: string; updatedAt?: string }
export type GraphKind = "project" | "topic" | "goal" | "wiki" | "source";
export type GraphStatus = "unknown" | "proposed" | "active" | "blocked" | "completed" | "unresolved" | "candidate" | "published" | "stale" | "source";
export interface GraphUpdate { description: string; status: GraphStatus; observedAt: string; citations: SourceRef[] }
export interface GraphNode { id: string; kind: GraphKind; title: string; description: string; status: GraphStatus; wikiId?: string | null; source?: SourceRef | null; citations: SourceRef[]; updates: GraphUpdate[] }
export interface KnowledgeGraph { nodes: GraphNode[]; edges: { id: string; source: string; target: string; kind: string }[]; automaticTracking: boolean; tracking: { processing: boolean; paused?: boolean; completed: number; total: number; failed: number; error: string } }
export interface WikiState { topics: WikiTopic[]; models: WikiModelsConfig; sources?: WikiSources; graph?: KnowledgeGraph }
export type WikiRequest = { action: "state" } | { action: "models"; models: WikiModelsConfig; embeddingKey?: string } | { action: "topic"; id?: string; title: string; purpose: string; notes?: string; pinned?: boolean; excluded?: boolean } | { action: "review"; id: string; candidateId: string; approve: boolean; markdown?: string } | { action: "retry"; id?: string } | { action: "sources"; sources: WikiSources } | { action: "tracking"; enabled: boolean } | { action: "tracking_retry" } | { action: "tracking_dismiss" | "tracking_restore"; id: string };
