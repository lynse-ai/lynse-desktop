import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
import type {
  FileDetail,
  FileConclusion,
  FileOutline,
  FileTranscription,
  WorkspaceItem,
  PromptTemplateCategory,
  PreSignedUrlVO,
  TransferFileReq,
  TransferFileResult,
  TransStatusMap,
  AiTaskAddReq,
  AiTaskResultVO,
  LocalTranscriptionRecord,
} from "../types";
import {
  getDesktopLocalTranscriptionApi,
  isLocalFileId,
  localRecordToTranscription,
  mergeCloudAndLocalFiles,
} from "../local-transcription";

// Lynse API returns { code, data: [...files], total, msg }
// ApiClient unwraps to the inner data field (the file array)
type FileListResponse = Record<string, unknown>[];
type FilesQueryResult = {
  cloudItems: FileListResponse;
  localRecords: LocalTranscriptionRecord[];
};
type FilesRequest = {
  path: string;
  params: Record<string, string | number | boolean | undefined>;
  includeLocalRecords: boolean;
};

export interface SummaryTabModel {
  key: string;
  id: string;
  name: string;
  text: string;
  status: "ready" | "pending" | "error";
  pendingId?: string;
}

export function sortConclusionsChronologically(conclusions: FileConclusion[]): FileConclusion[] {
  return [...conclusions].sort((left, right) => {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftTime = String(leftRecord.createTime ?? leftRecord.createdAt ?? "");
    const rightTime = String(rightRecord.createTime ?? rightRecord.createdAt ?? "");
    if (leftTime && rightTime && leftTime !== rightTime) return leftTime.localeCompare(rightTime);
    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
}

export function createInfographicSummaryHtml({
  title,
  source,
}: {
  title: string;
  source: string;
}): string {
  const safeTitle = escapeHtml(title);
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const listItems = lines
    .map((line) => line.replace(/^[-*]\s*/, ""))
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");

  return [
    '<section data-summary-template="infographic">',
    `<h1>${safeTitle}</h1>`,
    "<h2>核心发展脉络</h2>",
    `<ul>${listItems}</ul>`,
    "</section>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeTagValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeTagValue(item));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return normalizeTagValue(obj.name ?? obj.label ?? obj.categoryName ?? obj.category);
  }
  if (typeof value !== "string" && typeof value !== "number") return [];
  return String(value)
    .split(/[,\s，、|/]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function parseFileTags(file: Record<string, unknown>): string[] {
  const tags = [
    ...normalizeTagValue(file.tags),
    ...normalizeTagValue(file.tagList),
    ...normalizeTagValue(file.labels),
    ...normalizeTagValue(file.labelList),
    ...normalizeTagValue(file.categoryName),
    ...normalizeTagValue(file.category),
    ...normalizeTagValue(file.folderName),
  ];
  return Array.from(new Set(tags));
}

export function buildFilesRequest(params: {
  pageNum?: number;
  pageSize?: number;
  originalFilename?: string;
  folderId?: string;
}): FilesRequest {
  const baseParams = {
    pageNum: params.pageNum ?? 1,
    pageSize: params.pageSize ?? 100,
  };

  return {
    path: "/api/business/file/page",
    params: {
      ...baseParams,
      originalFilename: params.originalFilename,
    },
    includeLocalRecords: params.folderId !== "__trash__",
  };
}

export function mergePendingSummaryTab({
  tabs,
  pendingId,
  conclusion,
}: {
  tabs: SummaryTabModel[];
  pendingId: string;
  conclusion: FileConclusion;
}): SummaryTabModel[] {
  return tabs.map((tab) => {
    if (tab.pendingId !== pendingId) return tab;
    return {
      key: conclusion.id,
      id: conclusion.id,
      name: String(conclusion.templateName ?? tab.name ?? ""),
      text: conclusion.conclusionText,
      status: "ready",
    };
  });
}

export function useFiles(params: {
  pageNum?: number;
  pageSize?: number;
  originalFilename?: string;
  folderId?: string;
  enabled?: boolean;
}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["files", params],
    queryFn: async () => {
      const request = buildFilesRequest(params);
      const localApi = getDesktopLocalTranscriptionApi();
      const localRecords = localApi && request.includeLocalRecords ? await localApi.list() : [];
      if (!isAuthenticated) return { cloudItems: [], localRecords };

      const data = await api().getWithParams<FileListResponse | Record<string, unknown>>(
        request.path,
        request.params,
      );
      // After unwrapping, data might be the file array directly
      // or an object with list/records/data key
      if (Array.isArray(data)) return { cloudItems: data, localRecords };
      for (const key of ["list", "records", "data"]) {
        const arr = (data as Record<string, unknown>)[key];
        if (Array.isArray(arr)) return { cloudItems: arr, localRecords };
      }
      return { cloudItems: [], localRecords };
    },
    select: (result: FilesQueryResult): WorkspaceItem[] => {
      const cloudItems = result.cloudItems.map((f) => ({
        id: String((f as Record<string, unknown>).id ?? ""),
        type: "file" as const,
        title: String((f as Record<string, unknown>).originalFilename ?? ""),
        updatedAt: String((f as Record<string, unknown>).updateTime ?? ""),
        createdAt: String((f as Record<string, unknown>).createTime ?? ""),
        folderId: (f as Record<string, unknown>).folderId as string | undefined,
        tags: parseFileTags(f as Record<string, unknown>),
      }));
      return mergeCloudAndLocalFiles(cloudItems, result.localRecords);
    },
    enabled: (isAuthenticated || !!getDesktopLocalTranscriptionApi()) && (params.enabled ?? true),
  });
}

export function useFileDetail(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file", fileId],
    queryFn: () =>
      api().getWithParams<FileDetail>("/api/business/file/info", {
        fileId: fileId!,
      }),
    enabled: !!fileId && !isLocalFileId(fileId) && isAuthenticated,
  });
}

