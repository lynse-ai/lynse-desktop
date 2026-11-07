import { useQuery } from "@tanstack/react-query";

import type { ChapterDocument } from "./types";
import type { ChapterSegment } from "./semantic-chapters";

/** Cloud generation results are derived from a canonical transcript snapshot;
 *  the document itself is cached until the user regenerates or re-signs in. */
export function cloudChaptersQueryKey(fileId: string | null): readonly unknown[] {
  return ["cloud-chapters", fileId] as const;
}

/** Read the same flexible transcript envelope used by the 转写 tab, but keep
 *  both timestamps and stable fallback ids so chapter boundaries can seek. */
export function cloudTranscriptionToChapterSegments(
  transcription: unknown,
): ChapterSegment[] {
  let records: unknown[] = [];
  if (Array.isArray(transcription)) {
    records = transcription;
  } else if (transcription && typeof transcription === "object") {
    const payload = transcription as Record<string, unknown>;
    for (const key of ["records", "list", "data", "transcriptionRecords", "segments"]) {
      const rows = payload[key];
      if (Array.isArray(rows) && rows.length > 0) {
        records = rows;
        break;
      }
    }
  }

  return records.flatMap((row, index) => {
    if (!row || typeof row !== "object") return [];
    const segment = row as Record<string, unknown>;
    const text = [segment.text, segment.recognizedText, segment.content, segment.transcriptionText]
      .find((value): value is string => typeof value === "string" && !!value.trim()) ?? "";
    const startMs = segment.beginTime ?? segment.startMs;
    const endMs = segment.endTime ?? segment.endMs;
    const speaker = segment.speakerName ?? segment.speaker;
    return [{
      id: segment.id ? String(segment.id) : `cloud-${String(index).padStart(6, "0")}`,
      text,
      startMs: typeof startMs === "number" ? startMs : undefined,
      endMs: typeof endMs === "number" ? endMs : undefined,
      speaker: speaker ? String(speaker) : null,
    }];
  });
}

/** Query cache only: unlike local chapters, cloud documents have no dedicated
 *  persistence endpoint yet. Keeping them in QueryClient still survives tab
 *  switches, detail-panel remounts, and app navigation within one session. */
export function useCloudChapterDocument(fileId: string | null) {
  return useQuery<ChapterDocument | null>({
    queryKey: cloudChaptersQueryKey(fileId),
    queryFn: () => null,
    enabled: !!fileId && !fileId.startsWith("local:"),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60 * 1000,
  });
}
