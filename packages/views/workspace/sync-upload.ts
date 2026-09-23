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
//      signature). No presigned URL, no backend relay.
//   4. GET /api/business/file/sync/pre/notify — moves the OSS address from
//      the placeholder onto the real file record. Idempotent.
// ───────────────────────────────────────────────────────────────

import { api } from "@lynse/core/api/client";
import type { StsTokenVO, SyncPreUploadReq } from "./types";

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

/** OSS V1 signature: base64(HMAC-SHA1(accessKeySecret, stringToSign)). */
async function signOssRequest(
  accessKeySecret: string,
  stringToSign: string,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto unavailable — cannot sign the OSS upload");
  }
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(accessKeySecret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign("HMAC", key, encoder.encode(stringToSign));
  let binary = "";
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** PUT the blob to `https://{bucket}.{endpoint}/{objectKey}`. With STS the
 *  Authorization header is signed by the client; the security token rides
 *  along as `x-oss-security-token` and joins the canonical headers. */
async function putToOss(
  sts: StsTokenVO,
  body: Blob,
  contentType: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const endpoint = sts.endpoint.replace(/^https?:\/\//, "");
  const url = `https://${sts.bucket}.${endpoint}/${sts.objectKey}`;
  const date = new Date().toUTCString();
  // V1 string-to-sign: VERB \n Content-MD5 \n Content-Type \n Date \n
  // canonicalized x-oss-* headers \n canonicalized resource (bucket-prefixed
  // even in virtual-hosted style).
  const stringToSign = [
    "PUT",
    "",
    contentType,
    date,
    `x-oss-security-token:${sts.securityToken}`,
    `/${sts.bucket}/${sts.objectKey}`,
  ].join("\n");
  const signature = await signOssRequest(sts.accessKeySecret, stringToSign);

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Authorization", `OSS ${sts.accessKeyId}:${signature}`);
    xhr.setRequestHeader("x-oss-security-token", sts.securityToken);
    xhr.setRequestHeader("Date", date);
    xhr.setRequestHeader("Content-Type", contentType);
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        const detail =
          typeof xhr.responseText === "string" ? xhr.responseText.slice(0, 800) : "";
        reject(new Error(`OSS 上传失败 (HTTP ${xhr.status}): ${detail}`));
      }
    };
    xhr.ontimeout = () => reject(new Error("OSS 上传超时"));
    xhr.onerror = () =>
      reject(
        new Error(
          "OSS 上传网络错误（可能是 OSS 跨域 CORS 未放行该来源，或网络不可达）",
        ),
      );
    xhr.send(body);
  });
}

export interface SyncChainUploadInput {
  /** Audio content to upload. */
  file: Blob;
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
  onProgress?: (pct: number) => void;
}

/** Run the whole chain — create → sts → direct OSS PUT → notify — and
 *  return the fileId the backend knows the recording under. */
export async function uploadAudioViaSyncChain(
  input: SyncChainUploadInput,
): Promise<string> {
  const contentType = input.contentType ?? "application/octet-stream";
  const fileId = input.fileId ?? generateSyncFileId();
  const req: SyncPreUploadReq = {
    fileId,
    saveFilename: input.saveFilename,
    fileSize: input.file.size,
    bizDuration: input.bizDuration,
    contentType,
    ...(input.folderId ? { folderId: input.folderId } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.recordStartTime ? { recordStartTime: input.recordStartTime } : {}),
  };

  // 1. Placeholder upsert (safe to re-run on retry).
  await api().post("/api/business/file/sync/pre/create", req);

  // 2. STS credentials + the server-generated upload target. objectKey is
  //    authoritative — never assembled on the client.
  let sts = await api().post<StsTokenVO>("/api/business/file/sync/pre/sts", req);
  if (new Date(sts.expiration).getTime() - Date.now() < STS_EXPIRY_MARGIN_MS) {
    sts = await api().post<StsTokenVO>("/api/business/file/sync/pre/sts", req);
  }
  if (!sts.bucket || !sts.endpoint || !sts.objectKey) {
    throw new Error("sync/pre/sts 未返回有效的上传目标");
  }

  // 3. Direct PUT to OSS — the server never relays the bytes.
  await putToOss(sts, input.file, contentType, input.onProgress);

  // 4. Completion notice (idempotent — silently succeeds on re-sync).
  await api().getWithParams("/api/business/file/sync/pre/notify", { fileId });

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