export function useFileConclusions(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file-conclusions", fileId],
    queryFn: () =>
      api().getWithParams<FileConclusion[]>("/api/business/file/conclusion/list", {
        fileId: fileId!,
      }),
    enabled: !!fileId && !isLocalFileId(fileId) && isAuthenticated,
  });
}

export function useFileOutline(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file-outline", fileId],
    queryFn: () =>
      api().getWithParams<FileOutline>("/api/business/file/outline/get", {
        fileId: fileId!,
      }),
    enabled: !!fileId && !isLocalFileId(fileId) && isAuthenticated,
  });
}

export function useFileTranscription(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file-transcription", fileId],
    queryFn: async () => {
      if (isLocalFileId(fileId)) {
        const record = await getDesktopLocalTranscriptionApi()?.get(fileId!);
        if (!record) throw new Error("Local transcription not found");
        return localRecordToTranscription(record);
      }
      return api().getWithParams<FileTranscription>("/api/business/file/trans/get", {
        fileId: fileId!,
      });
    },
    enabled: !!fileId && (isLocalFileId(fileId) || isAuthenticated),
  });
}

/**
 * Get a presigned download URL for the file's original audio/media.
 */
export function useFileAudioUrl(fileId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ["file-audio-url", fileId],
    queryFn: async () => {
      if (isLocalFileId(fileId)) {
        return getDesktopLocalTranscriptionApi()?.getAudioUrl(fileId!) ?? null;
      }
      try {
        const data = await api().getWithParams<string>("/api/business/file/presign/download", {
          fileId: fileId!,
        });
        return data;
      } catch {
        return null;
      }
    },
    enabled: !!fileId && (isLocalFileId(fileId) || isAuthenticated),
    staleTime: 5 * 60 * 1000, // presigned URLs expire, but cache for 5 min
    retry: false, // don't retry — endpoint may not exist
  });
}

/** Update a conclusion's text content. */
export function useUpdateConclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conclusionId, conclusionText }: { conclusionId: string; conclusionText: string }) =>
      api().post<unknown>("/api/business/file/conclusion/update", {
        id: conclusionId,
        conclusionText,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-conclusions"] });
    },
  });
}

