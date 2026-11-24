import type { StorageAdapter } from "../types/storage";
import type { AnalyticsConfig } from "../analytics/types";
import type { SentryConfig } from "../telemetry";

export interface ClientIdentity {
  platform?: string;
  version?: string;
  os?: string;
}

export interface CoreProviderProps {
  children: React.ReactNode;
  apiBaseUrl?: string;
  wsUrl?: string;
  storage?: StorageAdapter;
  cookieAuth?: boolean;
  onLogin?: () => void;
  onLogout?: () => void;
  identity?: ClientIdentity;
  /** Pins the UI language; omit to auto-detect the system language. */
  locale?: string;
  resources: Record<string, Record<string, unknown>>;
  localeAdapter?: { get(): string | null; set(locale: string): void };
  analyticsConfig?: AnalyticsConfig;
  telemetryConfig?: SentryConfig;
}
