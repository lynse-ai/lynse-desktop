import { useQuery } from "@tanstack/react-query";

import type { ChapterDocument, FileTranscription } from "./types";
import type { ChapterSegment } from "./semantic-chapters";

/** Cloud generation results are derived from a canonical transcript snapshot;
 *  the document itself is cached until the user regenerates or re-signs in. */
export function cloudChaptersQueryKey(fileId: string | null): readonly unknown[] {
  return ["cloud-chapters", fileId] as const;
}

/** Read the same flexible transcript envelope used by the 转写 tab, but keep
 *  both timestamps and stable fallback ids so chapter boundaries can seek. */
export function cloudTranscriptionToChapterSegments(
  transcription: FileTranscription | undefined,
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

  return records.map((row, index) => {
    const segment = row as Record<string, unknown>;
    const text = String(segment.text ?? "");
    return {
      id: segment.id ? String(segment.id) : `cloud-${String(index).padStart(6, "0")}`,
      text,
      startMs: typeof segment.beginTime === "number" ? segment.beginTime : undefined,
      endMs: typeof segment.endTime === "number" ? segment.endTime : undefined,
      speaker: segment.speakerName ? String(segment.speakerName) : null,
    };
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
