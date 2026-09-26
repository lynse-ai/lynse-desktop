import { describe, expect, it } from "vitest";
import {
  isEmptyAssistantPlaceholder,
  stripAttachmentDuplicateImages,
} from "./chat-message-utils";
import type { ChatMessage } from "./types";

const msg = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  role: "assistant",
  content: "",
  timestamp: 0,
  ...overrides,
});

describe("isEmptyAssistantPlaceholder", () => {
  it("drops a truly empty assistant placeholder (cancelled turn)", () => {
    expect(isEmptyAssistantPlaceholder(msg())).toBe(true);
    // Thinking without any answer content is still a dead bubble.
    expect(isEmptyAssistantPlaceholder(msg({ thinking: "想了一半" }))).toBe(true);
  });

  it("never drops user messages", () => {
    expect(isEmptyAssistantPlaceholder({ ...msg(), role: "user" })).toBe(false);
  });

  it("keeps attachment-only replies (the weekly-report PDF turn empties text)", () => {
    expect(
      isEmptyAssistantPlaceholder(
        msg({
          attachments: [
            { id: "a".repeat(32), type: "pdf", name: "灵光记周报.pdf", downloadUrl: "https://x/w.pdf" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("keeps messages that carry sources, a support link, a confirm card or error text", () => {
    expect(isEmptyAssistantPlaceholder(msg({ sources: ["周会"] }))).toBe(false);
    expect(
      isEmptyAssistantPlaceholder(msg({ humanSupportLink: { url: "https://help" } })),
    ).toBe(false);
    expect(
      isEmptyAssistantPlaceholder(
        msg({
          confirm: {
            question: "继续吗",
            options: [
              { label: "A. 是", value: "是" },
              { label: "B. 否", value: "否" },
            ],
          },
        }),
      ),
    ).toBe(false);
    expect(isEmptyAssistantPlaceholder(msg({ content: "Error: boom" }))).toBe(false);
    expect(isEmptyAssistantPlaceholder(msg({ workbuddyAuthRequired: true }))).toBe(false);
  });
});

describe("stripAttachmentDuplicateImages", () => {
  const url = "https://signed.example.com/card.png";
  const attachments = [{ type: "image", name: "card.png", url, downloadUrl: url }];

  it("removes body images whose url already rides in attachments", () => {
    expect(
      stripAttachmentDuplicateImages(`图文总结已生成。\n\n![灵光记图文总结](${url})`, attachments),
    ).toBe("图文总结已生成。");
  });

  it("keeps images whose url is not among the attachments", () => {
    const body = "前言\n\n![外部图](https://other.example.com/keep.png)";
    expect(stripAttachmentDuplicateImages(body, attachments)).toBe(body);
  });

  it("leaves content untouched when there are no attachments", () => {
    expect(stripAttachmentDuplicateImages("![孤立图](https://x/a.png)", undefined)).toBe(
      "![孤立图](https://x/a.png)",
    );
    expect(stripAttachmentDuplicateImages("纯文本", attachments)).toBe("纯文本");
  });
});
