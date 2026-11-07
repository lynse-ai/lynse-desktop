import type { ApiClient, SummarizeTranscriptResult } from "@lynse/core/api";
import { ApiError, MAX_SUMMARY_IMAGE_MARKS } from "@lynse/core/api";
import { formatLocalTimestamp } from "./local-transcription";
import type { FileDetail } from "./types";

// Match the meeting-pipeline endpoint's input bounds.
export const MIN_SUMMARY_TRANSCRIPT_CHARS = 100;
export const MAX_SUMMARY_TRANSCRIPT_CHARS = 500_000;
const SUMMARY_TIMEOUT_MS = 330_000;
export type LynclawSummaryFormat = "markdown" | "html";

export class LynclawSummaryError extends Error {}

export function logLynclawSummaryFailure(stage: string, format: LynclawSummaryFormat, error: unknown) {
  // Keep credentials, transcripts, and remote error bodies out of desktop logs.
  console.warn("[lynclaw-summary] failed", {
    stage,
    format,
    status: error instanceof ApiError ? error.status : undefined,
    code: error instanceof LynclawSummaryError ? error.message : undefined,
    kind: error instanceof Error ? error.name : typeof error,
  });
}

export function summaryTimeout(format: LynclawSummaryFormat): number {
  return format === "html" ? SUMMARY_TIMEOUT_MS * 2 : SUMMARY_TIMEOUT_MS;
}

// The cloud insert API persists only the body. Preserve the source and format
// across fetches and edits using an invisible Markdown/HTML comment.
export function encodeLynclawSummary(format: LynclawSummaryFormat, body: string): string {
  return `<!-- lynclaw-summary:${format} -->\n\n${body}`;
}

export function readLynclawSummary(stored: string): { format: LynclawSummaryFormat; body: string } | null {
  const marker = stored.match(/^<!-- lynclaw-summary:(markdown|html) -->(?:\r?\n){1,2}/);
  if (!marker) return null;
  return { format: marker[1] === "html" ? "html" : "markdown", body: stored.slice(marker[0].length) };
}

export function summaryOutput(result: SummarizeTranscriptResult, format: LynclawSummaryFormat): string {
  if (format === "html") {
    const html = result.html?.trim();
    if (!html || !/^<!doctype\s+html\s*>/i.test(html) || !/<\/html>$/i.test(html)) {
      throw new LynclawSummaryError("workspace.lynclaw_summary_html_failed");
    }
    return html;
  }
  const markdown = result.content.trim();
  if (!markdown) throw new LynclawSummaryError("resummarize.error_title");
  return markdown;
}

export function formatSummaryRecordingTime(startedAt: string | undefined): string | undefined {
  if (!startedAt) return undefined;
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

export function isPlaybackTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatPlaybackTime(ms: number): string {
  return `${formatLocalTimestamp(ms)}.${String(Math.floor(ms) % 1000).padStart(3, "0")}`;
}

export function formatTimedSummaryTranscript(
  rows: readonly { text: string; translatedText?: string; speaker?: string | null; startMs?: number; endMs?: number }[],
  original: string,
): string {
  let hasTime = false;
  const lines: string[] = [];
  for (const row of rows) {
    const text = row.text.trim();
    const translation = row.translatedText?.trim();
    const content = (translation && translation !== text ? `${text} ${translation}` : text).replace(/\s+/g, " ");
    if (!content) continue;

    let prefix = "";
    if (isPlaybackTime(row.startMs)) {
      hasTime = true;
      const start = formatPlaybackTime(row.startMs);
      const end = isPlaybackTime(row.endMs) && row.endMs >= row.startMs ? `-${formatPlaybackTime(row.endMs)}` : "";
      prefix = `[${start}${end}] `;
    }
    lines.push(`${prefix}${row.speaker ? `${row.speaker}: ` : ""}${content}`);
  }
  const transcript = lines.join("\n");
  return hasTime && transcript.length >= MIN_SUMMARY_TRANSCRIPT_CHARS && transcript.length <= MAX_SUMMARY_TRANSCRIPT_CHARS
    ? transcript : original;
}

export async function readSummaryMarks(
  detail: FileDetail,
  client: ApiClient,
  request: Parameters<ApiClient["getWithParams"]>[2],
) {
  const text = Array.isArray(detail.recordMarkResults)
    ? detail.recordMarkResults.filter((mark) =>
      (typeof mark?.title === "string" && mark.title.trim())
      || (typeof mark?.outline === "string" && mark.outline.trim()))
    : [];
  const photos = Array.isArray(detail.markImages)
    ? detail.markImages.filter((photo) => typeof photo?.imageId === "string" && photo.imageId.trim())
      .slice(0, MAX_SUMMARY_IMAGE_MARKS)
    : [];
  const images = await Promise.all(photos.map(async ({ imageId, timestamp, timeoffset, url }) => {
    // The stored URL can expire before generation. Sign under the same session.
    const signed = await client.getWithParams<string | { url?: string }>(
      "/api/business/file/mark/image/presign/download", { imageId }, request,
    ).catch(() => undefined);
    const signedUrl = typeof signed === "string" ? signed : signed?.url;
    const link = typeof signedUrl === "string" && signedUrl.trim() ? signedUrl : url;
    return {
      imageId,
      timestamp: isPlaybackTime(timestamp) ? timestamp : undefined,
      timeoffset: isPlaybackTime(timeoffset) ? timeoffset : undefined,
      url: typeof link === "string" ? link.trim() || undefined : undefined,
    };
  }));
  return { text, images };
}
