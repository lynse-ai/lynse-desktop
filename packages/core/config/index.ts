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

/** Storage key for the optional dedicated AI-assistant (agent) backend origin.
 *  Empty/absent means the assistant rides the main backend gateway. */
export const AGENT_API_URL_STORAGE_KEY = "lynse_agent_api_url";

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
