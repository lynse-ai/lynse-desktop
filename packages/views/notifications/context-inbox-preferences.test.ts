/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_INBOX_STORAGE_PREFIX, getContextInboxEnabled, setContextInboxEnabled } from "./context-inbox-preferences";

beforeEach(() => window.localStorage.clear());

describe("account-scoped suggestion preferences", () => {
  it("defaults off for unknown accounts, missing preferences and invalid stored values", () => {
    expect(getContextInboxEnabled(null)).toBe(false);
    expect(getContextInboxEnabled("u1")).toBe(false);
    window.localStorage.setItem(`${CONTEXT_INBOX_STORAGE_PREFIX}u1`, "true");
    expect(getContextInboxEnabled("u1")).toBe(false);
  });

  it("stores choices separately for each account and persists disabling", () => {
    setContextInboxEnabled("u1", true);
    expect(getContextInboxEnabled("u1")).toBe(true);
    expect(getContextInboxEnabled("u2")).toBe(false);
    setContextInboxEnabled("u1", false);
    expect(getContextInboxEnabled("u1")).toBe(false);
  });
});
