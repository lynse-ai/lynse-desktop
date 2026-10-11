/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_OVERRIDE_STORAGE_KEY,
  fetchModelPresets,
  isHttpUrl,
  loadChatModelSetting,
  parseChatModelSetting,
  saveChatModelSetting,
  toRequestOverride,
} from "./model-override";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  getAgentBaseUrl: vi.fn((): string | null => null),
}));

vi.mock("@lynse/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lynse/core/api")>();
  return {
    ...actual,
    api: () => ({
      get: apiMocks.get,
      getAgentBaseUrl: apiMocks.getAgentBaseUrl,
    }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(MODEL_OVERRIDE_STORAGE_KEY);
});

beforeEach(() => {
  // No dedicated agent backend unless a test opts in.
  apiMocks.getAgentBaseUrl.mockReturnValue(null);
});

describe("parseChatModelSetting", () => {
  it("falls back to default for absent or malformed input", () => {
    expect(parseChatModelSetting(null)).toEqual({ mode: "default" });
    expect(parseChatModelSetting("x")).toEqual({ mode: "default" });
    expect(parseChatModelSetting({ mode: "otherwise" })).toEqual({ mode: "default" });
  });

  it("keeps a complete preset pick and drops the empty key", () => {
    expect(parseChatModelSetting({ mode: "preset", presetId: "p1", model: "m1" })).toEqual({
      mode: "preset",
      presetId: "p1",
      model: "m1",
    });
    expect(
      parseChatModelSetting({ mode: "preset", presetId: " p1 ", model: " m1 ", apiKey: "  " }),
    ).toEqual({ mode: "preset", presetId: "p1", model: "m1" });
  });

  it("degrades an incomplete preset pick to default (never a 400 turn)", () => {
    expect(parseChatModelSetting({ mode: "preset", presetId: "p1" })).toEqual({ mode: "default" });
    expect(parseChatModelSetting({ mode: "preset", model: "m1" })).toEqual({ mode: "default" });
  });

  it("keeps a complete custom endpoint, trimmed", () => {
    expect(
      parseChatModelSetting({
        mode: "custom",
        baseUrl: " https://gw.example.com/v1 ",
        apiKey: " sk-1 ",
        model: " m1 ",
      }),
    ).toEqual({ mode: "custom", baseUrl: "https://gw.example.com/v1", apiKey: "sk-1", model: "m1" });
  });

  it("degrades an incomplete or non-http custom endpoint to default", () => {
    expect(
      parseChatModelSetting({ mode: "custom", baseUrl: "https://gw.example.com/v1", model: "m1" }),
    ).toEqual({ mode: "default" });
    expect(
      parseChatModelSetting({
        mode: "custom",
        baseUrl: "ftp://gw.example.com/v1",
        apiKey: "k",
        model: "m1",
      }),
    ).toEqual({ mode: "default" });
  });
});

describe("setting storage", () => {
  it("round-trips a custom setting through localStorage", () => {
    const setting = { mode: "custom" as const, baseUrl: "https://gw.example.com/v1", apiKey: "sk-1", model: "m1" };
    saveChatModelSetting(setting);
    expect(loadChatModelSetting()).toEqual(setting);
    expect(JSON.parse(localStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY)!)).toEqual(setting);
  });

  it("removes the key entirely when switching back to default", () => {
    saveChatModelSetting({ mode: "preset", presetId: "p1", model: "m1" });
    expect(localStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY)).not.toBeNull();
    saveChatModelSetting({ mode: "default" });
    expect(localStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY)).toBeNull();
    expect(loadChatModelSetting()).toEqual({ mode: "default" });
  });

  it("degrades corrupt storage to default instead of throwing", () => {
    localStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, "{not json");
    expect(loadChatModelSetting()).toEqual({ mode: "default" });
    localStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, "5");
    expect(loadChatModelSetting()).toEqual({ mode: "default" });
  });
});

describe("toRequestOverride", () => {
  it("sends nothing for the default mode", () => {
    expect(toRequestOverride({ mode: "default" })).toBeNull();
  });

  it("maps the preset shape with an optional key", () => {
    expect(toRequestOverride({ mode: "preset", presetId: "p1", model: "m1" })).toEqual({
      preset: "p1",
      model: "m1",
    });
    expect(
      toRequestOverride({ mode: "preset", presetId: "p1", model: "m1", apiKey: "sk-1" }),
    ).toEqual({ preset: "p1", model: "m1", apiKey: "sk-1" });
  });

  it("maps a complete custom endpoint and rejects an incomplete one", () => {
    expect(
      toRequestOverride({ mode: "custom", baseUrl: "https://gw.example.com/v1", apiKey: "sk-1", model: "m1" }),
    ).toEqual({ baseUrl: "https://gw.example.com/v1", apiKey: "sk-1", model: "m1" });
    expect(toRequestOverride({ mode: "custom", baseUrl: "not a url", apiKey: "sk-1", model: "m1" })).toBeNull();
  });
});

describe("isHttpUrl", () => {
  it("accepts http(s) URLs only", () => {
    expect(isHttpUrl("https://api.example.com/v1")).toBe(true);
    expect(isHttpUrl("http://10.0.0.1:8000")).toBe(true);
    expect(isHttpUrl("ftp://api.example.com")).toBe(false);
    expect(isHttpUrl("api.example.com")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("fetchModelPresets", () => {
  const preset = {
    id: "deepseek-official",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-flash",
    useResponses: true,
    requiresApiKey: false,
  };

  it("uses the gateway path when riding the main backend", async () => {
    apiMocks.get.mockResolvedValue({ presets: [preset] });

    await expect(fetchModelPresets()).resolves.toEqual([preset]);
    expect(apiMocks.get).toHaveBeenCalledWith("/api/business/ai/model/presets", {
      baseUrl: undefined,
    });
  });

  it("uses the native path with the agent base URL on a direct connection", async () => {
    const agentBase = "https://lynclaw-api-319577-10-1401959758.sh.run.tcloudbase.com";
    apiMocks.getAgentBaseUrl.mockReturnValue(agentBase);
    apiMocks.get.mockResolvedValue({ presets: [preset] });

    await expect(fetchModelPresets()).resolves.toEqual([preset]);
    expect(apiMocks.get).toHaveBeenCalledWith("/api/model/presets", { baseUrl: agentBase });
  });

  it("drops malformed entries and tolerates a missing list", async () => {
    apiMocks.get.mockResolvedValue({
      presets: [preset, { id: "broken" }, null, "junk"],
    });
    await expect(fetchModelPresets()).resolves.toEqual([preset]);

    apiMocks.get.mockResolvedValue({});
    await expect(fetchModelPresets()).resolves.toEqual([]);
  });

  it("propagates request failures to the caller", async () => {
    apiMocks.get.mockRejectedValue(new Error("503"));
    await expect(fetchModelPresets()).rejects.toThrow("503");
  });
});
