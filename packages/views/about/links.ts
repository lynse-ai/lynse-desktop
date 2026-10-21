/**
 * Official site + legal documents opened from the About window and the
 * sign-in agreement row. Policy docs resolve per active locale against the
 * website's four-language markdown set (unified 2026-10-20); locales without
 * a published translation (ko) fall back to English.
 */
export const WEBSITE_URL = "https://www.lynse.cn";
/**
 * Direct-distribution download page. The in-app "view release" affordance and
 * the TestFlight migration prompt both land here; the page itself resolves
 * the latest installer URLs from the updater manifest (see
 * docs/auto-update.md → 官网下载页接入).
 */
export const DOWNLOAD_URL = "https://www.lynse.cn/download";

const POLICY_DOC_SUFFIX: Record<string, string> = {
  "zh-Hans": "cn",
  "zh-Hant": "zh-TW",
  en: "en",
  ja: "ja",
  ko: "en",
};

/** policy-viewer.html URL for a policy doc, resolved for an i18next locale. */
export function policyDocUrl(
  doc: "privacy" | "user-agreement",
  locale: string,
): string {
  const suffix = POLICY_DOC_SUFFIX[locale] ?? "en";
  return `https://www.lynse.cn/policy/policy-viewer.html?md=${doc}-${suffix}.md`;
}

export const termsUrl = (locale: string) =>
  policyDocUrl("user-agreement", locale);
export const privacyUrl = (locale: string) => policyDocUrl("privacy", locale);
