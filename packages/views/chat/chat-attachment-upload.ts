import { uploadFileToOSS } from "../workspace/hooks/use-files";

/**
 * Attachment support for the chat composer "+" button.
 *
 * Files are uploaded straight to the existing cloud storage pipeline
 * (`uploadFileToOSS` → presign → OSS PUT → notify) WITHOUT triggering the
 * transcription/summary flow used for audio imports — the returned fileId is
 * simply attached to the next chat message's `fileIds`, which is the same
 * channel @/# mentions use to scope retrieval.
 */

/** One file picked via the "+" button, tracked from pick → upload → sent. */
export interface AttachmentDraft {
  localId: string;
  file: File;
  name: string;
  size: number;
  /** "image" | "pdf" | "doc" — drives icon/preview rendering. */
  kind: AttachmentKind;
  /** Local object URL for image previews (undefined for documents). */
  previewUrl?: string;
  status: "uploading" | "ready" | "error";
  /** OSS upload progress in percent (while `status === "uploading"`). */
  progress: number;
  /** Backend file id once the upload completed. */
  fileId?: string;
}

/** Extensions accepted by the "+" picker: images + documents (pdf/md/word/…). */
export const ATTACHMENT_ACCEPT_ATTR = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".pdf", ".md", ".markdown", ".txt", ".csv",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".html", ".htm", ".rtf",
].join(",");

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export type AttachmentKind = "image" | "pdf" | "doc";

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Kind used to pick the draft/icon rendering (and the user-bubble chip). */
export function attachmentKind(name: string, type?: string): AttachmentKind {
  const ext = fileExtension(name);
  if (IMAGE_EXTENSIONS.has(ext) || (type ?? "").startsWith("image/")) return "image";
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  return "doc";
}

export function isAcceptedAttachment(file: File): boolean {
  const ext = fileExtension(file.name);
  if (!ext) return (file.type ?? "").startsWith("image/");
  return ATTACHMENT_ACCEPT_ATTR.split(",").includes(`.${ext}`);
}

export function isAttachmentTooLarge(file: File): boolean {
  return file.size > MAX_ATTACHMENT_BYTES;
}

/** Upload one attachment and resolve to the backend fileId — no transcription. */
export async function uploadChatAttachment(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<string> {
  return uploadFileToOSS(file, onProgress);
}

/** Mention ids + uploaded attachment ids, order-stable and deduplicated. */
export function mergeContextFileIds(groups: (string | undefined)[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const id of group) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

/** Compact byte size for the attachment tray ("1.2 MB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function makeLocalId(): string {
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
