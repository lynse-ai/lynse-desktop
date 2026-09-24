import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import i18next from "i18next";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import {
  collectNotePayloads,
  type VaultNotePayload,
  type VaultSectionLabels,
  type VaultSyncNoteRef,
} from "../workspace/note-vault";
import {
  APP_THEME_STORAGE_KEY,
  applyAppTheme,
} from "./app-theme";

// ── Bridge types (`window.desktopAPI.webdavSync`, desktop only) ─────────────

export interface WebdavSyncConfig {
  enabled: boolean;
  url: string;
  username: string;
  remotePath: string;
  autoSync: boolean;
  allowSelfSigned: boolean;
  lastSyncAt?: string | null;
  /** Read-only: whether a password exists in the keychain (the secret itself
   *  is never returned). */
  hasPassword?: boolean;
}

export interface WebdavNotesSummary {
  written: number;
  failed: number;
  removed: number;
  errors: string[];
}

/** Opaque settings bundle; Rust treats everything except `exportedAt` as
 *  payload. Never contains secrets — keys stay in the OS keychain. */
export interface WebdavSettingsBundle {
  schemaVersion: number;
  exportedAt: string;
  preferences?: { theme?: string; locale?: string; themeCustom?: string };
  /** Non-secret live-translation localStorage entries only. */
  liveTranslation?: Record<string, string>;
  sttConfig?: unknown;
}

export interface WebdavSyncSummary {
  pushed: number;
  pulled: number;
  deletions: number;
  conflicts: number;
  settingsApplied: boolean;
  settingsToApply: WebdavSettingsBundle | null;
  syncedAt: string;
}

export interface WebdavSyncProgress {
  type: "records" | "notes" | "notes-done" | "done";
  done?: number;
  total?: number;
  store?: string;
  title?: string;
  written?: number;
  failed?: number;
  removed?: number;
  pushed?: number;
  pulled?: number;
  deletions?: number;
  conflicts?: number;
}

export interface DesktopWebdavSyncApi {
  getConfig: () => Promise<WebdavSyncConfig>;
  saveConfig: (config: WebdavSyncConfig) => Promise<WebdavSyncConfig>;
  setPassword: (password: string) => Promise<void>;
  /** Empty password falls back to the stored one (re-test after URL change). */
  testConnection: (config: WebdavSyncConfig, password?: string | null) => Promise<void>;
  syncNow: (settingsBundle: WebdavSettingsBundle) => Promise<WebdavSyncSummary>;
  /** Full mirror: remote notes absent from the batch are deleted server-side.
   *  Send the complete payload list in one call — never chunk. */
  putNotes: (notes: VaultNotePayload[]) => Promise<WebdavNotesSummary>;
  onSyncProgress: (callback: (progress: WebdavSyncProgress) => void) => Promise<() => void>;
}

export function getDesktopWebdavSyncApi(): DesktopWebdavSyncApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { webdavSync?: DesktopWebdavSyncApi };
  };
  return desktopWindow.desktopAPI?.webdavSync ?? null;
}

// ── Config query ────────────────────────────────────────────────────────────

export const WEBDAV_CONFIG_QUERY_KEY = ["webdav-config"] as const;

export function useWebdavSyncConfig() {
  const api = getDesktopWebdavSyncApi();
  return useQuery({
    queryKey: WEBDAV_CONFIG_QUERY_KEY,
    queryFn: () => api!.getConfig(),
    enabled: !!api,
    staleTime: Infinity,
  });
}

// ── Settings bundle collect / apply ─────────────────────────────────────────

const WEBDAV_SETTINGS_SCHEMA_VERSION = 1;
/** next-themes' default storage key (no `storageKey` prop is overridden). */
const THEME_STORAGE_KEY = "theme";

/** Mirrors the non-secret keys in `apps/tauri/src/tauri-bridge.ts`. API keys
 *  live in the OS keychain and are intentionally absent from this list. */
const LIVE_TRANSLATION_SYNC_KEYS = [
  "lynse_live_translation_provider",
  "lynse_live_translation_audio_source",
  "lynse_live_translation_ilivedata_endpoint",
  "lynse_live_translation_ilivedata_pid",
  "lynse_live_translation_ilivedata_max_speakers",
  "lynse_live_translation_qwen_endpoint",
  "lynse_live_translation_volc_endpoint",
] as const;

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* localStorage unavailable */
  }
}

function getLocalTranscriptionApi() {
  const desktopWindow = window as Window & {
    desktopAPI?: { localTranscription?: Record<string, (...args: any[]) => Promise<unknown>> };
  };
  return desktopWindow.desktopAPI?.localTranscription ?? null;
}

/** Assemble the syncable settings snapshot from the live stores. */
export async function collectSettingsBundle(
  currentTheme?: string | null,
): Promise<WebdavSettingsBundle> {
  const bundle: WebdavSettingsBundle = {
    schemaVersion: WEBDAV_SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
  };

  const theme = currentTheme ?? readLocalStorage(THEME_STORAGE_KEY);
  const locale = readLocalStorage("lynse_locale");
  const preferences: WebdavSettingsBundle["preferences"] = {};
  if (theme) preferences.theme = theme;
  if (locale) preferences.locale = locale;
  const themeCustom = readLocalStorage(APP_THEME_STORAGE_KEY);
  if (themeCustom) preferences.themeCustom = themeCustom;
  if (Object.keys(preferences).length > 0) bundle.preferences = preferences;

  const liveTranslation: Record<string, string> = {};
  for (const key of LIVE_TRANSLATION_SYNC_KEYS) {
    const value = readLocalStorage(key);
    if (value != null) liveTranslation[key] = value;
  }
  if (Object.keys(liveTranslation).length > 0) bundle.liveTranslation = liveTranslation;

  const localTranscription = getLocalTranscriptionApi();
  const getSttConfig = localTranscription?.getSttConfig;
  if (typeof getSttConfig === "function") {
    try {
      bundle.sttConfig = await getSttConfig();
    } catch {
      /* STT config unavailable — sync without it */
    }
  }

  return bundle;
}

