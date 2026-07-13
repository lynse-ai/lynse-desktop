import { describe, expect, it } from "vitest";
import { isLocalTranscriptionActive } from "./local-transcription-status";

describe("isLocalTranscriptionActive", () => {
  it("treats queued, transcribing, and retrying local records as active", () => {
    expect(isLocalTranscriptionActive({ statusTag: "排队中", retrying: false })).toBe(true);
    expect(isLocalTranscriptionActive({ statusTag: "转写中", retrying: false })).toBe(true);
    expect(isLocalTranscriptionActive({ statusTag: "失败", retrying: true })).toBe(true);
  });

  it("does not treat completed or failed records as active without retrying", () => {
    expect(isLocalTranscriptionActive({ statusTag: "已完成", retrying: false })).toBe(false);
    expect(isLocalTranscriptionActive({ statusTag: "失败", retrying: false })).toBe(false);
    expect(isLocalTranscriptionActive({ retrying: false })).toBe(false);
  });
});
