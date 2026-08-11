// Shared language option tables for the live-translation / transcription
// views. Extracted from live-translation-page so the transcript detail page
// can reuse the exact same list without duplicating ~55 lines.
//
// Languages follow the iLiveData ISO-639-1 code list
// (https://docs.ilivedata.com/alt/techdoc/language/). 简体中文 keeps the
// legacy `zh` code so the production `lynse_backend` path is unaffected; all
// other entries use the documented iLiveData codes.

export const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: "zh", label: "中文（简体）" },
  { code: "zh-TW", label: "中文（繁体）" },
  { code: "zh-yue", label: "粤语" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "ru", label: "Русский" },
  { code: "pt", label: "Português" },
  { code: "it", label: "Italiano" },
  { code: "ar", label: "العربية" },
  { code: "hi", label: "हिन्दी" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "ms", label: "Bahasa Melayu" },
  { code: "tr", label: "Türkçe" },
  { code: "tl", label: "Tagalog" },
  { code: "el", label: "Ελληνικά" },
  { code: "fa", label: "فارسی" },
  { code: "ur", label: "اردو" },
  { code: "bn", label: "বাংলা" },
  { code: "gu", label: "ગુજરાતી" },
  { code: "mr", label: "मराठी" },
  { code: "pa", label: "ਪੰਜਾਬੀ" },
  { code: "ta", label: "தமிழ்" },
  { code: "te", label: "తెలుగు" },
  { code: "kn", label: "ಕನ್ನಡ" },
  { code: "ml", label: "മലയാളം" },
  { code: "my", label: "မြန်မာ" },
  { code: "km", label: "ខ្មែរ" },
  { code: "lo", label: "ລາວ" },
  { code: "he", label: "עברית" },
  { code: "ro", label: "Română" },
  { code: "hu", label: "Magyar" },
  { code: "cs", label: "Čeština" },
  { code: "sk", label: "Slovenčina" },
  { code: "hr", label: "Hrvatski" },
  { code: "fi", label: "Suomi" },
  { code: "da", label: "Dansk" },
  { code: "bg", label: "Български" },
  { code: "uk", label: "Українська" },
  { code: "et", label: "Eesti" },
  { code: "sq", label: "Shqip" },
  { code: "no", label: "Norsk" },
  { code: "nl", label: "Nederlands" },
  { code: "sv", label: "Svenska" },
  { code: "ps", label: "پښتو" },
];

// Source language may also be auto-detected by iLiveData.
export const SOURCE_LANGUAGE_OPTIONS = [{ code: "auto", label: "自动识别" }, ...LANGUAGE_OPTIONS];
export const TARGET_LANGUAGE_OPTIONS = [{ code: "none", label: "不翻译" }, ...LANGUAGE_OPTIONS];
export const LANGUAGE_BY_CODE = Object.fromEntries(
  LANGUAGE_OPTIONS.map((option) => [option.code, option]),
);

// Compact, language-neutral direction label for header badges / selectors,
// e.g. "自动 → 英" / "ZH → EN". Auto/none use localized short words,
// everything else uses the uppercase ISO-639-1 code.
export function directionLabel(
  source: string,
  target: string,
  t: (key: string) => string,
): string {
  const sourceLabel = source === "auto" ? t("live_translation.auto_short") : source.toUpperCase().slice(0, 2);
  if (target === "none") return sourceLabel; // transcription-only mode
  const targetLabel = target.toUpperCase().slice(0, 2);
  return `${sourceLabel} → ${targetLabel}`;
}
