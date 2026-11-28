export type AppInfo = {
  version: string;
  build?: string | null;
  gitSha?: string | null;
  platform: string;
  sandboxed?: boolean;
};

/**
 * Short build metadata line shown underneath the version number
 * (e.g. "Build 107 · a3f9c2d"). Returns null when neither is present.
 */
export function formatAppBuildLabel(
  info: Pick<AppInfo, "build" | "gitSha"> | null | undefined,
): string | null {
  const parts: string[] = [];
  if (info?.build) parts.push(`Build ${info.build}`);
  if (info?.gitSha) parts.push(info.gitSha);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Full version string for diagnostics and issue reports
 * (e.g. "v1.2.18 (Build 107 · a3f9c2d)" or "v1.2.18").
 */
export function formatAppVersionFull(
  info: Pick<AppInfo, "version" | "build" | "gitSha"> | null | undefined,
): string {
  const version = info?.version || "unknown";
  const buildLabel = formatAppBuildLabel(info);
  return buildLabel ? `v${version} (${buildLabel})` : `v${version}`;
}
