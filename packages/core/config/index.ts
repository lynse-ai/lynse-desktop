export const APP_NAME = "Lynse";
export const APP_URL =
  typeof window !== "undefined" ? window.location.origin : "";

/**
 * Production backend origin. The last-resort fallback when neither a saved
 * server (`lynse_api_url`) nor a build-time default exists: the packaged
 * shells fetch directly from a custom-scheme origin (tauri://localhost),
 * where a relative request URL cannot even be parsed — without a real
 * backend target, sign-in dies with WebKit's "The string did not match the
 * expected pattern."
 */
export const DEFAULT_API_URL = "https://api.lynse.cn";

/** Storage key for the optional dedicated AI-assistant (agent) backend origin.
 *  Empty/absent means the assistant rides the main backend gateway. */
export const AGENT_API_URL_STORAGE_KEY = "lynse_agent_api_url";

/**
 * Route B preset: the lynclaw agent service deployed on Tencent CloudRun,
 * connected to directly — no Lynse gateway in between. The service accepts
 * the Lynse session token and the poll chat contract.
 */
export const CLOUDRUN_AGENT_URL =
  "https://lynclaw-api-319577-10-1401959758.sh.run.tcloudbase.com";
