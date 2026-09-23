import { describe, expect, it } from "vitest";
import { formatRecordStartTime, generateSyncFileId } from "./sync-upload";

describe("formatRecordStartTime", () => {
  it("formats instants as GMT+8 wall-clock time", () => {
    // 2026-09-23T02:30:05Z === 10:30:05 in GMT+8.
    expect(formatRecordStartTime("2026-09-23T02:30:05Z")).toBe("2026-09-23 10:30:05");
  });

  it("rolls across the GMT+8 day boundary", () => {
    // 2026-09-23T17:00:00Z === 2026-09-24 01:00:00 in GMT+8.
    expect(formatRecordStartTime("2026-09-23T17:00:00Z")).toBe("2026-09-24 01:00:00");
  });

  it("pads every field to two digits", () => {
    // 2026-01-04T16:05:09Z === 2026-01-05 00:05:09 in GMT+8 (midnight guard).
    expect(formatRecordStartTime("2026-01-04T16:05:09Z")).toBe("2026-01-05 00:05:09");
  });

  it("returns an empty string for unparseable input", () => {
    expect(formatRecordStartTime("not-a-date")).toBe("");
  });
});

describe("generateSyncFileId", () => {
  it("yields 32 lowercase hex chars (UUID sans dashes)", () => {
    expect(generateSyncFileId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates distinct ids", () => {
    expect(generateSyncFileId()).not.toBe(generateSyncFileId());
  });
});
