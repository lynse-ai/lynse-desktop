export type AnalyticsPlatform = "desktop" | "web" | "mobile" | "unknown";

export interface AnalyticsConfig {
  /** PostHog Project API key */
  apiKey?: string;
  /** PostHog API Host (default: 'https://us.i.posthog.com') */
  apiHost?: string;
  /** Whether analytics is enabled (e.g. false in development or if user opted out) */
  enabled?: boolean;
  /** Platform identifier */
  platform?: AnalyticsPlatform;
  /** Application version */
  appVersion?: string;
  /** Operating system / architecture */
  os?: string;
  /** Debug logging in console */
  debug?: boolean;
  /** Opt-out preference */
  optedOut?: boolean;
}

/**
 * Strict Data Minimization Policy (数据最小化原则):
 * Only track essential product health & core funnel metrics.
 * NEVER collect meeting titles, filenames, audio bytes, transcript text, or personal notes.
 */
export interface AnalyticsEventMap {
  /** Application opened (DAU / active device & version adoption) */
  app_launched: {
    platform?: string;
    version?: string;
    os?: string;
    locale?: string;
  };

  /** Audio recording completed */
  recording_completed: {
    source: "mic" | "system" | "device" | "both";
    duration_seconds: number;
  };

  /** Transcription finished (health & local vs cloud engine breakdown) */
  transcription_completed: {
    engine: "local" | "cloud";
    duration_seconds?: number;
    time_cost_ms?: number;
    success: boolean;
  };

  /** AI summary generated (template utilization & success rate) */
  summary_generated: {
    template_id?: string;
    success: boolean;
  };

  /** Hardware recording card connected */
  device_connected: {
    model?: string;
  };
}

export type AnalyticsProvider = {
  name: string;
  track: (eventName: string, properties?: Record<string, unknown>) => void;
  identify?: (userId: string, traits?: Record<string, unknown>) => void;
  reset?: () => void;
};
