import { describe, expect, it } from "vitest";
import { isLocalTranscriptionActive } from "./local-transcription-status";

describe("isLocalTranscriptionActive", () => {
  it("treats queued, transcribing, and retrying local records as active", () => {
    expect(isLocalTranscriptionActive({ status: "queued", retrying: false })).toBe(true);
    expect(isLocalTranscriptionActive({ status: "transcribing", retrying: false })).toBe(true);
    expect(isLocalTranscriptionActive({ status: "failed", retrying: true })).toBe(true);
  });

  it("does not treat completed or failed records as active without retrying", () => {
    expect(isLocalTranscriptionActive({ status: "completed", retrying: false })).toBe(false);
    expect(isLocalTranscriptionActive({ status: "failed", retrying: false })).toBe(false);
    expect(isLocalTranscriptionActive({ retrying: false })).toBe(false);
  });
});
