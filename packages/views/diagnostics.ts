import { useEffect, useState } from "react";
import i18next from "i18next";
import { toast } from "sonner";
import { getAppInfoSync, openExternalUrl } from "./app-update";
import { isMacDesktop } from "./layout/use-maximized";

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

/** A staged image (capture or paste): absolute path + local-media preview URL. */
export type StagedScreenshot = { path: string; url: string };

/** Tail of the app log files returned by the desktop host. */
export type LogTail = {
  dir: string;
  tail: string;
  truncated: boolean;
  files: number;
};

/** Host commands backing the problem report flow (Tauri only). */
export type DesktopDiagnosticsApi = {
  readLogs: (maxBytes?: number) => Promise<LogTail>;
  prepareReport: (report: {
    markdown: string;
    attachments: string[];
    includeLogs: boolean;
  }) => Promise<{ dir: string }>;
  revealReportFolder: (path: string) => Promise<void>;
  // Optional: missing on an older host build still installed.
  captureScreenshot?: () => Promise<StagedScreenshot>;
  submitCnbIssue?: (request: {
    endpoint: string;
    title: string;
    body: string;
    screenshotPath?: string | null;
  }) => Promise<{ issueUrl: string; number: number }>;
  openReportWindow?: (title?: string) => Promise<void>;
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

// ── Report channel (CNB issue tracker) ─────────────────────────────────────
// Reports go through the CloudBase `cnb-report` function, which owns the
// CNB token server-side. Only the endpoint URL is build-time config here —
// injected by the app layer at startup; views stay free of env access.

let reportChannel: { endpoint: string } | null = null;

/** Install the build-time report endpoint (no-op without one). */
export function setReportChannel(channel: { endpoint: string } | null): void {
  reportChannel = channel?.endpoint ? channel : null;
}

export function getReportChannel(): { endpoint: string } | null {
  return reportChannel;
}

// ── Shared report flow (singleton dialog store + entry point) ──────────────
// Every entry point (profile menu, sidebar, About window) opens the same
// flow through this store: a standalone window on macOS, the in-app dialog
// elsewhere (window creation can deadlock on Windows, see open-about.ts).
let reportDialogOpen = false;
const reportDialogListeners = new Set<() => void>();

function setReportDialogOpen(open: boolean): void {
  if (reportDialogOpen === open) return;
  reportDialogOpen = open;
  reportDialogListeners.forEach((listener) => listener());
}

// Screenshot captured at open time, shown in the report surface and consumed
// once by whichever face (window or dialog) mounts.
let pendingScreenshot: StagedScreenshot | null = null;
let pendingReportDescription = "";

export function takePendingReportDescription(): string {
  const description = pendingReportDescription;
  pendingReportDescription = "";
  return description;
}

/** Consume the screenshot captured at open time (single-shot). */
export function takePendingScreenshot(): StagedScreenshot | null {
  const screenshot = pendingScreenshot;
  pendingScreenshot = null;
  return screenshot;
}

export function showScreenshotCaptureError(error: unknown): void {
  console.warn("[report-screenshot] capture failed:", error);
  toast.error(i18next.isInitialized ? i18next.t("settings.report_capture_failed") : "Capture failed — please try again");
}

async function openReportDialog(): Promise<void> {
  // Capture while the main window still shows what the user was looking at —
  // the in-app dialog would otherwise cover it. In the standalone window the
  // retake button re-captures the main window directly.
  const api = getDesktopDiagnosticsApi();
  pendingScreenshot = api?.captureScreenshot
    ? await api.captureScreenshot().catch((error: unknown) => {
        showScreenshotCaptureError(error);
        return null;
      })
    : null;
  setReportDialogOpen(true);
}

/**
 * Open the problem report flow: the standalone report window on macOS, the
 * in-app dialog everywhere else (with the GitHub prefilled form as the
 * submission fallback when the CNB channel fails). Contextual reports use
 * the in-app form so their description stays available for review.
 */
export function openReportProblem(): void;
export function openReportProblem(description: string): void;
export function openReportProblem(description?: unknown): void {
  if (typeof description === "string" && description) {
    // Context stays in the shared in-app form until the user submits it.
    pendingReportDescription = description;
    void openReportDialog();
    return;
  }
  const api = getDesktopDiagnosticsApi();
  if (isMacDesktop && api?.openReportWindow) {
    const title = i18next.isInitialized ? i18next.t("settings.report_title") : "Lynse";
    api.openReportWindow(title).catch(() => {
      void openReportDialog();
    });
    return;
  }
  void openReportDialog();
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
