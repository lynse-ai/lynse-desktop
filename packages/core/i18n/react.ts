"use client";

import i18next from "i18next";
import { LOCALE_STORAGE_KEYS, matchLocale } from "./index";

export { useTranslation } from "react-i18next";

/**
 * Switch the active language and persist the choice to localStorage across
 * all known storage keys (app and marketing site).
 */
export async function changeLanguage(locale: string) {
  const target = matchLocale(locale) ?? locale;
  await i18next.changeLanguage(target);
  if (typeof window !== "undefined") {
    for (const key of LOCALE_STORAGE_KEYS) {
      try {
        localStorage.setItem(key, target);
      } catch {}
    }
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = target;
  }
}
