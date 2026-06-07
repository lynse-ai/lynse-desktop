import type { StorageAdapter } from "../types/storage";

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
  locale: string;
  resources: Record<string, Record<string, unknown>>;
  localeAdapter?: { get(): string | null; set(locale: string): void };
}
