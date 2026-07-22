import { describe, it, expect } from "vitest";
import { redactMeetingIds } from "./meeting-id-redact";

describe("redactMeetingIds", () => {
  it("strips long numeric (snowflake) IDs", () => {
    expect(redactMeetingIds("1. 项目周会 (1735000123456789012)")).toBe("1. 项目周会");
    expect(redactMeetingIds("会议 1735000123456789012 已记录")).toBe("会议 已记录");
  });

  it("strips long mixed alphanumeric IDs", () => {
    expect(redactMeetingIds("周会 abcdefghijklmnopqrst2026 总结")).toBe("周会 总结");
  });

  it("strips UUIDs", () => {
    expect(redactMeetingIds("ID: 1a2b3c4d-4e5f-6a7b-8c9d-0e1f2a3b4c5d 结束")).toBe("结束");
  });

  it("strips lynse file IDs (underscore-compound, as shown in chat chips)", () => {
    expect(
      redactMeetingIds("1993855667662958593_1782792055088_3n9y4w8t"),
    ).toBe("");
    expect(
      redactMeetingIds("会议一 1993855667662958593_1782792055088_3n9y4w8t 已完成"),
    ).toBe("会议一 已完成");
  });

  it("strips values after an explicit ID / 会议ID / 编号 label", () => {
    expect(redactMeetingIds("会议ID：9f8e7d6c5b4a39281706 请查看")).toBe("请查看");
    expect(redactMeetingIds("编号: ABC123XYZ 已完成")).toBe("已完成");
  });

  it("preserves legitimate short numbers (dates, phones, durations, years)", () => {
    expect(redactMeetingIds("日期 2026-07-21 时间 14:15:26")).toBe("日期 2026-07-21 时间 14:15:26");
    expect(redactMeetingIds("联系电话 13800138000")).toBe("联系电话 13800138000");
    expect(redactMeetingIds("时长 01:23:45")).toBe("时长 01:23:45");
    expect(redactMeetingIds("成立于 2026 年")).toBe("成立于 2026 年");
  });

  it("protects markdown links so URLs are not corrupted", () => {
    const input = "详见 [项目周会](https://app.lynse.ai/meeting/1735000123456789012)";
    expect(redactMeetingIds(input)).toBe(input);
  });

  it("returns empty input unchanged", () => {
    expect(redactMeetingIds("")).toBe("");
  });

  it("handles a realistic assistant reply with a meeting list", () => {
    const input = [
      "以下为你近期的会议：",
      "1. 项目周会 — 2026-07-20 14:00 (ID: 1735000123456789012)",
      "2. 需求评审 — 2026-07-19 10:30 (ID: 1735000987654321098)",
      "需要我总结哪一个？",
    ].join("\n");
    const out = redactMeetingIds(input);
    expect(out).not.toContain("1735000123456789012");
    expect(out).not.toContain("1735000987654321098");
    expect(out).toContain("项目周会");
    expect(out).toContain("需求评审");
    expect(out).toContain("需要我总结哪一个？");
  });
});
