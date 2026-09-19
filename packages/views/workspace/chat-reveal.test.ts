/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { CHAT_REVEAL_STAGGER_MS, isFreshlyRevealed } from "./chat-reveal";
import type { ChatMessage } from "./types";

function message(revealedAt: number | undefined): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "答案",
    timestamp: 0,
    revealedAt,
  };
}

describe("isFreshlyRevealed", () => {
  it("is true inside the reveal window and false at or past it", () => {
    const now = 10_000;
    expect(isFreshlyRevealed(message(now - 100), now)).toBe(true);
    expect(isFreshlyRevealed(message(now - 1499), now)).toBe(true);
    expect(isFreshlyRevealed(message(now - 1500), now)).toBe(false);
    expect(isFreshlyRevealed(message(now - 60_000), now)).toBe(false);
  });

  it("never treats messages without a reveal stamp as fresh", () => {
    expect(isFreshlyRevealed(message(undefined), 10_000)).toBe(false);
  });

  it("defaults the clock to Date.now()", () => {
    expect(isFreshlyRevealed(message(Date.now() - 1))).toBe(true);
    expect(isFreshlyRevealed(message(Date.now() - 10_000))).toBe(false);
  });

  it("exports the stagger used by the two-phase reveal", () => {
    expect(CHAT_REVEAL_STAGGER_MS).toBeGreaterThan(0);
  });
});
