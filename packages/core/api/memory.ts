import { api, ApiError } from "./client";

export interface KnowledgePolicy {
  enrolled: boolean;
  range_version: number;
  grant_version: number;
  processing_version: number;
  folder_ids: string[];
  include_unfiled: boolean;
  excluded_source_ids: string[];
  memory_consent: boolean;
  local_text_consent: boolean;
  chat_consent: boolean;
  email_consent: boolean;
  notifications_consent: boolean;
  extraction_paused: boolean;
  projections_enabled: boolean;
  timezone: string;
}

export interface MemoryCapabilities {
  user_id: string;
  protocol_version: number;
  available: boolean;
  features: Record<string, boolean>;
  policy: KnowledgePolicy | null;
  todo_four_states: boolean;
  projections: boolean;
}

export interface MemoryRecord {
  id: string;
  revision: number;
  content: string;
  status: string;
  target: string;
  memory_type: string;
  scope_type: string;
  scope_id: string;
  supersedes_id?: string;
  evidence_dependencies?: { parent_id: string; parent_revision: number; excerpt: string; fragment_id?: string }[];
  eligibility: { usable: boolean; reasons: string[] };
  provenance?: { statement_origin?: string; knowledge?: { modality?: string; scene?: string } };
}

export interface MemoryProjection {
  id: string;
  view: string;
  day: string;
  version: number;
  readonly: true;
  coverage_cutoff: string;
  coverage: { included: number; eligible: number; omitted: number };
  failures: string[];
  blocks: { memory_id: string; revision: number; content: string; category: string; scope_id: string; modality: string }[];
}

export interface MemoryPreview {
  preview_id: string;
  items: { id: string; revision: number; fingerprint: string }[];
}

export interface ForgetPreview {
  plan_id: string;
  manifest_hash: string;
  items: { id: string; revision: number; fingerprint: string }[];
  blocked_source_count?: number;
  affected_file_paths?: string[];
  source_isolation?: "whole_source";
  preserves_original_sources: boolean;
  preserves_wiki_browsing: boolean;
}

export interface ForgetStatus {
  plan_id: string;
  state: "preview" | "stopped" | "cleaning" | "complete";
  stopped_using: boolean;
  cloud_cleanup_complete: boolean;
  device_sync: "pending" | "complete";
  processed: number;
  total: number;
}

export interface MemoryFileMember {
  id: string;
  revision: number;
  content: string;
  status: string;
  updatedAt?: string;
  sources: { parent_type: string; parent_id: string; parent_revision: number; excerpt: string }[];
  eligibility: { usable: boolean; reasons: string[] };
}

export interface MemoryFileDescriptor {
  path: string;
  title: string;
  revision: string;
  editable: boolean;
  folder?: string;
  aliases?: string[];
  pendingCount?: number;
  updatedAt?: string;
  searchText?: string;
  recordIds: string[];
}

export interface MemoryFileDocument extends MemoryFileDescriptor {
  markdown: string;
  members: MemoryFileMember[];
  pendingUpdates: MemoryFileMember[];
}

export type MemoryFileOrganization = { path: string; revision: string } & (
  { action: "rename"; title: string } | { action: "move"; folder: string } |
  { action: "merge"; target_path: string; target_revision: string } |
  { action: "split"; title: string; record_ids: string[] }
);

/** Frozen IDs belong to a user action and are reused only for the same payload. */
export function memoryOperationId(): string {
  return `memory-${crypto.randomUUID()}`;
}

async function request<T>(path: string, body?: unknown, operationId?: string, signal?: AbortSignal): Promise<T> {
  const client = api();
  const origin = client.getBaseUrl();
  const agent = client.getAgentBaseUrl();
  const session = client.getToken();
  if (!session) throw new ApiError(401, "Sign in to manage memory");
  await client.ensureAgentSession();
  if (client.getToken() !== session || client.getBaseUrl() !== origin || client.getAgentBaseUrl() !== agent) throw new ApiError(401, "Session changed");
  const direct = !!client.getAgentBaseUrl();
  const options = {
    baseUrl: client.getAgentBaseUrl() ?? client.getBaseUrl(),
    tokenOnly: true,
    authScope: "assistant" as const,
    sessionToken: session,
    signal,
    headers: operationId ? { "Operation-Id": operationId } : undefined,
  };
  const target = `${direct ? "/api/memory" : "/api/business/ai/memory"}${path}`;
  const response = body === undefined ? await client.get<T>(target, options) : await client.post<T>(target, body, options);
  if (client.getToken() !== session || client.getBaseUrl() !== origin || client.getAgentBaseUrl() !== agent) throw new ApiError(401, "Session changed");
  return response;
}

