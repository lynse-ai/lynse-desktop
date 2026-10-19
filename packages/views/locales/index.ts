import { workbenchLocales } from "../workbench/locales";
import en from "./en";
import zh from "./zh";
import ja from "./ja";
import zhHant from "./zh-Hant";
import ko from "./ko";

export const RESOURCES = {
  en: { translation: { ...en, workbench: workbenchLocales.en } },
  "zh-Hans": { translation: { ...zh, workbench: workbenchLocales["zh-Hans"] } },
  "zh-Hant": { translation: { ...zhHant, workbench: workbenchLocales["zh-Hant"] } },
  ja: { translation: { ...ja, workbench: workbenchLocales.ja } },
  ko: { translation: { ...ko, workbench: workbenchLocales.ko } },
};
