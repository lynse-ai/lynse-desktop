import { describe, expect, it } from "vitest";
import type { GenerateChaptersResult } from "@lynse/core/api";
import {
  buildChapterDocument,
  buildUtterances,
  computeTranscriptHash,
  editChapter,
  hasManualEdits,
  isChapterDocumentStale,
  validateAndMapChapters,
  type ChapterSegment,
} from "./semantic-chapters";

function segments(): ChapterSegment[] {
  return [
    { id: "seg001", text: "先介绍项目背景和本次会议要解决的核心问题，确保大家目标一致。", startMs: 0, endMs: 8500, speaker: "S1" },
    { id: "seg002", text: "目前团队正在开发新一代录音卡产品线，需要确认核心目标和交付节奏。", startMs: 8500, endMs: 18000, speaker: "S2" },
    { id: "seg003", text: "接下来讨论技术方案，包括实现路径、资源限制和沙箱隔离的选型依据。", startMs: 18000, endMs: 30000, speaker: "S1" },
    { id: "seg004", text: "技术风险集中在隔离方案上，需要评估两种沙箱的稳定性与迁移成本。", startMs: 30000, endMs: 42000, speaker: "S3" },
  ];
}

function result(chapters: Array<Record<string, unknown>>): GenerateChaptersResult {
  return {
    model: "deepseek-chat",
    promptVersion: "v1",
    chapters: chapters.map((chapter) => ({
      title: String(chapter.title ?? ""),
      summary: String(chapter.summary ?? ""),
      keywords: (chapter.keywords as string[]) ?? [],
      start_segment_id: String(chapter.start_segment_id ?? ""),
      end_segment_id: String(chapter.end_segment_id ?? ""),
      start_ms: (chapter.start_ms as number | null) ?? null,
      end_ms: (chapter.end_ms as number | null) ?? null,
    })),
  };
}

describe("buildUtterances", () => {
  it("maps segments to engine utterances with nullable timestamps", () => {
    const rows = buildUtterances(segments());
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ id: "seg001", text: expect.stringContaining("项目背景"), start_ms: 0, speaker: "S1" });
    expect(rows[0]!.end_ms).toBe(8500);
  });

  it("drops empty rows and counts only non-empty text for limits", () => {
    const rows = buildUtterances([{ id: "a", text: "  " }, ...segments()]);
    expect(rows.map((row) => row.id)).toEqual(["seg001", "seg002", "seg003", "seg004"]);
  });

  it("rejects transcripts under the 100-char floor", () => {
    expect(() => buildUtterances([{ id: "a", text: "太短" }])).toThrow("chapters.too_short");
  });

  it("rejects transcripts over the ceiling", () => {
    const huge = "字".repeat(500_001);
    expect(() => buildUtterances([{ id: "a", text: huge }])).toThrow("chapters.too_long");
  });
});

describe("computeTranscriptHash", () => {
  it("is stable for identical segments", async () => {
    expect(await computeTranscriptHash(segments())).toBe(await computeTranscriptHash(segments()));
  });

  it("changes when any segment id/timestamp/text changes", async () => {
    const base = await computeTranscriptHash(segments());
    const textEdit = segments();
    textEdit[1] = { ...textEdit[1]!, text: textEdit[1]!.text + "。" };
    expect(await computeTranscriptHash(textEdit)).not.toBe(base);
    const timeEdit = segments();
    timeEdit[2] = { ...timeEdit[2]!, startMs: 18001 };
    expect(await computeTranscriptHash(timeEdit)).not.toBe(base);
    const idEdit = segments();
    idEdit[3] = { ...idEdit[3]!, id: "seg009" };
    expect(await computeTranscriptHash(idEdit)).not.toBe(base);
  });
});

