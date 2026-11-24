import { beforeEach, describe, expect, it, vi } from "vitest";
import { getInitialLocale } from "./index";

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
});
