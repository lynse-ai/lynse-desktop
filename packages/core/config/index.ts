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
 * Route B preset: the lynclaw agent service deployed on Tencent CloudRun,
 * connected to directly — no Lynse gateway in between. The service accepts
 * the Lynse session token and the poll chat contract.
 *
 * Deployment `lynclaw-api-321192-9` replaced the retired `319577-10` one
 * (user-confirmed 2026-09-30); the old host must not be referenced anywhere.
 */
export const CLOUDRUN_AGENT_URL =
  "https://lynclaw-api-321192-9-1401959758.sh.run.tcloudbase.com";

/**
 * Canonical assistant origin per business backend. File ids (notes, mentions,
 * conclusion inserts) are minted per environment, so the assistant must serve
 * the same environment the business session is on — a test-backend session
 * chats with the test lynclaw deployment, and production rides the production
 * gateway. Returning null means "follow the main backend" (route A).
 */
export function agentUrlForApiUrl(apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  const url = apiUrl.replace(/\/+$/, "");
  if (url === TEST_API_URL) return CLOUDRUN_AGENT_URL;
  return null;
}
