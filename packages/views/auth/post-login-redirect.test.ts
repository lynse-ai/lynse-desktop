/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  consumePostLoginRedirect,
  setPostLoginRedirect,
} from "./post-login-redirect";

/**
 * Session-storage handoff for the full-page redirect login channels
 * (WeChat scan / Apple): the parked path must survive the redirect round
 * trip and be cleared exactly once by the consumer.
 */
describe("post-login redirect handoff", () => {
  it("stores, consumes and clears in one step", () => {
    setPostLoginRedirect("/plugins/recording-card?from=desktop");
    expect(consumePostLoginRedirect()).toBe("/plugins/recording-card?from=desktop");
    // Second consume sees nothing — the redirect must not loop.
    expect(consumePostLoginRedirect()).toBeNull();
  });

  it("overwrites a previous parked path", () => {
    setPostLoginRedirect("/a");
    setPostLoginRedirect("/b?x=1");
    expect(consumePostLoginRedirect()).toBe("/b?x=1");
  });

  it("returns null when nothing was parked", () => {
    expect(consumePostLoginRedirect()).toBeNull();
  });
});
