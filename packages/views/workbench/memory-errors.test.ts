import { describe, expect, it } from "vitest";
import { ApiError } from "@lynse/core/api";
import { memoryRequestErrorKey } from "./memory-errors";

describe("memory request failure copy", () => {
  it.each([
    [401, "connection_auth"], [403, "connection_forbidden"], [404, "unavailable"],
    [409, "changed"], [429, "connection_busy"], [500, "connection_failed"],
    [501, "unavailable"], [503, "connection_failed"], [504, "connection_failed"],
  ])("classifies HTTP %i consistently for web and Native", (status, key) => {
    expect(memoryRequestErrorKey(new ApiError(status as number, "request failed"))).toBe(`memory_manager.${key}`);
    expect(memoryRequestErrorKey(`Cloud knowledge request failed (HTTP ${status})`)).toBe(`memory_manager.${key}`);
  });
  it.each(["Cloud knowledge offline", "Cloud knowledge capability unavailable or authorization rejected", new TypeError("Failed to fetch")])("keeps legacy and network errors distinct from unsupported services", error => {
    expect(memoryRequestErrorKey(error)).toBe("memory_manager.connection_failed");
  });
  it("does not turn unrelated errors into an upgrade instruction", () => {
    expect(memoryRequestErrorKey(new Error("Local directory unavailable"))).toBeNull();
  });
});
