import { describe, expect, it } from "vitest";
import {
  cleanSegmentsForDisplay,
  stripLeadingOverlap,
} from "./segment-dedup";
import type { LiveTranslationSegment } from "./types";

function makeSegment(partial: Partial<LiveTranslationSegment> & Pick<LiveTranslationSegment, "recognizedText" | "translatedText">): LiveTranslationSegment {
  return {
    id: Math.random().toString(36),
    sessionId: "s",
    epoch: 0,
    source: "mic",
    startMs: 0,
    isFinal: false,
    ...partial,
  };
}

describe("stripLeadingOverlap", () => {
  it("removes a full previous prefix from the current text", () => {
    expect(stripLeadingOverlap("Hello world. How are you?", "Hello world.")).toBe(
      "How are you?",
    );
  });

  it("keeps text when the previous is not a prefix (genuine new sentence)", () => {
    expect(stripLeadingOverlap("Nice to meet you", "Hello world")).toBe(
      "Nice to meet you",
    );
  });

  it("handles CJK rolling buffers (trim the repeated sentence)", () => {
    const prev = "我们明天下午发布这个版本";
    const cur = "我们明天下午发布这个版本，大家记得测试";
    expect(stripLeadingOverlap(cur, prev)).toBe("，大家记得测试");
  });

  it("drops an exact duplicate to empty", () => {
    expect(stripLeadingOverlap("重复内容", "重复内容")).toBe("");
  });

  it("ignores very short previous text to avoid churn", () => {
    expect(stripLeadingOverlap("A new sentence", "A")).toBe("A new sentence");
  });
});

describe("cleanSegmentsForDisplay", () => {
  it("strips rolling-buffer prefixes between consecutive finalized segments", () => {
    const segments = [
      makeSegment({ id: "1", recognizedText: "我们明天下午发布", translatedText: "We ship tomorrow afternoon", isFinal: true }),
      makeSegment({ id: "2", recognizedText: "我们明天下午发布，大家记得测试", translatedText: "We ship tomorrow afternoon, please test it", isFinal: true }),
    ];
    const cleaned = cleanSegmentsForDisplay(segments);
    expect(cleaned).toHaveLength(2);
    const second = cleaned[1]!;
    expect(second.displayRecognized).toBe("，大家记得测试");
    expect(second.displayTranslated).toBe(", please test it");
  });

  it("trims a live interim against the previous finalized segment, then advances the reference", () => {
    const segments = [
      makeSegment({ id: "1", recognizedText: "Hello", translatedText: "你好", isFinal: true }),
      makeSegment({ id: "2", recognizedText: "Hello world", translatedText: "你好世界", isFinal: false }),
    ];
    const cleaned = cleanSegmentsForDisplay(segments);
    const second = cleaned[1]!;
    expect(second.displayRecognized).toBe("world");
    expect(second.displayTranslated).toBe("世界");
  });

  it("drops a block that becomes empty after deduplication", () => {
    const segments = [
      makeSegment({ id: "1", recognizedText: "Sentence one", translatedText: "一句话", isFinal: true }),
      makeSegment({ id: "2", recognizedText: "Sentence one", translatedText: "一句话", isFinal: true }),
    ];
    const cleaned = cleanSegmentsForDisplay(segments);
    expect(cleaned).toHaveLength(1);
  });

  it("keeps a following sentence that does not repeat the previous text", () => {
    const segments = [
      makeSegment({ id: "1", recognizedText: "今天天气真好", translatedText: "The weather is nice", isFinal: true }),
      makeSegment({ id: "2", recognizedText: "明天我们去爬山", translatedText: "We will go hiking tomorrow", isFinal: true }),
    ];
    const cleaned = cleanSegmentsForDisplay(segments);
    const second = cleaned[1]!;
    expect(second.displayRecognized).toBe("明天我们去爬山");
    expect(second.displayTranslated).toBe("We will go hiking tomorrow");
  });
});
