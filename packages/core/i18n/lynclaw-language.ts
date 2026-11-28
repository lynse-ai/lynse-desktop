import i18next from "i18next";

/** The 15 language codes the Lynclaw agent accepts; anything else is a 422. */
export const LYNCLAW_LANGUAGES = [
  "zh", "zh-hant", "en", "ar", "es", "fr", "pt", "de", "it", "ru", "ja", "ko", "vi", "th", "id",
] as const;
export type LynclawLanguage = (typeof LYNCLAW_LANGUAGES)[number];

const PLAIN_LANGUAGES: ReadonlySet<string> = new Set(LYNCLAW_LANGUAGES.filter((code) => code !== "zh-hant"));
const UNSET_VALUES: ReadonlySet<string> = new Set(["auto", "system", "default"]);
const TRADITIONAL_CHINESE_SUBTAGS: ReadonlySet<string> = new Set(["hant", "tw", "hk", "mo"]);

/**
 * Map a UI or transcript language tag onto a Lynclaw language code.
 * Returns undefined for empty, "auto"-style or unsupported tags so callers
 * omit the field and the agent falls back to the bound gateway's default.
 */
export function resolveLynclawLanguage(raw?: string | null): LynclawLanguage | undefined {
  const tag = (raw ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!tag || UNSET_VALUES.has(tag)) return undefined;
  const [primary = "", ...subtags] = tag.split("-");
  if (primary === "zh") {
    if (subtags.includes("hans")) return "zh";
    return subtags.some((subtag) => TRADITIONAL_CHINESE_SUBTAGS.has(subtag)) ? "zh-hant" : "zh";
  }
  return PLAIN_LANGUAGES.has(primary) ? (primary as LynclawLanguage) : undefined;
}

/** The active interface language as a Lynclaw code, or undefined when unknown. */
export function currentLynclawLanguage(): LynclawLanguage | undefined {
  return resolveLynclawLanguage(i18next.resolvedLanguage ?? i18next.language);
}
