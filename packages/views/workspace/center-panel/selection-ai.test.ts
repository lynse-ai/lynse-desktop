import { describe, expect, it } from "vitest";
import { buildSelectionPrompt, SELECTION_AI_ACTIONS } from "./selection-ai";

describe("buildSelectionPrompt", () => {
  it("joins the instruction and the selection as a markdown blockquote", () => {
    expect(buildSelectionPrompt("解释这段", "第一行\n第二行")).toBe(
      "解释这段\n\n> 第一行\n> 第二行",
    );
  });

  it("trims the instruction and the passage", () => {
    expect(buildSelectionPrompt("  请解释  ", "  内容  ")).toBe("请解释\n\n> 内容");
  });

  it("returns the bare instruction for an empty selection", () => {
    expect(buildSelectionPrompt("解释这段", "   ")).toBe("解释这段");
  });

  it("caps a runaway selection at the passage limit", () => {
    const huge = "字".repeat(10000);
    const prompt = buildSelectionPrompt("精简", huge);
    // Single-line quote: instruction block + "> " prefix + 8000 capped chars.
    expect(prompt.length).toBe("精简\n\n".length + 2 + 8000);
    expect(prompt.startsWith("精简\n\n> ")).toBe(true);
  });
});

describe("SELECTION_AI_ACTIONS", () => {
  it("covers the four toolbar actions in menu order", () => {
    expect(SELECTION_AI_ACTIONS).toEqual(["explain", "polish", "shorten", "translate"]);
  });
});
