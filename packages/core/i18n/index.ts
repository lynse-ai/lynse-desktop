import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import type { Resource } from "i18next";
import { getEffectiveEdition } from "../config";

export { LYNCLAW_LANGUAGES, currentLynclawLanguage, resolveLynclawLanguage } from "./lynclaw-language";
export type { LynclawLanguage } from "./lynclaw-language";

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
 * Read the first supported language from the system's ordered preferences.
 */
function matchSystemLocale(): SupportedLocale | null {
  if (typeof navigator === "undefined") return null;
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of candidates) {
    const match = tag ? matchLocale(tag) : null;
    if (match) return match;
  }
  return null;
}

export function detectSystemLocale(): SupportedLocale {
  return matchSystemLocale() ?? DEFAULT_LOCALE;
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

export function getSavedLocale(): SupportedLocale | null {
  if (typeof window === "undefined") return null;
  try {
    for (const key of LOCALE_STORAGE_KEYS) {
      const locale = matchLocale(localStorage.getItem(key) ?? "");
      if (locale) return locale;
    }
  } catch {}
  return null;
}

function localeForHost(hostname: string): SupportedLocale | null {
  if (hostname === "lynse.ai" || hostname.endsWith(".lynse.ai")) return "en";
  if (hostname === "lynse.cn" || hostname.endsWith(".lynse.cn")) return "zh-Hans";
  return null;
}

function localeForApiUrl(apiBaseUrl: string): SupportedLocale | null {
  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol === "https:" || url.protocol === "http:") return localeForHost(url.hostname);
  } catch {}
  return null;
}

/** Resolve the application language and the default language sent to chat. */
export function getInitialLocale(optsLocale?: string, apiBaseUrl?: string): SupportedLocale {
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

  const saved = getSavedLocale();
  if (saved) return saved;

  // Auxiliary windows without an API client can still use the saved gateway.
  let savedApiUrl: string | null = null;
  if (apiBaseUrl === undefined && typeof window !== "undefined") {
    try {
      savedApiUrl = localStorage.getItem("lynse_api_url");
    } catch {}
  }
  const selectedApiUrl = apiBaseUrl || savedApiUrl;
  const editionLocale = getEffectiveEdition() === "intl" ? DEFAULT_LOCALE : "zh-Hans";
  const serverLocale = selectedApiUrl
    ? localeForApiUrl(selectedApiUrl)
    : localeForHost(typeof window === "undefined" ? "" : window.location?.hostname ?? "") ?? editionLocale;
  const systemLocale = matchSystemLocale();

  // English system preferences work on either gateway. For a Chinese system
  // with the international gateway selected, default to English.
  if (systemLocale) {
    if (serverLocale === "en" && (systemLocale === "zh-Hans" || systemLocale === "zh-Hant")) {
      return serverLocale;
    }
    return systemLocale;
  }
  return serverLocale ?? editionLocale;
}

let initialLocale: string | undefined;
let activeApiBaseUrl: string | undefined;

export async function refreshLocale(): Promise<void> {
  if (i18next.isInitialized) {
    await i18next.changeLanguage(getInitialLocale(initialLocale, activeApiBaseUrl));
  }
}

export function setLocaleApiBaseUrl(apiBaseUrl: string): void {
  activeApiBaseUrl = apiBaseUrl;
  void refreshLocale();
}

/**
 * Initialise i18next with the given locale and translation resources.
 * Safe to call multiple — subsequent calls are no-ops once initialised.
 */
export function initI18n(opts: {
  locale?: string;
  apiBaseUrl?: string;
  resources?: Record<string, Record<string, unknown>>;
}) {
  if (i18next.isInitialized) return;

  initialLocale = opts.locale;
  activeApiBaseUrl = opts.apiBaseUrl;
  const lng = getInitialLocale(initialLocale, activeApiBaseUrl);

  // Persist only manual choices so automatic defaults can follow changes.
  if (typeof window !== "undefined") {
    window.addEventListener("languagechange", () => { void refreshLocale(); });
    window.addEventListener("storage", (event) => {
      if (event.key === null || LOCALE_STORAGE_KEYS.some((key) => key === event.key)) {
        void refreshLocale();
      }
    });
  }

  i18next.on("languageChanged", syncDocumentLang);
  i18next.use(initReactI18next).init({
    lng,
    fallbackLng: DEFAULT_LOCALE,
    resources: (opts.resources ?? {}) as Resource,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  syncDocumentLang(lng);
}
