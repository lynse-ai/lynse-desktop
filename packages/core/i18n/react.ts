"use client";

import i18next from "i18next";

export { useTranslation } from "react-i18next";

const LOCALE_STORAGE_KEY = "lynse_locale";

/**
 * Switch the active language and persist the choice to localStorage.
 */
export async function changeLanguage(locale: string) {
  await i18next.changeLanguage(locale);
  if (typeof window !== "undefined") {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }
}