describe("validateAndMapChapters", () => {
  it("maps boundaries to contiguous full-coverage chapters with real ms", () => {
    const chapters = validateAndMapChapters(
      result([
        { title: "背景与目标", summary: "s1", keywords: ["背景"], start_segment_id: "seg001", end_segment_id: "seg002" },
        { title: "技术与风险", summary: "s2", keywords: [], start_segment_id: "seg003", end_segment_id: "seg004" },
      ]),
      segments(),
    );
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({
      order: 0, startSegmentId: "seg001", endSegmentId: "seg002", startMs: 0, endMs: 18000, title: "背景与目标",
    });
    expect(chapters[1]).toMatchObject({ order: 1, startSegmentId: "seg003", endSegmentId: "seg004", startMs: 18000, endMs: 42000 });
  });

  it("closes gaps and trims overlaps so coverage stays total", () => {
    const chapters = validateAndMapChapters(
      result([
        { title: "a", summary: "", keywords: [], start_segment_id: "seg002", end_segment_id: "seg003" },
        { title: "b", summary: "", keywords: [], start_segment_id: "seg002", end_segment_id: "seg004" },
      ]),
      segments(),
    );
    // Duplicate boundary at seg002 collapses; everything before it is chapter 1.
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({ startSegmentId: "seg001", endSegmentId: "seg001" });
    expect(chapters[1]).toMatchObject({ startSegmentId: "seg002", endSegmentId: "seg004" });
  });

  it("drops unknown ids and rejects responses with no valid boundary", () => {
    // Every boundary unknown → hard failure, never a fabricated partition.
    expect(() =>
      validateAndMapChapters(result([{ title: "a", summary: "", keywords: [], start_segment_id: "ghost", end_segment_id: "x" }]), segments()),
    ).toThrow("chapters.invalid");
    // One unknown + one valid: the valid boundary survives and leads the partition.
    const chapters = validateAndMapChapters(
      result([
        { title: "a", summary: "", keywords: [], start_segment_id: "ghost", end_segment_id: "seg002" },
        { title: "b", summary: "", keywords: [], start_segment_id: "seg003", end_segment_id: "seg004" },
      ]),
      segments(),
    );
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({ startSegmentId: "seg001", endSegmentId: "seg002" });
    expect(chapters[1]).toMatchObject({ startSegmentId: "seg003", endSegmentId: "seg004" });
  });

  it("keeps null timestamps when anchors lack them (no invented seeks)", () => {
    const rows = segments().map((segment) => ({ ...segment, startMs: undefined, endMs: undefined }));
    const chapters = validateAndMapChapters(
      result([{ title: "a", summary: "", keywords: [], start_segment_id: "seg001", end_segment_id: "seg004" }]),
      rows,
    );
    expect(chapters[0]).toMatchObject({ startMs: null, endMs: null });
  });
});

describe("document helpers", () => {
  it("buildChapterDocument produces a schemaVersion-1 doc with hashed transcript", async () => {
    const hash = await computeTranscriptHash(segments());
    const document = buildChapterDocument(
      result([{ title: "一章", summary: "s", keywords: [], start_segment_id: "seg001", end_segment_id: "seg004" }]),
      segments(),
      hash,
    );
    expect(document.schemaVersion).toBe(1);
    expect(document.transcriptHash).toBe(hash);
    expect(document.chapters).toHaveLength(1);
    expect(document.model).toBe("deepseek-chat");
  });

  it("stale detection follows the transcript hash", async () => {
    const hash = await computeTranscriptHash(segments());
    const document = buildChapterDocument(
      result([{ title: "一章", summary: "", keywords: [], start_segment_id: "seg001", end_segment_id: "seg004" }]),
      segments(),
      hash,
    );
    expect(isChapterDocumentStale(document, hash)).toBe(false);
    const edited = segments();
    edited[0] = { ...edited[0]!, text: edited[0]!.text + "补充一句。" };
    expect(isChapterDocumentStale(document, await computeTranscriptHash(edited))).toBe(true);
    expect(isChapterDocumentStale(null, hash)).toBe(false);
  });

  it("editChapter trims, applies the patch and flags manual edits", async () => {
    const hash = await computeTranscriptHash(segments());
    const document = buildChapterDocument(
      result([{ title: "一章", summary: "s", keywords: [], start_segment_id: "seg001", end_segment_id: "seg004" }]),
      segments(),
      hash,
    );
    expect(hasManualEdits(document)).toBe(false);
    const edited = editChapter(document, document.chapters[0]!.id, { title: "  新标题  ", summary: "新摘要" });
    expect(hasManualEdits(edited)).toBe(true);
    expect(edited.chapters[0]).toMatchObject({ title: "新标题", summary: "新摘要", manuallyEdited: true });
    expect(document.chapters[0]!.title).toBe("一章");
  });
});
