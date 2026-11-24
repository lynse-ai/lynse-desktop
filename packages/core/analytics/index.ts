import posthog from "posthog-js";
import type { AnalyticsConfig, AnalyticsEventMap, AnalyticsProvider } from "./types";

class AnalyticsService {
  private initialized = false;
  private enabled = true;
  private config: AnalyticsConfig = {};
  private additionalProviders: AnalyticsProvider[] = [];

  init(config: AnalyticsConfig): void {
    this.config = config;
    this.enabled = config.enabled !== false && !config.optedOut;

    if (!config.apiKey || typeof window === "undefined") {
      if (config.debug) {
        console.log("[Analytics] Initialized in no-op/debug mode (no apiKey or SSR)");
      }
      this.initialized = true;
      return;
    }

    try {
      posthog.init(config.apiKey, {
        api_host: config.apiHost || "https://us.i.posthog.com",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        persistence: "localStorage",
        opt_out_capturing_by_default: !this.enabled,
        loaded: () => {
          if (config.debug) {
            console.log("[Analytics] PostHog loaded successfully");
          }
        },
      });

      if (config.platform || config.appVersion || config.os) {
        posthog.register({
          platform: config.platform,
          app_version: config.appVersion,
          os: config.os,
        });
      }
      this.initialized = true;
    } catch (err) {
      console.warn("[Analytics] PostHog init failed:", err);
    }
  }

  track<E extends keyof AnalyticsEventMap>(
    eventName: E,
    properties?: AnalyticsEventMap[E],
  ): void {
    if (!this.enabled) return;
    const sanitized = this.sanitizeProperties(properties as Record<string, unknown> | undefined);

    if (this.config.apiKey && typeof window !== "undefined") {
      try {
        posthog.capture(eventName as string, sanitized);
      } catch (err) {
        if (this.config.debug) console.warn("[Analytics] PostHog capture error:", err);
      }
    }

    for (const provider of this.additionalProviders) {
      try {
        provider.track(eventName as string, sanitized);
      } catch {}
    }

    if (this.config.debug) {
      console.log(`[Analytics] Track [${String(eventName)}]`, sanitized);
    }
  }

  trackCustom(eventName: string, properties?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const sanitized = this.sanitizeProperties(properties);

    if (this.config.apiKey && typeof window !== "undefined") {
      try {
        posthog.capture(eventName, sanitized);
      } catch {}
    }

    for (const provider of this.additionalProviders) {
      try {
        provider.track(eventName, sanitized);
      } catch {}
    }

    if (this.config.debug) {
      console.log(`[Analytics] TrackCustom [${eventName}]`, sanitized);
    }
  }

  identify(userId: string, traits?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const sanitized = this.sanitizeProperties(traits);

    if (this.config.apiKey && typeof window !== "undefined") {
      try {
        posthog.identify(userId, sanitized);
      } catch {}
    }

    for (const provider of this.additionalProviders) {
      try {
        provider.identify?.(userId, sanitized);
      } catch {}
    }

    if (this.config.debug) {
      console.log(`[Analytics] Identify [${userId}]`, sanitized);
    }
  }

  reset(): void {
    if (this.config.apiKey && typeof window !== "undefined") {
      try {
        posthog.reset();
      } catch {}
    }
    for (const provider of this.additionalProviders) {
      try {
        provider.reset?.();
      } catch {}
    }
  }

  setOptOut(optedOut: boolean): void {
    this.enabled = !optedOut;
    if (this.config.apiKey && typeof window !== "undefined") {
      try {
        if (optedOut) {
          posthog.opt_out_capturing();
        } else {
          posthog.opt_in_capturing();
        }
      } catch {}
    }
  }

  registerProvider(provider: AnalyticsProvider): void {
    this.additionalProviders.push(provider);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private sanitizeProperties(props?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!props) return undefined;
    const copy: Record<string, unknown> = {};
    const sensitiveKeys = ["content", "markdown", "text", "transcript", "token", "password", "secret", "auth"];
    for (const [key, val] of Object.entries(props)) {
      const lower = key.toLowerCase();
      // Drop actual meeting text or sensitive tokens, keep metrics/counts
      if (
        sensitiveKeys.some(
          (s) =>
            lower.includes(s) &&
            !lower.includes("has_") &&
            !lower.includes("count") &&
            !lower.includes("len") &&
            !lower.includes("seconds"),
        )
      ) {
        continue;
      }
      copy[key] = val;
    }
    return copy;
  }
}

export const analytics = new AnalyticsService();
export * from "./types";
export { posthog };
export { PostHogProvider, usePostHog, useFeatureFlagEnabled } from "@posthog/react";