export interface ApplySettingsOptions {
  /** Apply the theme through the mounted next-themes hook so it takes effect
   *  immediately (localStorage alone only affects the next launch). */
  setTheme?: (theme: string) => void;
}

/** Restore a settings bundle onto the live stores. Only allowlisted
 *  live-translation keys are ever written, so a hostile/foreign bundle cannot
 *  plant arbitrary localStorage entries. */
export async function applySettingsBundle(
  bundle: WebdavSettingsBundle,
  options?: ApplySettingsOptions,
): Promise<void> {
  if (bundle.preferences?.theme) {
    writeLocalStorage(THEME_STORAGE_KEY, bundle.preferences.theme);
    options?.setTheme?.(bundle.preferences.theme);
  }
  if (bundle.preferences?.themeCustom) {
    // applyAppTheme() re-reads + sanitizes the stored state and repaints the
    // current mode; the mode flip itself (if any) re-syncs via AppThemeSync.
    writeLocalStorage(APP_THEME_STORAGE_KEY, bundle.preferences.themeCustom);
    applyAppTheme();
  }
  if (bundle.preferences?.locale) {
    writeLocalStorage("lynse_locale", bundle.preferences.locale);
    try {
      await i18next.changeLanguage(bundle.preferences.locale);
    } catch {
      /* keep the current language */
    }
  }
  if (bundle.liveTranslation) {
    for (const key of LIVE_TRANSLATION_SYNC_KEYS) {
      const value = bundle.liveTranslation[key];
      if (typeof value === "string") {
        writeLocalStorage(key, value);
      }
    }
  }
  const sttConfig = bundle.sttConfig;
  if (sttConfig && typeof sttConfig === "object") {
    const saveSttConfig = getLocalTranscriptionApi()?.saveSttConfig;
    if (typeof saveSttConfig === "function") {
      await saveSttConfig(sttConfig).catch(() => {});
    }
  }
}

// ── Notes push (one-way) ────────────────────────────────────────────────────

/**
 * Push every cloud note's markdown to the WebDAV `notes/` folder in a single
 * mirror batch. Guarded against empty payloads so a transient API failure can
 * never wipe the remote folder.
 */
export async function syncNotesToWebdav(
  notes: VaultSyncNoteRef[],
  labels?: Partial<VaultSectionLabels>,
  onProgress?: (progress: { done: number; total: number }) => void,
): Promise<WebdavNotesSummary | null> {
  const api = getDesktopWebdavSyncApi();
  if (!api) throw new Error("WebDAV bridge unavailable");
  if (notes.length === 0) return null;
  const payloads = await collectNotePayloads(notes, labels, onProgress);
  if (payloads.length === 0) return null;
  return api.putNotes(payloads);
}

/** Timestamp of the last successful WebDAV notes push, for the settings card. */
const WEBDAV_NOTES_LAST_SYNC_KEY = "lynse_webdav_notes_last_sync";

export function markWebdavNotesLastSync(): void {
  writeLocalStorage(WEBDAV_NOTES_LAST_SYNC_KEY, new Date().toISOString());
}

export function getWebdavNotesLastSync(): string | null {
  return readLocalStorage(WEBDAV_NOTES_LAST_SYNC_KEY);
}

// ── Auto sync ───────────────────────────────────────────────────────────────

const WEBDAV_AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** Let the app finish booting (auth hydration, queries) before the first sync. */
const WEBDAV_INITIAL_SYNC_DELAY_MS = 8000;

/**
 * Launch-time + periodic record/settings sync for desktop. Renders nothing;
 * failures are silent (the settings card surfaces status on demand).
 */
export function useWebdavAutoSync(): void {
  const api = getDesktopWebdavSyncApi();
  const { data: config } = useWebdavSyncConfig();
  const { setTheme } = useTheme();

  useEffect(() => {
    if (!api || !config?.enabled || !config.autoSync) return;

    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const bundle = await collectSettingsBundle();
        const summary = await api.syncNow(bundle);
        if (summary.settingsToApply) {
          await applySettingsBundle(summary.settingsToApply, { setTheme });
        }
      } catch {
        /* offline, bad credentials, or another sync running — try again later */
      } finally {
        running = false;
      }
    };

    const initialTimer = window.setTimeout(run, WEBDAV_INITIAL_SYNC_DELAY_MS);
    const interval = window.setInterval(run, WEBDAV_AUTO_SYNC_INTERVAL_MS);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [api, config?.enabled, config?.autoSync, setTheme]);
}

/** Whether the desktop WebDAV bridge exists (used to gate the settings card). */
export function isWebdavSyncAvailable(): boolean {
  return getDesktopWebdavSyncApi() !== null;
}
