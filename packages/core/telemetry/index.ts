import * as Sentry from "@sentry/react";

export interface SentryConfig {
  /** Sentry DSN (e.g. https://xxx@xxx.ingest.sentry.io/xxx) */
  dsn?: string;
  /** Environment (production / staging / development) */
  environment?: string;
  /** App release tag (e.g. @lynse/tauri@1.2.17) */
  release?: string;
  /** Whether Sentry is active */
  enabled?: boolean;
  /** Console debug logging */
  debug?: boolean;
  /** Sample rate for performance tracing (0.0 to 1.0, default 0.1) */
  tracesSampleRate?: number;
}

class TelemetryService {
  private initialized = false;
  private enabled = false;

  init(config: SentryConfig): void {
    if (!config.dsn || config.enabled === false) {
      if (config.debug) {
        console.log("[Telemetry] Sentry skipped (no DSN or disabled)");
      }
      return;
    }

    try {
      Sentry.init({
        dsn: config.dsn,
        environment: config.environment || "production",
        release: config.release,
        tracesSampleRate: config.tracesSampleRate ?? 0.1,
        beforeSend(event) {
          // Privacy protection: strip authorization / cookie headers from breadcrumbs & request
          if (event.request?.headers) {
            delete event.request.headers.authorization;
            delete event.request.headers.cookie;
          }
          return event;
        },
      });
      this.initialized = true;
      this.enabled = true;
      if (config.debug) {
        console.log("[Telemetry] Sentry initialized successfully");
      }
    } catch (err) {
      console.warn("[Telemetry] Sentry init failed:", err);
    }
  }

  captureException(error: unknown, context?: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      if (context) {
        Sentry.withScope((scope) => {
          scope.setExtras(context);
          Sentry.captureException(error);
        });
      } else {
        Sentry.captureException(error);
      }
    } catch {}
  }

  captureMessage(message: string, level: Sentry.SeverityLevel = "info"): void {
    if (!this.enabled) return;
    try {
      Sentry.captureMessage(message, level);
    } catch {}
  }

  setUser(user: { id?: string; email?: string; username?: string } | null): void {
    if (!this.enabled) return;
    try {
      Sentry.setUser(user);
    } catch {}
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const telemetry = new TelemetryService();
export const SentryErrorBoundary = Sentry.ErrorBoundary;
export { Sentry };