/** Permanently delete a generated conclusion. */
export function useDeleteConclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conclusionId: string) =>
      api().delete<unknown>(`/api/business/file/conclusion/${encodeURIComponent(conclusionId)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-conclusions"] });
    },
  });
}

export async function replaceSummaryTemplate({
  fileId,
  oldConclusionId,
  templateId,
  startAiTask = (req) => api().post<string>("/api/business/file/ai", req),
  waitForResult = (args) => waitForAiTaskResult(args),
  deleteConclusion = (conclusionId) =>
    api().delete<unknown>(`/api/business/file/conclusion/${encodeURIComponent(conclusionId)}`),
}: {
  fileId: string;
  oldConclusionId: string;
  templateId: string;
  startAiTask?: (req: AiTaskAddReq) => Promise<string>;
  waitForResult?: (args: { fileId: string; taskId: string; aiTaskType: "CONCLUSION" }) => Promise<AiTaskResultVO>;
  deleteConclusion?: (conclusionId: string) => Promise<unknown>;
}): Promise<AiTaskResultVO> {
  const aiTaskType = "CONCLUSION";
  const taskId = await startAiTask({ aiTaskType, fileId, templateId });
  const result = await waitForResult({ fileId, taskId, aiTaskType });
  await deleteConclusion(oldConclusionId);
  return result;
}

/** Replace one summary tab with a newly generated summary using another template. */
export function useReplaceSummaryTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { fileId: string; oldConclusionId: string; templateId: string }) =>
      replaceSummaryTemplate(req),
    onSuccess: (_data, req) => {
      qc.invalidateQueries({ queryKey: ["file-conclusions", req.fileId] });
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useInvalidateOnAuth() {
  const queryClient = useQueryClient();

  return function invalidateAll() {
    queryClient.invalidateQueries();
  };
}

// ── Template & Upload pipeline hooks ─────────────────────

/** Fetch all prompt template categories (50+ templates). */
export function useTemplateCategories() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: ["template-categories"],
    queryFn: () =>
      api().get<PromptTemplateCategory[]>("/api/business/translate/prompt/categories"),
    enabled: isAuthenticated,
    staleTime: 10 * 60 * 1000, // templates rarely change
  });
}

/**
 * Upload a file to OSS via presigned URL, then notify the backend.
 * Returns the fileId assigned by the server.
 */
export async function uploadFileToOSS(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<string> {
  // 1. Get presigned URL
  const presign = await api().post<PreSignedUrlVO>(
    "/api/business/file/presign/upload",
    { originalFilename: file.name, fileSize: file.size },
  );
  const { url, headers, fileId } = presign;

  // 2. Upload file directly to OSS
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    // Apply presigned headers (e.g., x-oss-*, Content-Type)
    for (const [k, v] of Object.entries(headers ?? {})) {
      xhr.setRequestHeader(k, v);
    }
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`OSS upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("OSS upload network error"));
    xhr.send(file);
  });

  // 3. Notify backend that upload is complete
  await api().getWithParams("/api/business/file/upload/notify", { fileId });

  return fileId;
}

/** Trigger transcription + summarization pipeline for an uploaded file. */
export function useTransferFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: TransferFileReq) =>
      api().post<TransferFileResult>("/api/business/file/trans", req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

/**
 * Poll transcription/summarization status for a set of files.
 * Polls every 3s until all statuses are terminal (completed/failed).
 */
export function useTranscriptionStatus(fileIds: string[]) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const enabled = fileIds.length > 0 && isAuthenticated;

  return useQuery({
    queryKey: ["trans-status", fileIds],
    queryFn: () =>
      api().post<TransStatusMap>("/api/business/file/trans/status", {
        fileIds,
      }),
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data as TransStatusMap | undefined;
      if (!data) return 3000;
      // Stop polling when all files are in terminal state
      const allDone = fileIds.every((id) => {
        const status = getTranscriptionStatus(data[id]);
        return isCompletedStatus(status) || isFailedStatus(status);
      });
      return allDone ? false : 3000;
    },
  });
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_POLL_ATTEMPTS = 60;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(status: unknown): string {
  return String(status ?? "").trim().toLowerCase();
}

