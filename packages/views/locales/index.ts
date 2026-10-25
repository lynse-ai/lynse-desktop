import { inspirationPrivacyLocales } from "../inspiration/privacy-locales";
import { workbenchLocales } from "../workbench/locales";
import en from "./en";
import zh from "./zh";
import ja from "./ja";
import zhHant from "./zh-Hant";
import ko from "./ko";

export const RESOURCES = {
  en: { translation: { ...en, workbench: workbenchLocales.en, inspiration_private: inspirationPrivacyLocales.en } },
  "zh-Hans": { translation: { ...zh, workbench: workbenchLocales["zh-Hans"], inspiration_private: inspirationPrivacyLocales["zh-Hans"] } },
  "zh-Hant": { translation: { ...zhHant, workbench: workbenchLocales["zh-Hant"], inspiration_private: inspirationPrivacyLocales["zh-Hant"] } },
  ja: { translation: { ...ja, workbench: workbenchLocales.ja, inspiration_private: inspirationPrivacyLocales.ja } },
  ko: { translation: { ...ko, workbench: workbenchLocales.ko, inspiration_private: inspirationPrivacyLocales.ko } },
};
