import { useEffect, useState } from "react";

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  publishedAt?: string | null;
};

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
  getInfo: () => Promise<{ version: string; platform: string }>;
  checkForUpdate: () => Promise<AppUpdateInfo>;
  downloadAndInstallUpdate: (onProgress: (progress: UpdateDownloadProgress) => void) => Promise<void>;
  relaunchApp: () => Promise<void>;
};

/** Access the desktop update API, or null when running outside the Tauri host. */
export function getDesktopAppApi(): DesktopAppApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & { desktopAPI?: { app?: DesktopAppApi } };
  return desktopWindow.desktopAPI?.app ?? null;
}

/** Synchronously read the version the bridge populated from the Rust host. */
export function getAppInfoSync(): { version: string; platform: string } | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { appInfo?: { version: string; platform: string } };
  };
  return desktopWindow.desktopAPI?.appInfo ?? null;
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

  return {
    update,
    checking: isChecking,
    error,
    checkForUpdate,
    install,
    installState: currentInstallState,
  };
}