function getTranscriptionStatus(entry: TransStatusMap[string] | undefined): unknown {
  return typeof entry === "object" && entry !== null ? entry.status : entry;
}

function isCompletedStatus(status: unknown): boolean {
  return ["completed", "complete", "success", "succeeded", "done", "finished", "1"].includes(
    normalizeStatus(status),
  );
}

function isFailedStatus(status: unknown): boolean {
  return ["failed", "failure", "error", "errored", "canceled", "cancelled", "-1"].includes(
    normalizeStatus(status),
  );
}

export async function waitForTranscriptionCompletion({
  fileIds,
  getStatus = (ids) => api().post<TransStatusMap>("/api/business/file/trans/status", { fileIds: ids }),
  sleep: wait = sleep,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
}: {
  fileIds: string[];
  getStatus?: (fileIds: string[]) => Promise<TransStatusMap>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
}): Promise<TransStatusMap> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const data = await getStatus(fileIds);
    const statuses = fileIds.map((id) => getTranscriptionStatus(data[id]));
    const failed = statuses.find(isFailedStatus);
    if (failed) {
      // Surface the backend's detailed reason: TransFileStatus carries extra
      // fields (errorMsg / message / reason …) that the caller otherwise drops.
      const failedEntries = fileIds
        .map((id) => data[id])
        .filter((entry) => isFailedStatus(getTranscriptionStatus(entry)));
      const detail = failedEntries
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) return "";
          const rest = { ...entry } as Record<string, unknown>;
          delete rest.status;
          return JSON.stringify(rest);
        })
        .filter(Boolean)
        .join(" | ");
      throw new Error(
        `Transcription failed: ${String(failed)}${detail ? ` — ${detail}` : ""}`,
      );
    }
    if (statuses.length > 0 && statuses.every(isCompletedStatus)) return data;
    if (attempt < maxAttempts - 1) await wait(intervalMs);
  }
  throw new Error(
    `Transcription did not complete in time (fileIds: ${fileIds.join(", ")}; waited ~${Math.round(
      (maxAttempts * intervalMs) / 1000,
    )}s)`,
  );
}

export async function waitForAiTaskResult({
  fileId,
  taskId,
  aiTaskType,
  getResult = (body) => api().post<AiTaskResultVO>("/api/business/file/ai/result", body),
  sleep: wait = sleep,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
}: {
  fileId: string;
  taskId: string;
  aiTaskType: string;
  getResult?: (body: { fileId: string; taskId: string; aiTaskType: string }) => Promise<AiTaskResultVO | null>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
}): Promise<AiTaskResultVO> {
  const body = { fileId, taskId, aiTaskType };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let result: AiTaskResultVO | null;
    try {
      result = await getResult(body);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 1001)) throw error;
      if (attempt < maxAttempts - 1) await wait(intervalMs);
      continue;
    }
    if (!result) {
      if (attempt < maxAttempts - 1) await wait(intervalMs);
      continue;
    }
    if (isFailedStatus(result.status) || isFailedStatus(result.conclusion?.status)) {
      throw new Error(`AI task failed: ${String(result.status ?? "unknown")}`);
    }
    if (
      isCompletedStatus(result.status) ||
      result.conclusion?.generateSuccess === true ||
      (typeof result.conclusion?.conclusionText === "string" &&
        result.conclusion.conclusionText.trim().length > 0)
    ) {
      return result;
    }
    if (attempt < maxAttempts - 1) await wait(intervalMs);
  }
  throw new Error("AI task did not complete in time");
}

