export const APP_NAME = "Lynse";
export const APP_URL =
  typeof window !== "undefined" ? window.location.origin : "";

// Core has no Node types (@types/node is out of boundary); declare just the
// shape Next.js injects. The `typeof` guard keeps non-Next shells (Tauri /
// vite) from touching an undefined global, and the literal
// `process.env.NEXT_PUBLIC_*` member expression must stay intact for the
// Next.js compiler to inline it at build time.
declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * Production backend origin. Build-time `NEXT_PUBLIC_API_URL` wins when set
 * (web deployments point it at the live gateway); the hard-coded value is the
 * last-resort fallback when neither a saved server (`lynse_api_url`) nor a
 * build-time default exists: the packaged shells fetch directly from a
 * custom-scheme origin (tauri://localhost), where a relative request URL
 * cannot even be parsed — without a real backend target, sign-in dies with
 * WebKit's "The string did not match the expected pattern."
 */
export const DEFAULT_API_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL) ||
  "https://api.lynse.cn";

/** Test backend origin (the other login-form preset). Kept beside the agent
 *  mapping below: the assistant environment must always move with it. */
export const TEST_API_URL = "https://gapp.lynse.cn";

/** Storage key for the optional dedicated AI-assistant (agent) backend origin.
 *  Empty/absent means the assistant rides the main backend gateway. */
export const AGENT_API_URL_STORAGE_KEY = "lynse_agent_api_url";

/** Connections use the deployed BFF in both development and packaged apps. */
export const DEFAULT_INTEGRATIONS_API_URL = "https://www.lynse.ai";

/** Storage key for an explicitly configured Connections BFF origin. */
export const INTEGRATIONS_API_URL_STORAGE_KEY = "lynse_integrations_api_url";

/**
 * Build-time edition split: one codebase, two packaged products.
 *   - `cn`   ships China-first connectors (Feishu today; WeCom/DingTalk later)
 *   - `intl` ships the overseas set (Google/Outlook/Notion/Todoist; Slack later)
 * Each bundler injects the value as a global define — apps/tauri's
 * vite.config already does (`LYNSE_EDITION=cn|intl pnpm dev:tauri|build`);
 * apps/web should add the same define in next.config. Unconfigured builds
 * fall back to `cn`. Language packs always ship in full; the edition decides
 * the connector list and, later, the default locale.
 */
export type LynseEdition = "cn" | "intl";
declare const __LYNSE_EDITION__: string | undefined;
declare const __LYNSE_DEV__: boolean | undefined;

export const LYNSE_EDITION: LynseEdition =
  typeof __LYNSE_EDITION__ !== "undefined" &&
  (__LYNSE_EDITION__ === "cn" || __LYNSE_EDITION__ === "intl")
    ? __LYNSE_EDITION__
    : "cn";

/** True for dev servers; packaged builds are always false. Used only to gate
 *  debug affordances (e.g. the dev `lynse_edition` view override). */
export const DEV_BUILD: boolean = typeof __LYNSE_DEV__ === "boolean" ? __LYNSE_DEV__ : false;

/**
 * Route B preset: the lynclaw agent service deployed on Tencent CloudBase
 * (云托管), connected to directly — no Lynse gateway in between. The service
 * accepts the Lynse session token and the poll chat contract.
 *
 * The host is the service's default domain per the CloudBase console
 * (`lynclaw-api-319577-10`, user-confirmed 2026-10-10). The earlier
 * `lynclaw-api-321192-9` deployment host routes to the same service and is
 * kept as LEGACY_CLOUDBASE_AGENT_URL only so saved values migrate (see
 * core-provider's boot heal).
 */
export const CLOUDBASE_AGENT_URL =
  "https://lynclaw-api-319577-10-1401959758.sh.run.tcloudbase.com";

export const STAGING_CLOUDBASE_AGENT_URL =
  "https://lynclaw-api-336033-11-1401959758.sh.run.tcloudbase.com";

export const CLOUDBASE_MEMORY_URL =
  "https://lynse-memory-319577-10-1401959758.sh.run.tcloudbase.com";

export const STAGING_CLOUDBASE_MEMORY_URL =
  "https://lynse-memory-336033-11-1401959758.sh.run.tcloudbase.com";

/** Pre-2026-10-10 preset host; routes to the same lynclaw-api service. */
export const LEGACY_CLOUDBASE_AGENT_URL =
  "https://lynclaw-api-321192-9-1401959758.sh.run.tcloudbase.com";

/**
 * Keep the direct CloudBase services on the selected login environment.
 * Identity is still derived by the service from the Lynse session token.
 */
function isTestApiUrl(apiUrl: string | null | undefined): boolean {
  if (!apiUrl) return false;
  try {
    return new URL(apiUrl).origin === TEST_API_URL;
  } catch {
    return false;
  }
}

export function agentUrlForApiUrl(apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  return isTestApiUrl(apiUrl) ? STAGING_CLOUDBASE_AGENT_URL : CLOUDBASE_AGENT_URL;
}

export function memoryUrlForApiUrl(apiUrl: string | null | undefined): string {
  return isTestApiUrl(apiUrl) ? STAGING_CLOUDBASE_MEMORY_URL : CLOUDBASE_MEMORY_URL;
}
