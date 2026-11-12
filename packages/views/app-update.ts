import { useEffect, useMemo, useState } from "react";
import { normalizeReleaseNotesLocales, selectReleaseNotes, type ReleaseNotesLocales } from "@lynse/core/i18n";
import { useTranslation } from "@lynse/core/i18n/react";

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  releaseNotesByLocale?: ReleaseNotesLocales;
  publishedAt?: string | null;
};

/**
 * The stable updater manifest on Tencent CloudBase static hosting — the same
 * file tauri-plugin-updater polls first (endpoints live in
 * `apps/tauri/src-tauri/tauri.conf.json`). Fetched directly so the About page
 * can show the release notes even when there is nothing to update: the
 * updater plugin only surfaces the notes body when an update is available.
 * The hosting gateway reflects the request origin in CORS and serves
 * no-store, so the read is always fresh.
 */
const UPDATES_MANIFEST_URL = "https://dl.lynse.cn/updates/latest.json";

export interface LatestReleaseNotes {
  version: string;
  notes: string;
  notesByLocale?: ReleaseNotesLocales;
  pubDate?: string;
}

/**
 * Read the published release notes from CloudBase. Resolves null when the
 * manifest is unreachable, malformed, or has no notes — callers just hide
 * the notes block, which must never block the page.
 */
export async function fetchLatestReleaseNotes(): Promise<LatestReleaseNotes | null> {
  try {
    const res = await fetch(UPDATES_MANIFEST_URL);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      version?: unknown;
      notes?: unknown;
      notes_i18n?: unknown;
      pub_date?: unknown;
    };
    const version = typeof body.version === "string" ? body.version : null;
    const notesByLocale = normalizeReleaseNotesLocales(body.notes_i18n);
    const notes = selectReleaseNotes(body.notes, notesByLocale, "en") ?? "";
    if (!version || (!notes && Object.keys(notesByLocale).length === 0)) return null;
    return {
      version,
      notes,
      notesByLocale,
      pubDate: typeof body.pub_date === "string" ? body.pub_date : undefined,
    };
  } catch {
    return null;
  }
}

/** Serializable download/install progress reported by the desktop bridge. */
export type UpdateDownloadProgress = {
  event: "started" | "progress" | "finished";
  downloaded: number;
  total: number;
};

export type UpdateInstallPhase = "idle" | "downloading" | "installing" | "restarting" | "failed";

export type UpdateInstallState = {
  phase: UpdateInstallPhase;
  /** Bytes downloaded so far (valid while downloading). */
  downloaded: number;
  /** Total bytes when known (may be 0 until the server reports it). */
  total: number;
  error: string | null;
};

type DesktopAppApi = {
  getInfo: () => Promise<{ version: string; build?: string | null; platform: string }>;
  /** Opens (or focuses) the standalone About window with a localized title. */
  openAboutWindow: (title?: string) => Promise<void>;
  /** Opens (or focuses) the standalone feedback board window with a localized title. */
  openFeedbackWindow: (title?: string) => Promise<void>;
  checkForUpdate: () => Promise<AppUpdateInfo>;
  downloadAndInstallUpdate: (onProgress: (progress: UpdateDownloadProgress) => void) => Promise<void>;
  relaunchApp: () => Promise<void>;
  /** Pre-auth compact welcome window (true, 690×450) vs dashboard size
   * (false, 960×600). No-op outside the desktop app. */
  setCompactWindowSize: (active: boolean) => Promise<void>;
  /** Enlarge the window while the permission onboarding is up (its four
   * rows outgrow the dashboard face) and restore the previous frame on
   * exit. Optional — absent on web and older desktop builds. */
  enterOnboardingWindowSize?: () => Promise<void>;
  exitOnboardingWindowSize?: () => Promise<void>;
  /** WeChat OAuth sign-in window (desktop only). The authorize page opens in
   * an embedded window; the code+state redirect is relayed back as a URL. */
  wechat?: {
    openAuthWindow: (url: string) => Promise<void>;
    closeAuthWindow: () => Promise<void>;
    onAuthCallback: (
      callback: (callbackUrl: string) => void,
    ) => Promise<() => void>;
  };
};

/** Access the desktop update API, or null when running outside the Tauri host. */
export function getDesktopAppApi(): DesktopAppApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & { desktopAPI?: { app?: DesktopAppApi } };
  return desktopWindow.desktopAPI?.app ?? null;
}

/** Synchronously read the version the bridge populated from the Rust host. */
export function getAppInfoSync(): {
  version: string;
  build?: string | null;
  platform: string;
  sandboxed?: boolean;
} | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: {
      appInfo?: {
        version: string;
        build?: string | null;
        platform: string;
        sandboxed?: boolean;
      };
    };
  };
  return desktopWindow.desktopAPI?.appInfo ?? null;
}

/**
 * True when this desktop build runs under the macOS App Sandbox — TestFlight
 * (and App Store) signing injects the entitlement regardless of what the
 * source entitlements declare. A sandboxed app cannot replace its own bundle
 * in /Applications, so the in-app download+install flow always fails with
 * EPERM; those builds are pointed at the website download page instead, and
 * installing the direct-distribution build once migrates them off TestFlight
 * for good. Windows installers and Developer-ID direct installs are never
 * sandboxed, and outside the desktop host there is no appInfo at all —
 * both false.
 */
export function isSandboxedMacApp(): boolean {
  return getAppInfoSync()?.sandboxed === true;
}

