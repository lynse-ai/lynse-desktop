/**
 * Local-storage accounting for the settings "Account & Storage" page.
 *
 * Types mirror the payload of the `storage_usage` command (see
 * `apps/tauri/src-tauri/src/storage.rs`). Every method degrades to `null` on
 * the web app, where the shell has no local storage to manage.
 */

export type StorageCategoryId =
  | "stt"
  | "inspirations"
  | "recovery"
  | "transcriptions"
  | "vault"
  | "reports"
  | "logs";

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
}

export interface StorageUsage {
  totalBytes: number;
  /** Free space on the volume holding the app data; null when unknown. */
  freeBytes: number | null;
  categories: StorageCategoryUsage[];
}

export interface DesktopStorageApi {
  usage: () => Promise<StorageUsage>;
  reveal: (category: StorageCategoryId) => Promise<void>;
  /** Only "logs" and "recovery" are clearable; the shell rejects the rest. */
  clear: (category: "logs" | "recovery") => Promise<void>;
}

export function getDesktopStorageApi(): DesktopStorageApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { storage?: DesktopStorageApi };
  };
  return desktopWindow.desktopAPI?.storage ?? null;
}

/** 1 234 567 -> "1.2 MB". Bytes stay integral; one decimal below 10 of a unit. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const text = exponent === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[exponent]}`;
}
