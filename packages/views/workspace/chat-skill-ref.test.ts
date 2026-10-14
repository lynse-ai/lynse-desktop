import { describe, expect, it } from "vitest";
import { conversationTitle } from "./chat-history";
import { extractSkillMarker, stripSkillMarker } from "./chat-skill-ref";

describe("extractSkillMarker", () => {
  it("splits a leading skill marker from the prompt body", () => {
    const parts = extractSkillMarker(
      "[会议纪要](skill://meeting-pipeline) 请把所提到的会议内容整理成结构化会议纪要。",
    );
    expect(parts).toEqual({
      marker: "[会议纪要](skill://meeting-pipeline)",
      label: "会议纪要",
      body: "请把所提到的会议内容整理成结构化会议纪要。",
    });
  });

  it("returns null for plain prompts", () => {
    expect(extractSkillMarker("总结一下这场会议")).toBeNull();
  });

  it("ignores markdown links that only appear mid-text", () => {
    const text = "见 [说明](skill://meeting-pipeline) 里的用法";
    expect(extractSkillMarker(text)).toBeNull();
    expect(stripSkillMarker(text)).toBe(text);
  });

  it("matches every shipped skill prompt shape", () => {
    const prompts = [
      "[Meeting summary](skill://lynse-report) Summarize meeting notes.",
      "[Note digest](skill://lynse-note-review) Go through my notes.",
      "[Visual summary](skill://lynse-visual-summary) One-page card.",
      "[HTML report](skill://lynse-report) HTML report.",
      "[To-do list](skill://lynse-schedule) Extract to-dos.",
      "[Action plan](skill://lynse-schedule) Draft a plan.",
    ];
    for (const prompt of prompts) {
      const parts = extractSkillMarker(prompt);
      expect(parts).not.toBeNull();
      expect(parts?.body).not.toContain("skill://");
      expect(`${parts?.marker} ${parts?.body}`).toBe(prompt);
    }
  });
});

describe("stripSkillMarker", () => {
  it("returns the body unchanged when no marker leads the text", () => {
    expect(stripSkillMarker("普通问题")).toBe("普通问题");
  });

  it("keeps placeholder brackets in the body intact", () => {
    const { body } = extractSkillMarker(
      "[To-do list](skill://lynse-schedule) Extract to-dos from [date range].",
    )!;
    expect(body).toBe("Extract to-dos from [date range].");
  });
});

describe("conversationTitle with skill markers", () => {
  it("does not leak the skill marker into the title", () => {
    expect(
      conversationTitle("[会议纪要](skill://meeting-pipeline) 请把会议内容整理成纪要"),
    ).toBe("请把会议内容整理成纪要");
  });
});
