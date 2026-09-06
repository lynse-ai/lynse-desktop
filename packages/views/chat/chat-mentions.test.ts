import { describe, expect, it } from "vitest";
import {
  activeMentions,
  collectMentionFileIds,
  detectMentionTrigger,
  filterMentionOptions,
  insertMentionText,
  removeMentionText,
  type ChatMention,
} from "./chat-mentions";
import type { WorkspaceItem } from "../workspace/types";

function note(id: string, folderId?: string): WorkspaceItem {
  return { id, type: "file", title: id, createdAt: "", updatedAt: "", folderId };
}

describe("detectMentionTrigger", () => {
  it("detects a @ token at the start of the input", () => {
    expect(detectMentionTrigger("@产", 2)).toEqual({
      trigger: "@",
      query: "产",
      start: 0,
      end: 2,
    });
  });

  it("detects a # token after whitespace, with an empty query", () => {
    expect(detectMentionTrigger("总结 #", 4)).toEqual({
      trigger: "#",
      query: "",
      start: 3,
      end: 4,
    });
  });

  it("returns null when the trigger is mid-word or the caret left the token", () => {
    // Mid-word `@` (e.g. an email) never triggers.
    expect(detectMentionTrigger("user@foo", 8)).toBeNull();
    // Caret before the token.
    expect(detectMentionTrigger("@note rest", 1)).toEqual({
      trigger: "@",
      query: "",
      start: 0,
      end: 1,
    });
    // Caret after the token's trailing space closes the picker.
    expect(detectMentionTrigger("@note ", 6)).toBeNull();
  });
});

describe("insertMentionText", () => {
  it("replaces the typed query with the token and moves the caret after it", () => {
    const detection = detectMentionTrigger("总结 @产", 5)!;
    expect(
      insertMentionText({ text: "总结 @产", detection, title: "产品评审" }),
    ).toEqual({ text: "总结 @产品评审 ", caret: 9 });
  });
});

describe("activeMentions / removeMentionText", () => {
  const mentions: ChatMention[] = [
    { kind: "note", id: "n1", title: "产品评审" },
    { kind: "group", id: "g1", title: "工作" },
  ];

  it("keeps only mentions whose token is still in the text", () => {
    expect(activeMentions(mentions, "对比 @产品评审 和 @工作")).toEqual([mentions[0]]);
  });

  it("removes a mention token and its trailing space from the text", () => {
    expect(removeMentionText("看看 @产品评审 吧", mentions[0]!)).toBe("看看 吧");
    // No trailing space: just the token.
    expect(removeMentionText("#工作", mentions[1]!)).toBe("");
    // Unknown token: text untouched.
    expect(removeMentionText("文本", mentions[0]!)).toBe("文本");
  });
});

describe("filterMentionOptions", () => {
  it("filters case-insensitively and passes everything through on an empty query", () => {
    const options = [
      { id: "1", title: "Roadmap" },
      { id: "2", title: "周报" },
    ];
    expect(filterMentionOptions(options, "road")).toEqual([options[0]]);
    expect(filterMentionOptions(options, "")).toHaveLength(2);
  });
});

describe("collectMentionFileIds", () => {
  const notes = [note("n1", "f1"), note("n2", "f1"), note("n3", "f2"), note("n4")];

  it("collects note ids directly and expands groups to their member notes, deduped", () => {
    const mentions: ChatMention[] = [
      { kind: "note", id: "n3", title: "C" },
      { kind: "group", id: "f1", title: "工作" },
      { kind: "note", id: "n2", title: "B" },
    ];
    expect(collectMentionFileIds(mentions, notes)).toEqual(["n3", "n1", "n2"]);
  });

  it("supports the virtual uncategorized group", () => {
    expect(collectMentionFileIds([{ kind: "group", id: "__uncategorized__", title: "未分类" }], notes)).toEqual([
      "n4",
    ]);
  });

  it("returns an empty list without mentions", () => {
    expect(collectMentionFileIds([], notes)).toEqual([]);
  });
});
