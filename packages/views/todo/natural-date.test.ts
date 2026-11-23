import { describe, expect, it } from "vitest";
import { parseNaturalWhen } from "./natural-date";

/** Sunday 2026-11-22 10:00 local — bare weekday phrases must resolve forward. */
const REF = new Date(2026, 10, 22, 10, 0, 0);

describe("parseNaturalWhen", () => {
  it("parses a Chinese weekday with time and strips it from the title", () => {
    const parsed = parseNaturalWhen("周五下午3点交周报", REF);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("交周报");
    // Next Friday, 15:00 local
    expect(parsed!.dueDate).toBe("2026-11-27T15:00:00");
  });

  it("resolves 下周一 forward (date-only — no explicit time)", () => {
    const parsed = parseNaturalWhen("下周一开会", REF);
    expect(parsed!.title).toBe("开会");
    expect(parsed!.dueDate).toBe("2026-11-30");
  });

  it("keeps date-only shape when the phrase carries no time", () => {
    const parsed = parseNaturalWhen("12月1日提交方案", REF);
    expect(parsed!.title).toBe("提交方案");
    expect(parsed!.dueDate).toBe("2026-12-01");
  });

  it("parses 今天晚上8点 with time", () => {
    const parsed = parseNaturalWhen("今天晚上8点回访客户", REF);
    expect(parsed!.title).toBe("回访客户");
    expect(parsed!.dueDate).toBe("2026-11-22T20:00:00");
  });

  it("parses English phrases", () => {
    const parsed = parseNaturalWhen("submit report next Monday", REF);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("submit report");
    // Sunday ref → the upcoming Monday (tomorrow).
    expect(parsed!.dueDate).toBe("2026-11-23");
  });

  it("returns null when nothing parses", () => {
    expect(parseNaturalWhen("给客户打电话", REF)).toBeNull();
  });

  it("returns null when the whole input is a date phrase", () => {
    expect(parseNaturalWhen("明天", REF)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseNaturalWhen("   ", REF)).toBeNull();
  });

  it("does not latch onto lone numbers", () => {
    expect(parseNaturalWhen("买3杯咖啡", REF)).toBeNull();
  });
});
