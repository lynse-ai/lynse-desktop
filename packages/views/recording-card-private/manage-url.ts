/**
 * Desktop → web management page URL mapping.
 *
 * The browser session is per-origin (localStorage), so the desktop app must
 * open the deployment that fronts the SAME account system the user is
 * signed into. The pairing is fixed by deployment topology:
 *
 *   api.lynse.cn    (CN production)  → https://www.lynse.cn
 *   gapp.lynse.cn   (test)           → https://www.lynse.ai
 *   api-en.lynse.ai (intl production) → https://www.lynse.ai
 *
 * Anything else (unknown host, unparseable URL) falls back to the CN site,
 * the default distribution channel.
 */

export const RECORDING_CARD_MANAGE_PATH = "/plugins/recording-card";

const API_HOST_TO_WEB_ORIGIN: Record<string, string> = {
  "api.lynse.cn": "https://www.lynse.cn",
  "gapp.lynse.cn": "https://www.lynse.ai",
  "api-en.lynse.ai": "https://www.lynse.ai",
};

const DEFAULT_WEB_ORIGIN = "https://www.lynse.cn";

/** Production web deployments serve the Next app under the /app subpath. */
const WEB_APP_BASE_PATH = "/app";

export function buildRecordingCardManageUrl(apiBaseUrl: string): string {
  let host = "";
  try {
    host = new URL(apiBaseUrl).host;
  } catch {
    host = "";
  }
  const origin = API_HOST_TO_WEB_ORIGIN[host] ?? DEFAULT_WEB_ORIGIN;
  return `${origin}${WEB_APP_BASE_PATH}${RECORDING_CARD_MANAGE_PATH}`;
}
