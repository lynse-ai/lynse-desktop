import { useEffect, useState } from "react";

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  publishedAt?: string | null;
};

type DesktopAppApi = {
  getInfo: () => Promise<{ version: string; platform: string }>;
  checkForUpdate: () => Promise<AppUpdateInfo>;
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

export function useAppUpdate() {
  const api = getDesktopAppApi();
  const [update, setUpdate] = useState<AppUpdateInfo | null>(sharedUpdate);
  const [isChecking, setIsChecking] = useState(checking);
  const [error, setError] = useState<string | null>(lastError);

  useEffect(() => {
    if (!api) return;
    const sync = () => {
      setUpdate(sharedUpdate);
      setIsChecking(checking);
      setError(lastError);
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

  return { update, checking: isChecking, error, checkForUpdate };
}
