// ───────────────────────────────────────────────────────────────
// Cloud-sync upload chain (client-direct OSS upload, "三分离" link).
//
// The client pushes audio bytes straight to OSS; the backend only creates
// the placeholder, hands out STS credentials, and records the final URL.
// Three API steps, strictly in order:
//   1. POST /api/business/file/sync/pre/create — upsert the placeholder
//      (dting_file + dting_file_pre) keyed by the client-generated fileId.
//      Idempotent: re-running it with the same fileId is the documented
//      resume/retry path.
//   2. POST /api/business/file/sync/pre/sts — returns the OSS target
//      (bucket/endpoint/objectKey with a server-generated UUID name) plus
//      Aliyun STS temporary credentials.
//   3. PUT the bytes to OSS signed with the STS pair (OSS V1 header
//      signature). No presigned URL, no backend relay. The PUT runs in the
//      Rust shell (`sync_upload.rs`): a signed header set is not something a
//      webview can send cross-origin, and the renderer never needs the bytes.
//   4. GET /api/business/file/sync/pre/notify — moves the OSS address from
//      the placeholder onto the real file record. Idempotent.
// ───────────────────────────────────────────────────────────────

import { ApiError, api } from "@lynse/core/api/client";
import type { StsTokenVO, SyncPreUploadReq } from "./types";

/** The gateway answers every failure in this chain with the same opaque
 *  `system.error.busy`, and `String(error)` drops the code that would tell the
 *  steps apart — so name the step and keep the code. */
async function chainStep<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${label}失败：${describeError(error)}`);
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const data = error.data === undefined ? "" : ` ${truncate(JSON.stringify(error.data))}`;
    return `code ${error.status} ${error.message}${data}`;
  }
  return truncate(error instanceof Error ? error.message : String(error));
}

function truncate(value: string, maxChars = 400): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/** Rust-side transport for step 3. The audio is addressed by its local
 *  record id so the renderer cannot name an arbitrary path on disk. */
export interface DesktopCloudSyncApi {
  /** Byte size of the record's audio — `fileSize` on the placeholder. */
  audioSize: (recordId: string) => Promise<number>;
  putSignedFile: (put: {
    recordId: string;
    bucket: string;
    endpoint: string;
    objectKey: string;
    accessKeyId: string;
    accessKeySecret: string;
    securityToken: string;
    contentType: string;
  }) => Promise<{ sizeBytes: number }>;
}

export function getDesktopCloudSyncApi(): DesktopCloudSyncApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & { desktopAPI?: { cloudSync?: DesktopCloudSyncApi } };
  return desktopWindow.desktopAPI?.cloudSync ?? null;
}

/** Re-request credentials that expire within a minute — a large upload
 *  would otherwise outlive them mid-flight. */
const STS_EXPIRY_MARGIN_MS = 60_000;

/** 32-hex-char id in the same shape the backend hands out (UUID sans
 *  dashes), used as the client-generated fileId. */
export function generateSyncFileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  let hex = "";
  for (let i = 0; i < 32; i += 1) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return hex;
}

export interface SyncChainUploadInput {
  /** Local transcription record id — Rust reads the audio from disk. */
  recordId: string;
  /** Saved filename including extension. */
  saveFilename: string;
  /** MIME type; becomes both the OSS Content-Type and the recorded one. */
  contentType?: string;
  /** Client-generated fileId; generated when omitted. Pass the same id on
   *  every retry of the same recording (see SyncPreUploadReq). */
  fileId?: string;
  /** Audio duration in whole seconds (bizDuration). */
  bizDuration: number;
  /** Recording start time, "yyyy-MM-dd HH:mm:ss" (GMT+8). */
  recordStartTime?: string;
  folderId?: string;
  mode?: string;
}

/** Run the whole chain — create → sts → direct OSS PUT → notify — and
 *  return the fileId the backend knows the recording under. */
export async function uploadAudioViaSyncChain(
  input: SyncChainUploadInput,
): Promise<string> {
  const transport = getDesktopCloudSyncApi();
  if (!transport) throw new Error("云端上传仅在桌面端可用");
  const contentType = input.contentType ?? "application/octet-stream";
  const fileId = input.fileId ?? generateSyncFileId();
  const fileSize = await transport.audioSize(input.recordId);
  const req: SyncPreUploadReq = {
    fileId,
    saveFilename: input.saveFilename,
    fileSize,
    bizDuration: input.bizDuration,
    contentType,
    ...(input.folderId ? { folderId: input.folderId } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.recordStartTime ? { recordStartTime: input.recordStartTime } : {}),
  };

  // 1. Placeholder upsert (safe to re-run on retry).
  await chainStep("创建云端占位 /sync/pre/create", () =>
    api().post("/api/business/file/sync/pre/create", req),
  );

  // 2. STS credentials + the server-generated upload target. objectKey is
  //    authoritative — never assembled on the client.
  const requestSts = () =>
    chainStep("获取上传凭证 /sync/pre/sts", () =>
      api().post<StsTokenVO>("/api/business/file/sync/pre/sts", req),
    );
  let sts = await requestSts();
  if (new Date(sts.expiration).getTime() - Date.now() < STS_EXPIRY_MARGIN_MS) {
    sts = await requestSts();
  }
  if (!sts.bucket || !sts.endpoint || !sts.objectKey) {
    throw new Error("sync/pre/sts 未返回有效的上传目标");
  }

  // 3. Direct PUT to OSS — the server never relays the bytes.
  await transport.putSignedFile({
    recordId: input.recordId,
    bucket: sts.bucket,
    endpoint: sts.endpoint,
    objectKey: sts.objectKey,
    accessKeyId: sts.accessKeyId,
    accessKeySecret: sts.accessKeySecret,
    securityToken: sts.securityToken,
    contentType,
  });

  // 4. Completion notice (idempotent — silently succeeds on re-sync).
  await chainStep("通知上传完成 /sync/pre/notify", () =>
    api().getWithParams("/api/business/file/sync/pre/notify", { fileId }),
  );

  return fileId;
}

/** Format an instant as "yyyy-MM-dd HH:mm:ss" in GMT+8 — the backend's
 *  recordStartTime convention. Empty string for unparseable input. */
export function formatRecordStartTime(iso: string | number | Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}
