import { describe, expect, it } from "vitest";
import { normalizeMeetingNotes } from "@lynse/core/api";

/** Client-side lenient normalization: server shape drift must degrade to
 *  fewer entries, never throw in the UI; an all-empty payload reads as null
 *  so callers keep the previous notes revision. */
describe("normalizeMeetingNotes", () => {
  it("normalizes a full payload with fishbone", () => {
    const notes = normalizeMeetingNotes({
      title: " 交付对齐 ",
      summary: "摘要",
      topics: [
        {
          start_line_id: "seg001",
          title: "议题一",
          summary: "一句话",
          start_ms: 1200,
          points: [{ text: "要点", evidence: ["seg001"], t: 1200, support: 1 }],
          fishbone: {
            question: "为什么慢？",
            branches: [{ label: "原因", detail: "展开", evidence: ["seg001"], t: 1200, support: 1 }],
          },
        },
      ],
      conclusions: [{ text: "结论", owner: null, evidence: [], t: null, support: 0 }],
      todos: [{ text: "待办", owner: "小张", evidence: ["seg001"], t: 1200, support: 1 }],
      terms: [{ name: "灰度", note: "放量", heard: ["灰色"] }],
    });
    expect(notes).not.toBeNull();
    expect(notes!.title).toBe("交付对齐");
    expect(notes!.topics[0]!.start_ms).toBe(1200);
    expect(notes!.topics[0]!.fishbone!.branches[0]!.label).toBe("原因");
    expect(notes!.todos[0]!.owner).toBe("小张");
    expect(notes!.terms[0]!.heard).toEqual(["灰色"]);
  });

  it("drops entries with empty required fields", () => {
    const notes = normalizeMeetingNotes({
      title: "",
      summary: "摘要",
      topics: [
        { start_line_id: "s1", title: "", summary: "", start_ms: null, points: [], fishbone: null },
        { start_line_id: "s1", title: "保留", summary: "", start_ms: 5, points: [{ text: "" }], fishbone: null },
      ],
      conclusions: [{ text: "", owner: null }],
      todos: [],
      terms: [{ name: "  ", note: "x" }],
    });
    expect(notes!.topics).toHaveLength(1);
    expect(notes!.topics[0]!.points).toHaveLength(0);
    expect(notes!.conclusions).toHaveLength(0);
    expect(notes!.terms).toHaveLength(0);
  });

  it("fishbone without branches degrades to null", () => {
    const notes = normalizeMeetingNotes({
      summary: "s",
      topics: [
        { start_line_id: "s1", title: "t", summary: "", start_ms: 0, points: [], fishbone: { question: "为什么", branches: [] } },
      ],
    });
    expect(notes!.topics[0]!.fishbone).toBeNull();
  });

  it("returns null for an all-empty payload so callers keep previous notes", () => {
    expect(normalizeMeetingNotes({ title: "", summary: "", topics: [] })).toBeNull();
    expect(normalizeMeetingNotes(null)).toBeNull();
    expect(normalizeMeetingNotes("junk")).toBeNull();
  });

  it("survives non-array and non-object field shapes", () => {
    const notes = normalizeMeetingNotes({
      title: "t",
      topics: "not-an-array",
      conclusions: 42,
      terms: [{ name: "n" }],
    });
    expect(notes!.topics).toEqual([]);
    expect(notes!.conclusions).toEqual([]);
    expect(notes!.terms).toHaveLength(1);
  });
});
