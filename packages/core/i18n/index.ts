import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import type { Resource } from "i18next";
import { getEffectiveEdition } from "../config";

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "zh-Hans", "zh-Hant", "ja", "ko"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_STORAGE_KEY = "lynse_locale";
export const LOCALE_STORAGE_KEYS = [
  "lynse_locale",
  "lynse-lang",
  "lynse_lang",
] as const;

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

export type ReleaseNotesLocales = Readonly<Partial<Record<SupportedLocale, string>>>;

/** Validate optional updater metadata before it reaches the interface. */
export function normalizeReleaseNotesLocales(value: unknown): ReleaseNotesLocales {
  const notes: Partial<Record<SupportedLocale, string>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return notes;
  for (const [tag, text] of Object.entries(value)) {
    const locale = matchLocale(tag);
    if (locale && typeof text === "string" && text.trim()) {
      notes[locale] = text.trim();
    }
  }
  return notes;
}

/** Follow the application language, falling back to English or legacy notes. */
export function selectReleaseNotes(notes: unknown, localized: unknown, language: string): string | null {
  const translations = normalizeReleaseNotesLocales(localized);
  const locale = matchLocale(language) ?? DEFAULT_LOCALE;
  return translations[locale] ?? translations.en ??
    (typeof notes === "string" && notes.trim() ? notes.trim() : null);
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
 * Determine the initial locale with the following precedence:
 * 1. URL search parameter (?lng=, ?lang=, ?locale=)
 * 2. Caller-supplied locale option
 * 3. Persisted user choice in localStorage (app key "lynse_locale", marketing key "lynse-lang", or "lynse_lang")
 * 4. In international edition (LYNSE_EDITION === "intl" or hostname ending with ".ai"):
 *    Default to "en" (or "ja"/"ko" if user's system language explicitly starts with those),
 *    matching the international marketing site on www.lynse.ai which defaults to English.
 * 5. Best-effort system language detection
 */
export function getInitialLocale(optsLocale?: string): SupportedLocale {
  // 1. URL search params (e.g. ?lng=en, ?lang=en, ?locale=en)
  if (typeof window !== "undefined" && window.location?.search) {
    try {
      const params = new URLSearchParams(window.location.search);
      const queryParam = params.get("lng") || params.get("lang") || params.get("locale");
      if (queryParam) {
        const matched = matchLocale(queryParam);
        if (matched) return matched;
      }
    } catch {}
  }

  // 2. Caller-supplied locale option
  if (optsLocale) {
    const matched = matchLocale(optsLocale);
    if (matched) return matched;
  }

  // 3. Persisted choice in localStorage (supports app and marketing website keys)
  if (typeof window !== "undefined") {
    try {
      for (const key of LOCALE_STORAGE_KEYS) {
        const stored = localStorage.getItem(key);
        if (stored) {
          const matched = matchLocale(stored);
          if (matched) return matched;
        }
      }
    } catch {}
  }

  // 4. In international edition (getEffectiveEdition() === "intl" or host ends with .ai):
  // Global site defaults to English, unless system language explicitly matches ja or ko.
  const isIntlEdition =
    getEffectiveEdition() === "intl" ||
    (typeof window !== "undefined" &&
      (window.location?.hostname === "lynse.ai" ||
        window.location?.hostname?.endsWith(".lynse.ai") ||
        window.location?.hostname?.endsWith(".ai")));

  if (isIntlEdition) {
    if (typeof navigator !== "undefined") {
      const candidates = navigator.languages ?? [navigator.language];
      for (const tag of candidates) {
        if (!tag) continue;
        const lower = tag.toLowerCase();
        if (lower.startsWith("ja")) return "ja";
        if (lower.startsWith("ko")) return "ko";
      }
    }
    return DEFAULT_LOCALE;
  }

  // 5. Fallback: system language detection
  return detectSystemLocale();
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

  const lng = getInitialLocale(opts.locale);

  // Sync to localStorage keys so both the app and the marketing site are aligned
  if (typeof window !== "undefined") {
    try {
      for (const key of LOCALE_STORAGE_KEYS) {
        if (!localStorage.getItem(key)) {
          localStorage.setItem(key, lng);
        }
      }
    } catch {}

    // Listen for storage changes from other tabs or the marketing site
    try {
      window.addEventListener("storage", (e) => {
        if (e.key && (LOCALE_STORAGE_KEYS as readonly string[]).includes(e.key) && e.newValue) {
          const matched = matchLocale(e.newValue);
          if (matched && matched !== i18next.language) {
            void i18next.changeLanguage(matched);
            syncDocumentLang(matched);
          }
        }
      });
    } catch {}
  }

  i18next.use(initReactI18next).init({
    lng,
    fallbackLng: DEFAULT_LOCALE,
    resources: (opts.resources ?? {}) as Resource,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  syncDocumentLang(lng);
}
