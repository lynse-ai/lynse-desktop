"use client";

import i18next from "i18next";
import { LOCALE_STORAGE_KEYS, matchLocale, refreshLocale } from "./index";

export { useTranslation } from "react-i18next";

/**
 * Switch the active language and persist the choice to localStorage across
 * all known storage keys (app and marketing site).
 */
export async function changeLanguage(locale: string) {
  const target = matchLocale(locale) ?? locale;
  if (typeof window !== "undefined") {
    for (const key of LOCALE_STORAGE_KEYS) {
      try {
        if (target === "auto") localStorage.removeItem(key);
        else localStorage.setItem(key, target);
      } catch {}
    }
  }
  if (target === "auto") await refreshLocale();
  else await i18next.changeLanguage(target);
}