export async function waitForConclusionCompletion({
  fileId,
  previousConclusions,
  getConclusions = (params) =>
    api().getWithParams<FileConclusion[]>("/api/business/file/conclusion/list", params),
  sleep: wait = sleep,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
}: {
  fileId: string;
  previousConclusions: FileConclusion[];
  getConclusions?: (params: { fileId: string }) => Promise<FileConclusion[]>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
}): Promise<FileConclusion> {
  const params = { fileId };
  const previousVersions = new Set(previousConclusions.map(conclusionVersion));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let conclusions: FileConclusion[];
    try {
      conclusions = await getConclusions(params);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 1001)) throw error;
      if (attempt < maxAttempts - 1) await wait(intervalMs);
      continue;
    }
    const changedConclusions = conclusions.filter(
      (conclusion) => !previousVersions.has(conclusionVersion(conclusion)),
    );
    for (const conclusion of changedConclusions) {
      const status = conclusion.status;
      if (isFailedStatus(status)) {
        throw new Error(`Summary generation failed: ${String(status ?? "unknown")}`);
      }
      if (
        conclusion.generateSuccess === true ||
        isCompletedStatus(status) ||
        (typeof conclusion.conclusionText === "string" && conclusion.conclusionText.trim().length > 0)
      ) {
        return conclusion;
      }
    }
    if (attempt < maxAttempts - 1) await wait(intervalMs);
  }
  throw new Error("Summary generation did not complete in time");
}

function conclusionVersion(conclusion: FileConclusion): string {
  return JSON.stringify([
    conclusion.id,
    conclusion.conclusionText,
    conclusion.status,
    conclusion.generateSuccess,
    conclusion.taskId,
    conclusion.againTaskId,
    conclusion.updateTime,
    conclusion.templateId,
  ]);
}

/** Add a new summary for an existing file without re-transcribing. */
export function useAddSummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (req: AiTaskAddReq) => {
      const taskId = await api().post<string>("/api/business/file/ai", req);
      return waitForAiTaskResult({
        fileId: req.fileId,
        taskId,
        aiTaskType: req.aiTaskType,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-conclusions"] });
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

/** Re-run file processing and wait for the summary produced by that task. */
export async function rerunSummaryPipeline({
  req,
  getCurrentConclusions = (params) =>
    api().getWithParams<FileConclusion[]>("/api/business/file/conclusion/list", params),
  startProcessing = (request) =>
    api().post<TransferFileResult>("/api/business/file/trans", request),
  waitForProcessing = (args) => waitForTranscriptionCompletion(args),
  waitForConclusion = (args) => waitForConclusionCompletion(args),
}: {
  req: TransferFileReq;
  getCurrentConclusions?: (params: { fileId: string }) => Promise<FileConclusion[]>;
  startProcessing?: (req: TransferFileReq) => Promise<TransferFileResult>;
  waitForProcessing?: (args: {
    fileIds: string[];
    intervalMs: number;
    maxAttempts: number;
  }) => Promise<TransStatusMap>;
  waitForConclusion?: (args: {
    fileId: string;
    previousConclusions: FileConclusion[];
    intervalMs: number;
    maxAttempts: number;
  }) => Promise<FileConclusion>;
}): Promise<AiTaskResultVO> {
  const previousConclusions = await getCurrentConclusions({ fileId: req.fileId });
  const task = await startProcessing(req);
  await waitForProcessing({
    fileIds: [req.fileId],
    intervalMs: 5000,
    maxAttempts: 240,
  });
  const conclusion = await waitForConclusion({
    fileId: req.fileId,
    previousConclusions,
    intervalMs: 5000,
    maxAttempts: 240,
  });
  return { status: "COMPLETED", taskId: task.taskId, conclusion };
}

export function useRerunSummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: TransferFileReq) => rerunSummaryPipeline({ req }),
    onSuccess: (data, req) => {
      qc.invalidateQueries({ queryKey: ["files"] });
      if (data.conclusion) {
        qc.setQueryData(["file-conclusions", req.fileId], [data.conclusion]);
      } else {
        qc.invalidateQueries({ queryKey: ["file-conclusions", req.fileId] });
      }
    },
  });
}
