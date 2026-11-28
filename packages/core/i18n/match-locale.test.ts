import { describe, expect, it } from "vitest";
import { LYNCLAW_LANGUAGES, matchLocale, resolveLynclawLanguage } from "./index";

describe("matchLocale", () => {
  it("matches supported locales exactly, case-insensitively", () => {
    expect(matchLocale("en")).toBe("en");
    expect(matchLocale("zh-Hans")).toBe("zh-Hans");
    expect(matchLocale("ZH-HANT")).toBe("zh-Hant");
    expect(matchLocale("ja")).toBe("ja");
    expect(matchLocale("ko")).toBe("ko");
  });

  it("accepts underscore separators", () => {
    expect(matchLocale("zh_CN")).toBe("zh-Hans");
  });

  it("maps regional tags onto their base locale", () => {
    expect(matchLocale("en-US")).toBe("en");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("ja-JP")).toBe("ja");
    expect(matchLocale("ko-KR")).toBe("ko");
  });

  it("branches Chinese on region script", () => {
    expect(matchLocale("zh")).toBe("zh-Hans");
    expect(matchLocale("zh-CN")).toBe("zh-Hans");
    expect(matchLocale("zh-SG")).toBe("zh-Hans");
    expect(matchLocale("zh-TW")).toBe("zh-Hant");
    expect(matchLocale("zh-HK")).toBe("zh-Hant");
    expect(matchLocale("zh-MO")).toBe("zh-Hant");
    expect(matchLocale("zh-Hant-HK")).toBe("zh-Hant");
    expect(matchLocale("zh-Hans-CN")).toBe("zh-Hans");
  });

  it("returns null for unsupported languages", () => {
    expect(matchLocale("fr")).toBeNull();
    expect(matchLocale("de-DE")).toBeNull();
    expect(matchLocale("")).toBeNull();
  });
});

describe("resolveLynclawLanguage", () => {
  it("supports all 15 Lynclaw standard language codes and BCP-47 variants", () => {
    for (const code of LYNCLAW_LANGUAGES) {
      expect(resolveLynclawLanguage(code)).toBe(code);
    }
    expect(resolveLynclawLanguage("en-US")).toBe("en");
    expect(resolveLynclawLanguage("en_GB")).toBe("en");
    expect(resolveLynclawLanguage("zh-Hans")).toBe("zh");
    expect(resolveLynclawLanguage("zh_CN")).toBe("zh");
    expect(resolveLynclawLanguage("zh-Hans-TW")).toBe("zh");
    expect(resolveLynclawLanguage("zh-Hant")).toBe("zh-hant");
    expect(resolveLynclawLanguage("zh-TW")).toBe("zh-hant");
    expect(resolveLynclawLanguage("zh_HK")).toBe("zh-hant");
    expect(resolveLynclawLanguage("zh-MO")).toBe("zh-hant");
    expect(resolveLynclawLanguage("zh-Hant-TW")).toBe("zh-hant");
    expect(resolveLynclawLanguage("es-MX")).toBe("es");
    expect(resolveLynclawLanguage("pt-BR")).toBe("pt");
    expect(resolveLynclawLanguage("fr-CA")).toBe("fr");
    expect(resolveLynclawLanguage("ja-JP")).toBe("ja");
    expect(resolveLynclawLanguage("ko-KR")).toBe("ko");
  });

  it("omits auto, empty, and unsupported language values to avoid HTTP 422", () => {
    for (const raw of ["", "  ", "auto", "AUTO", "system", "default", "nl", "nl-NL", "sv", "pl", null, undefined]) {
      expect(resolveLynclawLanguage(raw)).toBeUndefined();
    }
  });
});
