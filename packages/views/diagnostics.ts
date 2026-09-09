import { useEffect, useState } from "react";
import { getAppInfoSync, openExternalUrl } from "./app-update";

const ISSUE_TRACKER_URL = "https://github.com/lynse-ai/lynse-desktop/issues/new";

/**
 * The prefilled issue URL must stay well under the ~8k chars browsers and
 * GitHub reliably accept, so the log tail riding along in it is clamped to
 * the most recent slice.
 */
const LOG_TAIL_URL_LIMIT = 4000;

/** Reveal the desktop log folder in the system file manager (Tauri host only). */
export function openLogsFolder(): void {
  const desktopWindow = window as Window & {
    desktopAPI?: { app?: { openLogsFolder?: () => Promise<void> } };
  };
  void desktopWindow.desktopAPI?.app?.openLogsFolder?.();
}

/** Tail of the app log files returned by the desktop host. */
export type LogTail = {
  dir: string;
  tail: string;
  truncated: boolean;
  files: number;
};

/** Host commands backing the in-app bug report dialog (Tauri only). */
export type DesktopDiagnosticsApi = {
  readLogs: (maxBytes?: number) => Promise<LogTail>;
  prepareReport: (report: {
    markdown: string;
    attachments: string[];
    includeLogs: boolean;
  }) => Promise<{ dir: string }>;
  revealReportFolder: (path: string) => Promise<void>;
};

/** Access the diagnostics host API, or null outside the Tauri desktop host. */
export function getDesktopDiagnosticsApi(): DesktopDiagnosticsApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { app?: Partial<DesktopDiagnosticsApi> };
  };
  const app = desktopWindow.desktopAPI?.app;
  return app?.readLogs && app?.prepareReport ? (app as DesktopDiagnosticsApi) : null;
}

// ── Shared report dialog (singleton store) ─────────────────────────────────
// Every entry point (settings, profile menu, sidebar help) opens the same
// dialog instance through this store, mirroring the app-update dialog.
let reportDialogOpen = false;
const reportDialogListeners = new Set<() => void>();

function setReportDialogOpen(open: boolean): void {
  if (reportDialogOpen === open) return;
  reportDialogOpen = open;
  reportDialogListeners.forEach((listener) => listener());
}

/** Open the in-app bug report dialog. */
export function openReportProblemDialog(): void {
  setReportDialogOpen(true);
}

export function closeReportProblemDialog(): void {
  setReportDialogOpen(false);
}

/** Subscribe the mounted dialog to the shared open state. */
export function useReportProblemDialog(): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpen] = useState(reportDialogOpen);

  useEffect(() => {
    const sync = () => setOpen(reportDialogOpen);
    reportDialogListeners.add(sync);
    sync();
    return () => {
      reportDialogListeners.delete(sync);
    };
  }, []);

  return { open, setOpen: setReportDialogOpen };
}

// ── Issue composition ──────────────────────────────────────────────────────

/** Environment block shared by the report dialog and the direct-issue link. */
function environmentSummary(): { version: string; platform: string; text: string } {
  const appInfo = getAppInfoSync();
  const version = appInfo?.version || "unknown";
  const platform = appInfo?.platform ?? "unknown";
  const text = [
    `- App: v${version}`,
    `- Platform: ${platform}`,
    `- User agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    `- Date: ${new Date().toISOString()}`,
  ].join("\n");
  return { version, platform, text };
}

function clampForUrl(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `…[截断 / truncated]…\n${text.slice(-limit)}`;
}

/**
 * Build the prefilled GitHub issue URL. Fields map to the ids in
 * .github/ISSUE_TEMPLATE/bug_report.yml. Creating issues through the API
 * would require a token that can never ship safely inside a client build,
 * so the user reviews and submits the prefilled form with their own GitHub
 * session instead.
 */
export function buildIssueUrl(input: {
  description: string;
  steps?: string;
  logTail?: string;
}): string {
  const { version, platform, text: environment } = environmentSummary();
  const params = new URLSearchParams({
    template: "bug_report.yml",
    title: `[bug] v${version} / ${platform}`,
    environment,
    version: `v${version}`,
  });
  if (input.description.trim()) {
    params.set("what-happened", clampForUrl(input.description.trim(), 4000));
  }
  params.set("steps", input.steps?.trim() ? clampForUrl(input.steps.trim(), 2000) : "（未提供 / not provided）");
  if (input.logTail) params.set("logs", clampForUrl(input.logTail, LOG_TAIL_URL_LIMIT));
  // The dropdown options must match the template exactly to prefill; the
  // frozen macOS user agent can't tell Apple Silicon from Intel, so only the
  // unambiguous platforms are preset.
  if (platform === "win32") params.set("platform", "Windows");
  else if (platform !== "darwin") params.set("platform", "Other / 其他");
  return `${ISSUE_TRACKER_URL}?${params.toString()}`;
}

/**
 * Open a pre-filled bug report on the public GitHub tracker in the user's
 * browser. Kept as the quick path (e.g. when the desktop host is missing);
 * the in-app report dialog builds on the same URL builder but adds the
 * description box, screenshots, and an automatic log tail.
 */
export function reportIssue(): void {
  openExternalUrl(buildIssueUrl({ description: "" }));
}
