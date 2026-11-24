import { describe, expect, it } from "vitest";
import { telemetry } from "./index";

describe("TelemetryService", () => {
  it("safely handles no-op when DSN is omitted", () => {
    telemetry.init({});
    expect(telemetry.isEnabled()).toBe(false);

    // Should not throw
    expect(() => {
      telemetry.captureException(new Error("Test error"));
      telemetry.captureMessage("Test message");
      telemetry.setUser({ id: "user-123" });
    }).not.toThrow();
  });
});
