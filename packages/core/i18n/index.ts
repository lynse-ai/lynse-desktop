import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import type { Resource } from "i18next";

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "zh-Hans", "ja"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const LOCALE_STORAGE_KEY = "lynse_locale";

/**
 * Initialise i18next with the given locale and translation resources.
 * Safe to call multiple — subsequent calls are no-ops once initialised.
 */
export function initI18n(opts: {
  locale?: string;
  resources?: Record<string, Record<string, unknown>>;
}) {
  if (i18next.isInitialized) return;

  // Restore persisted locale or fall back to the provided / default value
  const stored =
    typeof window !== "undefined"
      ? localStorage.getItem(LOCALE_STORAGE_KEY)
      : null;
  const lng = stored || opts.locale || DEFAULT_LOCALE;

  i18next.use(initReactI18next).init({
    lng,
    fallbackLng: DEFAULT_LOCALE,
    resources: (opts.resources ?? {}) as Resource,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}
