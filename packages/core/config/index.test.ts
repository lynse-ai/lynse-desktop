import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  CLOUDBASE_AGENT_URL,
  CLOUDBASE_MEMORY_URL,
  EDITION_STORAGE_KEY,
  agentUrlForApiUrl,
  defaultApiUrlForEdition,
  detectDefaultEdition,
  getEffectiveEdition,
  memoryUrlForApiUrl,
  setEdition,
} from "./index";

describe("edition resolution & persistence", () => {
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
    vi.stubGlobal("window", { localStorage: mockStorage });
  });

  it("prioritizes user's explicit saved preference in localStorage", () => {
    setEdition("intl");
    expect(mockStore[EDITION_STORAGE_KEY]).toBe("intl");
    expect(getEffectiveEdition()).toBe("intl");

    setEdition("cn");
    expect(mockStore[EDITION_STORAGE_KEY]).toBe("cn");
    expect(getEffectiveEdition()).toBe("cn");
  });

  it("detects edition based on environment when no preference is saved", () => {
    delete mockStore[EDITION_STORAGE_KEY];
    const detected = detectDefaultEdition();
    expect(["cn", "intl"]).toContain(detected);
    expect(getEffectiveEdition()).toBe(detected);
  });
});

describe("timezone-first default detection", () => {
  /** Swap in a deterministic timezone + navigator language for detection. */
  function stubEnvironment(timeZone: string | undefined, language: string) {
    // Plain function, not a class: core/config invokes Intl.DateTimeFormat()
    // bare (no `new`), which would throw on a class constructor.
    const FakeDateTimeFormat = function () {
      return {
        resolvedOptions: () => ({ timeZone }) as Intl.ResolvedDateTimeFormatOptions,
      };
    } as unknown as typeof Intl.DateTimeFormat;
    vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: FakeDateTimeFormat });
    vi.stubGlobal("navigator", { language });
  }

  it("maps China-region timezones to cn", () => {
    stubEnvironment("Asia/Shanghai", "en-US");
    expect(detectDefaultEdition()).toBe("cn");
    stubEnvironment("Asia/Hong_Kong", "en-US");
    expect(detectDefaultEdition()).toBe("cn");
  });

  it("maps every other resolvable timezone to intl, even for zh speakers", () => {
    // The timezone is authoritative (user decision, 2026-11-26): language no
    // longer overrides it.
    stubEnvironment("America/Los_Angeles", "zh-CN");
    expect(detectDefaultEdition()).toBe("intl");
    stubEnvironment("Asia/Tokyo", "zh-CN");
    expect(detectDefaultEdition()).toBe("intl");
  });

  it("falls back to the navigator language only when no timezone is available", () => {
    stubEnvironment(undefined, "zh-CN");
    expect(detectDefaultEdition()).toBe("cn");
  });
});

describe("edition → gateway mapping", () => {
  it("sends each packaged edition to its own production account system", () => {
    // The two editions are separate account systems; DEFAULT_API_URL falls
    // back to this mapping whenever a build forgets NEXT_PUBLIC_API_URL.
    expect(defaultApiUrlForEdition("cn")).toBe("https://api.lynse.cn");
    expect(defaultApiUrlForEdition("intl")).toBe("https://api-en.lynse.ai");
  });
});

describe("login environment service routing", () => {
  it("routes every gateway to the single production CloudBase deployment", () => {
    // The staging environment was shut down; the test gateway rides production too.
    expect(agentUrlForApiUrl("https://gapp.lynse.cn/")).toBe(CLOUDBASE_AGENT_URL);
    expect(memoryUrlForApiUrl("https://gapp.lynse.cn")).toBe(CLOUDBASE_MEMORY_URL);
    expect(agentUrlForApiUrl("https://api.lynse.cn")).toBe(CLOUDBASE_AGENT_URL);
    expect(memoryUrlForApiUrl("https://api.lynse.cn/")).toBe(CLOUDBASE_MEMORY_URL);
  });

  it("keeps an absent gateway unset and never routes to the shut-down staging hosts", () => {
    expect(agentUrlForApiUrl(null)).toBeNull();
    expect(agentUrlForApiUrl("https://gapp.lynse.cn.other.invalid")).not.toContain("336033");
    expect(memoryUrlForApiUrl("https://gapp.lynse.cn.other.invalid")).not.toContain("336033");
  });
});
