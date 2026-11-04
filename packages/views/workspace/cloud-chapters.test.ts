import { describe, expect, it } from "vitest";

import { cloudTranscriptionToChapterSegments } from "./cloud-chapters";
import type { FileTranscription } from "./types";

describe("cloudTranscriptionToChapterSegments", () => {
  it("normalizes the flexible cloud transcript envelope", () => {
    const transcription = {
      records: [
        { id: "row-1", text: "第一段", beginTime: 0, endTime: 1000, speakerName: "Alice" },
        { text: "第二段", beginTime: 1000 },
      ],
    } as FileTranscription;

    expect(cloudTranscriptionToChapterSegments(transcription)).toEqual([
      { id: "row-1", text: "第一段", startMs: 0, endMs: 1000, speaker: "Alice" },
      { id: "cloud-000001", text: "第二段", startMs: 1000, endMs: undefined, speaker: null },
    ]);
  });

  it("falls back to the alternate transcript field used by older payloads", () => {
    const transcription = {
      transcriptionRecords: [{ id: "legacy", text: "转写内容" }],
    } as unknown as FileTranscription;

    expect(cloudTranscriptionToChapterSegments(transcription)).toEqual([
      { id: "legacy", text: "转写内容", startMs: undefined, endMs: undefined, speaker: null },
    ]);
  });
});