export const memoryApi = {
  files: (signal?: AbortSignal) => request<{ files: MemoryFileDescriptor[] }>("/files", undefined, undefined, signal),
  readFile: (path: string, signal?: AbortSignal) => request<MemoryFileDocument>(`/files/read?path=${encodeURIComponent(path)}`, undefined, undefined, signal),
  saveFile: (body: { path: string; revision: string; markdown: string }, operationId: string) => request<MemoryFileDocument>("/files/save", { ...body, operation_id: operationId }, operationId),
  createFile: (title: string, operationId: string) => request<MemoryFileDocument>("/files/create", { title, operation_id: operationId }, operationId),
  organizeFile: (body: MemoryFileOrganization, operationId: string) => request<MemoryFileDocument>("/files/organize", { ...body, operation_id: operationId }, operationId),
  removeEmptyFile: (path: string, revision: string, operationId: string) => request<{ status: string }>("/files/organize", { action: "delete_empty", path, revision, operation_id: operationId }, operationId),
  projections: (view: string, offset = 0, signal?: AbortSignal) => request<{ projections: MemoryProjection[]; total: number }>(`/projections/${encodeURIComponent(view)}?offset=${offset}&limit=25`, undefined, undefined, signal),
  sourceEligibility: (sources: { source_id: string; folder_id?: string; local?: boolean }[]) => request<{ allowed_source_ids: string[] }>("/source-eligibility", { sources }),
  knownSourceEligibility: (source_ids: string[]) => request<{ allowed_source_ids: string[] }>("/source-eligibility", { source_ids }),
  capabilities: (signal?: AbortSignal) => request<MemoryCapabilities>("/capabilities", undefined, undefined, signal),
  list: (status: string, offset = 0, signal?: AbortSignal) => request<{ records: MemoryRecord[]; total: number }>(`/records?view=management&status=${encodeURIComponent(status)}&offset=${offset}&limit=50`, undefined, undefined, signal),
  explain: (id: string, signal?: AbortSignal) => request<MemoryRecord>(`/records/${encodeURIComponent(id)}/explain`, undefined, undefined, signal),
  action: (body: { action: "add" | "replace" | "reject"; record_id?: string; expected_revision?: number; content?: string; scene?: "work" }, operationId: string) => request<{ status: string; record?: MemoryRecord }>("/actions", body, operationId),
  previewConfirmation: (ids: string[], operationId: string) => request<MemoryPreview>("/confirmation-previews", { record_ids: ids }, operationId),
  confirm: (previewId: string, operationId: string) => request<{ status: string }>("/confirm-preview", { preview_id: previewId }, operationId),
  previewForget: (ids: string[], operationId: string) => request<ForgetPreview>("/forget-plans", { record_ids: ids }, operationId),
  forget: (preview: ForgetPreview, operationId: string) => request<ForgetStatus>(`/forget-plans/${encodeURIComponent(preview.plan_id)}/execute`, { manifest_hash: preview.manifest_hash }, operationId),
  forgetStatus: (id: string, signal?: AbortSignal) => request<ForgetStatus>(`/forget-plans/${encodeURIComponent(id)}`, undefined, undefined, signal),
  savePolicy: (current: KnowledgePolicy, changes: Partial<KnowledgePolicy>, operationId: string) => request<{ knowledge: KnowledgePolicy }>("/preferences/actions", { knowledge: {
    ...changes, base_range_version: current.range_version, base_grant_version: current.grant_version,
    base_processing_version: current.processing_version,
  } }, operationId),
};