/** Open a URL in the system browser via the Tauri opener plugin. */
export function openExternalUrl(url: string): void {
  const desktopWindow = window as Window & {
    desktopAPI?: { openExternal?: (url: string) => Promise<void> };
  };
  void desktopWindow.desktopAPI?.openExternal?.(url);
}

// Re-check cadence. GitHub's unauthenticated API allows 60 req/hr per IP, so a
// 30-minute interval (≈48/day) is comfortably within budget.
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

// ── Shared update dialog ──────────────────────────────────────────────────
// A single dialog instance is mounted near the app root. Every entry point
// (notification center, profile menu, sidebar, settings) opens it through
// this store, so users never have to dig into Settings → About first.
let dialogOpen = false;
const dialogListeners = new Set<() => void>();

function setDialogOpen(open: boolean): void {
  if (dialogOpen === open) return;
  dialogOpen = open;
  dialogListeners.forEach((listener) => listener());
}

/**
 * Open the shared update dialog. Pass `refresh: true` to force a fresh
 * version check first (used by "Check for updates" affordances).
 */
export function openAppUpdateDialog(options?: { refresh?: boolean }): void {
  setDialogOpen(true);
  if (options?.refresh) {
    const api = getDesktopAppApi();
    if (api) void runCheck(api, true);
  }
}

export function closeAppUpdateDialog(): void {
  setDialogOpen(false);
}

/** Subscribe the mounted dialog to the shared open state. */
export function useAppUpdateDialog(): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpen] = useState(dialogOpen);

  useEffect(() => {
    const sync = () => setOpen(dialogOpen);
    dialogListeners.add(sync);
    sync();
    return () => {
      dialogListeners.delete(sync);
    };
  }, []);

  return { open, setOpen: setDialogOpen };
}

// ── Shared singleton store ─────────────────────────────────────────────────
// Several components subscribe to update state (title bar, settings). A single
// polling loop and a single in-flight request back this store so we never fire
// duplicate network calls from multiple mounted components.
let sharedUpdate: AppUpdateInfo | null = null;
let checking = false;
let lastError: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let installState: UpdateInstallState = { phase: "idle", downloaded: 0, total: 0, error: null };
let installing = false;
const listeners = new Set<() => void>();

async function runCheck(api: DesktopAppApi, showChecking: boolean): Promise<void> {
  if (showChecking) {
    checking = true;
    listeners.forEach((listener) => listener());
  }
  lastError = null;
  try {
    sharedUpdate = await api.checkForUpdate();
  } catch (error) {
    lastError = error instanceof Error ? error.message : "update check failed";
  } finally {
    if (showChecking) checking = false;
    listeners.forEach((listener) => listener());
  }
}

function ensurePolling(api: DesktopAppApi): void {
  if (timer) return;
  void runCheck(api, false);
  timer = setInterval(() => void runCheck(api, false), CHECK_INTERVAL_MS);
}

/** Download → verify signature → install → relaunch, with shared progress. */
async function runInstall(api: DesktopAppApi): Promise<void> {
  if (installing) return;
  installing = true;
  installState = { phase: "downloading", downloaded: 0, total: 0, error: null };
  listeners.forEach((listener) => listener());
  try {
    await api.downloadAndInstallUpdate((progress) => {
      if (progress.event === "finished") {
        installState = {
          ...installState,
          phase: "installing",
          downloaded: progress.total,
          total: progress.total,
        };
      } else {
        installState = { ...installState, downloaded: progress.downloaded, total: progress.total };
      }
      listeners.forEach((listener) => listener());
    });
    // Give the UI one paint of the "restarting" state before the process
    // exits — relaunch() never resolves once the new instance takes over.
    installState = { ...installState, phase: "restarting" };
    listeners.forEach((listener) => listener());
    await new Promise((resolve) => setTimeout(resolve, 400));
    await api.relaunchApp();
  } catch (error) {
    installState = {
      phase: "failed",
      downloaded: 0,
      total: 0,
      error: error instanceof Error ? error.message : "update install failed",
    };
    listeners.forEach((listener) => listener());
  } finally {
    installing = false;
  }
}

export function useAppUpdate() {
  const { i18n } = useTranslation();
  const api = getDesktopAppApi();
  const [update, setUpdate] = useState<AppUpdateInfo | null>(sharedUpdate);
  const [isChecking, setIsChecking] = useState(checking);
  const [error, setError] = useState<string | null>(lastError);
  const [currentInstallState, setCurrentInstallState] = useState<UpdateInstallState>(installState);

  useEffect(() => {
    if (!api) return;
    const sync = () => {
      setUpdate(sharedUpdate);
      setIsChecking(checking);
      setError(lastError);
      setCurrentInstallState(installState);
    };
    listeners.add(sync);
    sync();
    ensurePolling(api);
    return () => {
      listeners.delete(sync);
    };
  }, [api]);

  const checkForUpdate = () => {
    if (!api) return;
    void runCheck(api, true);
  };

  const install = () => {
    if (!api) return;
    void runInstall(api);
  };

  const localizedUpdate = useMemo(() => update ? {
    ...update,
    releaseNotes: selectReleaseNotes(update.releaseNotes, update.releaseNotesByLocale, i18n.resolvedLanguage ?? i18n.language),
  } : null, [update, i18n.resolvedLanguage, i18n.language]);

  return {
    update: localizedUpdate,
    checking: isChecking,
    error,
    checkForUpdate,
    install,
    installState: currentInstallState,
  };
}
