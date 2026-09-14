import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import type { Resource } from "i18next";

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "zh-Hans", "zh-Hant", "ja", "ko"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const LOCALE_STORAGE_KEY = "lynse_locale";

/**
 * Map a BCP-47 tag (e.g. "zh-CN", "en-US") onto a supported locale.
 * Exact match wins, then base-language match. Chinese branches on region:
 * zh-TW/HK/MO/Hant → zh-Hant, everything else → zh-Hans. Returns null when
 * nothing matches.
 */
export function matchLocale(tag: string): SupportedLocale | null {
  const normalized = tag.toLowerCase().replace(/_/g, "-");
  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === normalized);
  if (exact) return exact;
  const [base, region] = normalized.split("-");
  if (base === "zh") {
    return region && ["tw", "hk", "mo", "hant"].includes(region)
      ? "zh-Hant"
      : "zh-Hans";
  }
  return (
    SUPPORTED_LOCALES.find((l) => l.toLowerCase().split("-")[0] === base) ??
    null
  );
}

/**
 * Best-effort detection of the system's preferred language from the
 * navigator's ordered language list. Falls back to DEFAULT_LOCALE when the
 * environment exposes no languages or none of them is supported.
 */
export function detectSystemLocale(): SupportedLocale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const candidates = navigator.languages ?? [navigator.language];
  for (const tag of candidates) {
    const match = tag ? matchLocale(tag) : null;
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/**
 * Keep <html lang> in step with the active locale so browsers and assistive
 * tech pick the right pronunciation, quotes, hyphenation and CJK fonts.
 */
function syncDocumentLang(locale: string) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

/**
 * Initialise i18next with the given locale and translation resources.
 * Safe to call multiple — subsequent calls are no-ops once initialised.
 */
export function initI18n(opts: {
  locale?: string;
  resources?: Record<string, Record<string, unknown>>;
}) {
  if (i18next.isInitialized) return;

  // Precedence: persisted choice → caller-supplied locale → system language
  const stored =
    typeof window !== "undefined"
      ? localStorage.getItem(LOCALE_STORAGE_KEY)
      : null;
  const lng = stored || opts.locale || detectSystemLocale();

  i18next.use(initReactI18next).init({
    lng,
    fallbackLng: DEFAULT_LOCALE,
    resources: (opts.resources ?? {}) as Resource,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  syncDocumentLang(lng);
}
