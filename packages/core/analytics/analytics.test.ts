import { describe, expect, it, beforeEach } from "vitest";
import { analytics } from "./index";

describe("AnalyticsService", () => {
  beforeEach(() => {
    analytics.reset();
  });

  it("initializes in disabled/no-op mode gracefully without crashing", () => {
    analytics.init({ enabled: false });
    expect(analytics.isEnabled()).toBe(false);
  });

  it("handles track events with property sanitization (stripping sensitive meeting content)", () => {
    let capturedEvent: string | null = null;
    let capturedProps: Record<string, unknown> | undefined;

    analytics.registerProvider({
      name: "test-provider",
      track: (name, props) => {
        capturedEvent = name;
        capturedProps = props;
      },
    });

    analytics.init({ enabled: true, debug: false });
    analytics.track("recording_completed", {
      source: "mic",
      duration_seconds: 120,
    });

    expect(capturedEvent).toBe("recording_completed");
    expect(capturedProps).toEqual({
      source: "mic",
      duration_seconds: 120,
    });
  });

  it("sanitizes sensitive fields like transcript and markdown content", () => {
    let capturedProps: Record<string, unknown> | undefined;

    analytics.registerProvider({
      name: "test-sanitizer",
      track: (_name, props) => {
        capturedProps = props;
      },
    });

    analytics.trackCustom("test_event", {
      feature: "summary",
      transcript: "Secret confidential meeting content",
      token: "secret-token-123",
      duration_seconds: 45,
    });

    expect(capturedProps?.feature).toBe("summary");
    expect(capturedProps?.duration_seconds).toBe(45);
    expect(capturedProps?.transcript).toBeUndefined();
    expect(capturedProps?.token).toBeUndefined();
  });

  it("supports opt-out", () => {
    let called = false;
    analytics.registerProvider({
      name: "optout-provider",
      track: () => {
        called = true;
      },
    });

    analytics.setOptOut(true);
    expect(analytics.isEnabled()).toBe(false);

    analytics.track("app_launched", { platform: "desktop" });
    expect(called).toBe(false);

    analytics.setOptOut(false);
    expect(analytics.isEnabled()).toBe(true);
  });
});
