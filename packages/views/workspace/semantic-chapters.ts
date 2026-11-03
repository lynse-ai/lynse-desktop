import type { ChapterUtterance, GeneratedChapter, GenerateChaptersResult } from "@lynse/core/api";
import type { ChapterDocument, SemanticChapter } from "./types";

// Server-side limits mirrored from lynclaw runtime/http_chapters.py — the
// client pre-checks so the user gets a precise message before the round trip.
export const MIN_TRANSCRIPT_CHARS = 100;
export const MAX_TRANSCRIPT_CHARS = 500_000;

/** The canonical segment shape chapters work on: the cleaned, playback-ordered
 *  view records (localRecordToTranscription output). Generation and staleness
 *  checks MUST use this same shape or the hashes diverge. */
export interface ChapterSegment {
  id: string;
  text: string;
  startMs?: number;
  endMs?: number;
  speaker?: string | null;
}

/**
 * Normalize view segments into engine utterances: playback order is kept
 * as-is, empty rows drop, timestamps pass through as nullable so a missing
 * timestamp only costs seekability. Throws with a message key when the
 * transcript is out of bounds.
 */
export function buildUtterances(segments: ChapterSegment[]): ChapterUtterance[] {
  const utterances: ChapterUtterance[] = [];
  let totalChars = 0;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    totalChars += text.length;
    utterances.push({
      id: segment.id,
      text,
      start_ms: segment.startMs ?? null,
      end_ms: segment.endMs ?? null,
      speaker: segment.speaker ?? null,
    });
  }
  if (totalChars < MIN_TRANSCRIPT_CHARS) {
    throw new Error("chapters.too_short");
  }
  if (totalChars > MAX_TRANSCRIPT_CHARS) {
    throw new Error("chapters.too_long");
  }
  return utterances;
}

/** FNV-1a over the canonical transcript shape — the deterministic fallback
 *  where WebCrypto is unavailable (some test environments). */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + `-${input.length.toString(16)}`;
}

function transcriptCanonicalForm(segments: ChapterSegment[]): string {
  return segments
    .map((segment) => `${segment.id}|${segment.startMs ?? "-"}|${segment.endMs ?? "-"}|${segment.text}`)
    .join("\n");
}

/**
 * Stable hash of the transcript the chapters were built from. Any edit to a
 * segment's id/timestamps/text changes the hash and marks chapters stale.
 */
export async function computeTranscriptHash(segments: ChapterSegment[]): Promise<string> {
  const canonical = transcriptCanonicalForm(segments);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fnv1aHex(canonical);
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return fnv1aHex(canonical);
  }
}

/**
 * Map the model's segment-id boundaries back onto the real segments and build
 * contiguous, fully-covering, ordered chapters (mirrors the server's
 * starts-partition so both sides agree). Every chapter gets start/end ids
 * that exist in the record; ms timestamps come only from those anchor
 * segments — a missing timestamp stays null and the UI disables the seek
 * affordance instead of inventing one.
 *
 * Throws when the response contains no usable boundary at all (the caller
 * surfaces a generation error instead of a bogus document).
 */
export function validateAndMapChapters(
  result: GenerateChaptersResult,
  segments: ChapterSegment[],
): SemanticChapter[] {
  if (segments.length === 0) throw new Error("chapters.invalid");
  const indexOf = new Map(segments.map((segment, index) => [segment.id, index]));

  const starts = new Set<number>();
  let validEntries = 0;
  for (const chapter of result.chapters) {
    const start = indexOf.get(chapter.start_segment_id);
    const end = indexOf.get(chapter.end_segment_id);
    if (start === undefined || end === undefined || end < start) continue;
    validEntries += 1;
    const boundary = Math.min(Math.max(start, 0), segments.length - 1);
    if (boundary !== 0) starts.add(boundary);
  }
  if (validEntries === 0) throw new Error("chapters.invalid");

  // Half-open edges → contiguous ranges; empty starts = one whole-recording chapter.
  const lastEnd = segments.length - 1;
  const edges: number[] = [0, ...[...starts].sort((a, b) => a - b), lastEnd + 1];
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const spanStart = edges[i];
    const spanEnd = edges[i + 1];
    if (spanStart === undefined || spanEnd === undefined) continue;
    spans.push([spanStart, spanEnd - 1]);
  }

  const chapters: SemanticChapter[] = [];
  for (const [start, end] of spans) {
    const startSegment = segments[start];
    const endSegment = segments[end];
    // Spans are built from validated in-range indices; the guards only satisfy
    // noUncheckedIndexedAccess.
    if (!startSegment || !endSegment) continue;
    chapters.push({
      id: `chapter-${chapters.length}`,
      order: chapters.length,
      startMs: typeof startSegment.startMs === "number" ? startSegment.startMs : null,
      endMs: typeof endSegment.endMs === "number" ? endSegment.endMs : null,
      startSegmentId: startSegment.id,
      endSegmentId: endSegment.id,
      title: "",
      summary: "",
      keywords: [],
      ...pickMetadata(result.chapters, startSegment.id, chapters.length),
    });
  }
  return chapters;
}

/** Server replies carry titles inline aligned by start id (single-shot) or by
 *  array order (windowed); fall back to positional matching when the id lookup
 *  misses, e.g. after a boundary was dropped in validation. */
function pickMetadata(
  chapters: GeneratedChapter[],
  startSegmentId: string,
  order: number,
): Partial<SemanticChapter> {
  const byStart = chapters.find((chapter) => chapter.start_segment_id === startSegmentId)
    ?? chapters[order];
  if (!byStart) return {};
  return {
    title: byStart.title ?? "",
    summary: byStart.summary ?? "",
    keywords: Array.isArray(byStart.keywords) ? byStart.keywords.slice(0, 5) : [],
  };
}

/** Build the persisted document from a validated generation result. */
export function buildChapterDocument(
  result: GenerateChaptersResult,
  segments: ChapterSegment[],
  transcriptHash: string,
): ChapterDocument {
  return {
    schemaVersion: 1,
    transcriptHash,
    model: result.model ?? undefined,
    promptVersion: result.promptVersion || "unknown",
    generatedAt: new Date().toISOString(),
    chapters: validateAndMapChapters(result, segments),
  };
}

/**
 * Chapters are stale when the transcript moved on after they were generated
 * (re-transcription, segment edits). Derived on read — no background job
 * writes the flag, so an offline client still sees the truth.
 */
export function isChapterDocumentStale(document: ChapterDocument | null | undefined, currentHash: string): boolean {
  return !!document && document.transcriptHash !== currentHash;
}

/** True when at least one chapter carries user edits (regeneration guard). */
export function hasManualEdits(document: ChapterDocument | null | undefined): boolean {
  return !!document?.chapters.some((chapter) => chapter.manuallyEdited);
}

/** Apply a title/summary edit to one chapter and flag it as user-authored. */
export function editChapter(
  document: ChapterDocument,
  chapterId: string,
  patch: { title?: string; summary?: string },
): ChapterDocument {
  return {
    ...document,
    chapters: document.chapters.map((chapter) =>
      chapter.id === chapterId
        ? {
            ...chapter,
            ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
            ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
            manuallyEdited: true,
          }
        : chapter,
    ),
  };
}
