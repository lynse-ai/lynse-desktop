import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInitialLocale, initI18n, LOCALE_STORAGE_KEYS } from "./index";
import { changeLanguage } from "./react";

describe("getInitialLocale", () => {
  let mockStore: Record<string, string> = {};

  beforeEach(() => {
    mockStore = {};
    vi.unstubAllGlobals();
    const mockStorage = {
      getItem: (key: string) => mockStore[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStore[key] = value;
      },
      clear: () => {
        mockStore = {};
      },
      removeItem: (key: string) => {
        delete mockStore[key];
      },
    };
    vi.stubGlobal("localStorage", mockStorage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("prioritizes URL search parameters over stored values and system settings", () => {
    mockStore["lynse_locale"] = "zh-Hans";
    vi.stubGlobal("window", {
      location: {
        search: "?lang=en",
        hostname: "localhost",
      },
    });

    expect(getInitialLocale()).toBe("en");
  });

  it("reads from lynse_locale in localStorage", () => {
    mockStore["lynse_locale"] = "ja";
    vi.stubGlobal("window", {
      location: { search: "", hostname: "localhost" },
    });

    expect(getInitialLocale()).toBe("ja");
  });

  it("reads from lynse-lang (marketing site key) when lynse_locale is not set", () => {
    mockStore["lynse-lang"] = "en";
    vi.stubGlobal("window", {
      location: { search: "", hostname: "localhost" },
    });

    expect(getInitialLocale()).toBe("en");
  });

  it("defaults to en on intl edition when host is lynse.ai even if browser language is Chinese", () => {
    vi.stubGlobal("window", {
      location: { search: "", hostname: "www.lynse.ai" },
    });
    vi.stubGlobal("navigator", {
      languages: ["zh-CN", "zh", "en"],
      language: "zh-CN",
    });

    expect(getInitialLocale()).toBe("en");
  });

  it("respects Japanese browser language on lynse.ai if no preference is stored", () => {
    vi.stubGlobal("window", {
      location: { search: "", hostname: "www.lynse.ai" },
    });
    vi.stubGlobal("navigator", {
      languages: ["ja-JP", "ja", "en"],
      language: "ja-JP",
    });

    expect(getInitialLocale()).toBe("ja");
  });

  it.each([
    { system: "zh-CN", server: "https://api-en.lynse.ai/gateway", expected: "en" },
    { system: "zh-TW", server: "https://api.lynse.cn", expected: "zh-Hant" },
    { system: "en-US", server: "https://gapp.lynse.cn", expected: "en" },
    { system: "ko-KR", server: "https://api-en.lynse.ai", expected: "ko" },
    { system: "es-ES", server: "https://api.lynse.cn", expected: "zh-Hans" },
    { system: "es-ES", server: "https://api-en.lynse.ai", expected: "en" },
    { system: "zh-CN", server: "https://api-en.lynse.ai.example.org", expected: "zh-Hans" },
    { system: "zh-CN", server: "https://custom.run.tcloudbase.com", expected: "zh-Hans" },
  ])("resolves $expected for $system on $server", ({ system, server, expected }) => {
    vi.stubGlobal("navigator", { languages: [system] });
    expect(getInitialLocale(undefined, server)).toBe(expected);
  });

  it("uses the saved application language before the system and server", () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { languages: ["en-GB"] });
    mockStore.lynse_locale = "zh-TW";
    expect(getInitialLocale(undefined, "https://api-en.lynse.ai")).toBe("zh-Hant");
  });

  it("tracks system changes in automatic mode, without saving the detected language", async () => {
    const window = new EventTarget();
    const navigator = { languages: ["zh-CN"] };
    const document = { documentElement: { lang: "" } };
    vi.stubGlobal("window", window);
    vi.stubGlobal("navigator", navigator);
    vi.stubGlobal("document", document);

    initI18n({ apiBaseUrl: "https://api.lynse.cn" });
    expect(i18next.language).toBe("zh-Hans");
    expect(mockStore).toEqual({});

    navigator.languages = ["en-US"];
    window.dispatchEvent(new Event("languagechange"));
    expect(document.documentElement.lang).toBe("en");

    await changeLanguage("en");
    expect(LOCALE_STORAGE_KEYS.every((key) => mockStore[key] === "en")).toBe(true);
    navigator.languages = ["ko-KR"];
    window.dispatchEvent(new Event("languagechange"));
    expect(i18next.language).toBe("en");

    await changeLanguage("auto");
    expect(mockStore).toEqual({});
    expect(document.documentElement.lang).toBe("ko");
  });
});
