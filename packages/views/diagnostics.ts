import { getAppInfoSync, openExternalUrl } from "./app-update";

const ISSUE_TRACKER_URL = "https://github.com/lynse-ai/lynse-desktop/issues/new";

/** Reveal the desktop log folder in the system file manager (Tauri host only). */
export function openLogsFolder(): void {
  const desktopWindow = window as Window & {
    desktopAPI?: { app?: { openLogsFolder?: () => Promise<void> } };
  };
  void desktopWindow.desktopAPI?.app?.openLogsFolder?.();
}

/**
 * Open a pre-filled bug report on the public GitHub tracker in the user's
 * browser. Creating an issue through the API requires a token, which can
 * never ship safely inside a client build — so the user reviews and submits
 * the pre-filled form with their own GitHub session instead. Fields map to
 * the ids in .github/ISSUE_TEMPLATE/bug_report.yml.
 */
export function reportIssue(): void {
  const appInfo = getAppInfoSync();
  const version = appInfo?.version || "unknown";
  const platform = appInfo?.platform ?? "unknown";
  const environment = [
    `- App: v${version}`,
    `- Platform: ${platform}`,
    `- User agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    `- Date: ${new Date().toISOString()}`,
  ].join("\n");
  const params = new URLSearchParams({
    template: "bug_report.yml",
    title: `[bug] v${version} / ${platform}`,
    environment,
    logs: "请粘贴日志相关片段 / Paste the relevant excerpt from Settings → About → View logs.",
  });
  // The dropdown options must match the template exactly to prefill; the
  // frozen macOS user agent can't tell Apple Silicon from Intel, so only the
  // unambiguous platforms are preset.
  if (platform === "win32") params.set("platform", "Windows");
  else if (platform !== "darwin") params.set("platform", "Other / 其他");
  openExternalUrl(`${ISSUE_TRACKER_URL}?${params.toString()}`);
}
