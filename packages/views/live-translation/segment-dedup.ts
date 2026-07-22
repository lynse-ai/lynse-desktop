import type { LiveTranslationSegment } from "./types";

export interface DisplaySegment extends LiveTranslationSegment {
  /** Source-language text with rolling-buffer prefixes removed. */
  displayRecognized: string;
  /** Translated text with rolling-buffer prefixes removed. */
  displayTranslated: string;
}

/**
 * Remove a leading substring of `current` that repeats the entire `previous`
 * text. Real-time translation providers (e.g. iLiveData RTVT) often deliver
 * each new sentence as a rolling buffer that starts with the previous sentence,
 * which makes adjacent transcript blocks echo each other.
 *
 * The rule is intentionally strict — only trim when `previous` is a full prefix
 * of `current` — so unrelated sentences and sentences that merely share a few
 * opening words are left untouched. Each language field is trimmed
 * independently, which keeps recognized and translated lines consistent.
 */
export function stripLeadingOverlap(current: string, previous: string): string {
  const prev = previous.trim();
  const cur = current.trimStart();
  if (prev.length < 2) return current;
  if (!cur.startsWith(prev)) return current;
  const rest = cur.slice(prev.length).replace(/^\s+/, "");
  return rest;
}

/**
 * Prepare segments for display: drop the rolling-buffer prefix that each
 * segment shares with the previously finalized segment, so consecutive blocks
 * never repeat each other. The reference text is only advanced on finalized
 * segments, keeping the comparison stable while a sentence is still streaming.
 */
export function cleanSegmentsForDisplay(
  segments: LiveTranslationSegment[],
): DisplaySegment[] {
  const out: DisplaySegment[] = [];
  let prevRecognized = "";
  let prevTranslated = "";
  for (const segment of segments) {
    const displayRecognized = stripLeadingOverlap(segment.recognizedText, prevRecognized);
    const displayTranslated = stripLeadingOverlap(segment.translatedText, prevTranslated);
    if (segment.isFinal) {
      prevRecognized = segment.recognizedText;
      prevTranslated = segment.translatedText;
    }
    if (displayRecognized.trim().length === 0 && displayTranslated.trim().length === 0) {
      continue;
    }
    out.push({ ...segment, displayRecognized, displayTranslated });
  }
  return out;
}
