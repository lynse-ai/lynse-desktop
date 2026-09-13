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
