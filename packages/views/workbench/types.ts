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
export interface WikiAutomationConfig { folderIds: string[]; includeUnfiled: boolean }

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
  automation?: WikiAutomationConfig | null;
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
  artifacts: { summaries: { id: string; markdown: string; createdAt: string; sourceRevision?: string }[]; todoSuggestions: TodoSuggestion[] } | null;
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
  knowledgePolicy?(request: { action: "read" | "update"; policy?: Record<string, unknown> }): Promise<{ capabilities?: import("@lynse/core/api/memory").MemoryCapabilities; policy?: import("@lynse/core/api/memory").KnowledgePolicy; pending: boolean }>;
  bind(request: { baseUrl: string; agentUrl?: string; token: string; locale: string; betaEnabled?: boolean; gmailPluginEnabled?: boolean; modelOverride?: RequestModelOverride | null }): Promise<WorkbenchStatus>;
  unbind(): Promise<void>;
  status(): Promise<WorkbenchStatus>;
  wiki(request: WikiRequest): Promise<WikiState>;
  configure(enabled: boolean, allowAi: boolean, automation?: WikiAutomationConfig): Promise<WorkbenchStatus>;
  sync(retryFailed?: boolean, refreshExisting?: boolean): Promise<void>;
  search(query: string, aiOnly?: boolean): Promise<SearchResult>;
  read(id: string): Promise<WorkbenchReadResult>;
  readForAi?(id: string): Promise<WorkbenchReadResult>;
  syncMemorySource?(id: string): Promise<{ source_id: string; source_revision: number; complete: boolean }>;
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
export interface WikiChange { id: string; text: string; createdAt: string; citations: SourceRef[] }
export interface WikiRevision { overview?: string; changes?: WikiChange[]; id: string; markdown: string; citations: SourceRef[]; fingerprint: string; createdAt: string; reviewedAt: string; review: string }
export interface WikiFailure { message: string; stage: string; sourceIds: string[]; occurredAt: string }
export interface WikiTimelineEvent { id: string; text: string; date: string; dateBasis: "event" | "record" | "unknown"; citations: SourceRef[] }
export interface WikiTopicLink { targetId: string; state: "included" | "candidate" | "excluded" | "unrelated" | ""; manual: boolean; reason: string; citations: SourceRef[]; events: WikiTimelineEvent[]; fingerprint: string; error: string }
export interface WikiCollection { links: WikiTopicLink[]; status: string; completed: number; total: number }
export interface WikiTopic { collection?: WikiCollection | null; failure?: WikiFailure | null; topicKind?: "project" | "topic"; automaticKey?: string; sourceIds?: string[]; inScope?: boolean; history?: WikiRevision[]; id: string; mergedIds?: string[]; title: string; purpose: string; notes: string; pinned: boolean; excluded: boolean; stale: boolean; candidate: WikiRevision | null; published: WikiRevision | null; error: string }
export interface WikiSources { gmailEnabled: boolean; gmailAccountId: string; integrationsUrl: string; error?: string; updatedAt?: string }
export type GraphKind = "entity" | "event" | "topic" | "wiki" | "source";
export type GraphModality = "asserted" | "planned" | "proposed" | "negated" | "uncertain";
export type GraphStatus = "unknown" | "proposed" | "active" | "blocked" | "completed" | "cancelled" | "unresolved" | "candidate" | "published" | "stale" | "source";
export interface GraphEvidence extends SourceRef { speaker?: string; positions?: { segmentId?: string; startMs?: number; endMs?: number; speaker?: string }[] }
export interface GraphClaim { modality?: GraphModality; confidence?: number; review?: "candidate" | "confirmed"; userEdited?: boolean; reviewedAt?: string; citations?: GraphEvidence[] }
export interface GraphUpdate { description: string; status: GraphStatus; observedAt: string; citations: SourceRef[] }
export interface GraphNode extends GraphClaim { id: string; kind: GraphKind; linkedTodo?: { id: string; title: string; completed: boolean; dueDate?: string | null; updatedAt: string }; subtype?: string; members?: GraphNode[]; title: string; description: string; status: GraphStatus; timeText?: string; dueText?: string; extractedAt?: string; sourceId?: string; wikiId?: string | null; source?: SourceRef | null; citations: GraphEvidence[]; updates: GraphUpdate[] }
export interface GraphEdge extends GraphClaim { id: string; source: string; target: string; kind: string }
export interface KnowledgeGraph { schemaVersion?: number; nodes: GraphNode[]; edges: GraphEdge[]; availableSources?: { id: string; title: string; selected: boolean }[]; automaticTracking: boolean; tracking: { processing: boolean; paused?: boolean; completed: number; total: number; failed: number; error: string } }
export interface WikiState { createdTopicId?: string | null; automation?: WikiAutomationConfig | null; topicGraph?: KnowledgeGraph; topics: WikiTopic[]; models: WikiModelsConfig; sources?: WikiSources; graph?: KnowledgeGraph }
export type WikiRequest = { action: "source_folders"; ids: string[]; folderId: string } | { action: "correction"; id: string; notes: string } | { action: "state" } | { action: "models"; models: WikiModelsConfig; embeddingKey?: string } | { action: "topic"; mode?: "collection"; id?: string; title: string; purpose: string; notes?: string; pinned?: boolean; excluded?: boolean } | { action: "topic_link"; id: string; targetId: string; state: "included" | "excluded" } | { action: "topic_delete"; id: string } | { action: "review"; id: string; candidateId: string; approve: boolean; markdown?: string } | { action: "retry"; id?: string } | { action: "sources"; sources: WikiSources } | { action: "tracking"; enabled: boolean } | { action: "tracking_retry" } | { action: "tracking_sources"; ids: string[] } | { action: "tracking_todo"; id: string } | { action: "tracking_merge"; id: string; target: string } | { action: "tracking_unmerge"; id: string } | { action: "tracking_review"; id: string; review: "candidate" | "confirmed"; description?: string; status?: GraphStatus; modality?: GraphModality } | { action: "tracking_dismiss" | "tracking_restore" | "tracking_reset"; id: string };
