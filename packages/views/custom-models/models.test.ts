// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_MODELS_CHANGED_EVENT,
  getCustomModel,
  isValidProfileId,
  loadCustomModels,
  removeCustomModel,
  suggestProfileId,
  toCompletionBase,
  toModelOverride,
  upsertCustomModel,
} from "./models";
import type { CustomModelProfile } from "./types";

const deepseek: CustomModelProfile = {
  id: "deepseek", label: "DeepSeek",
  baseUrl: "https://api.deepseek.com", model: "deepseek-flash", createdAt: "2026-11-11T00:00:00.000Z",
};
const custom: CustomModelProfile = {
  id: "local-vllm", label: "Local vLLM",
  baseUrl: "http://127.0.0.1:8000/v1", model: "qwen3", createdAt: "2026-11-11T00:00:00.000Z",
};

describe("custom model profile store", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("round-trips profiles and announces every write", () => {
    let events = 0;
    const listener = () => { events += 1; };
    window.addEventListener(CUSTOM_MODELS_CHANGED_EVENT, listener);
    upsertCustomModel(deepseek);
    upsertCustomModel(custom);
    upsertCustomModel({ ...deepseek, model: "deepseek-v4-pro" });
    expect(loadCustomModels().map((profile) => profile.id)).toEqual(["deepseek", "local-vllm"]);
    expect(getCustomModel("deepseek")?.model).toBe("deepseek-v4-pro");
    expect(removeCustomModel("deepseek").map((profile) => profile.id)).toEqual(["local-vllm"]);
    expect(events).toBe(4);
    window.removeEventListener(CUSTOM_MODELS_CHANGED_EVENT, listener);
  });

  it("drops malformed entries instead of throwing", () => {
    localStorage.setItem("lynse_custom_models", JSON.stringify([
      deepseek, { id: "", label: "x" }, { ...custom, baseUrl: "ftp://nope" }, "junk", null,
    ]));
    expect(loadCustomModels()).toEqual([deepseek]);
    localStorage.setItem("lynse_custom_models", "{not json");
    expect(loadCustomModels()).toEqual([]);
  });

  it("builds a keyless endpoint override that references the profile", () => {
    // Profiles always carry their explicit endpoint; neither the override nor
    // the completion prefix ever carries an API key — the desktop attaches
    // the vaulted one per request.
    expect(toModelOverride(deepseek)).toEqual({ baseUrl: "https://api.deepseek.com", model: "deepseek-flash", profileId: "deepseek" });
    expect(toModelOverride(custom)).toEqual({ baseUrl: "http://127.0.0.1:8000/v1", model: "qwen3", profileId: "local-vllm" });
    expect(JSON.stringify([toModelOverride(deepseek), toModelOverride(custom)])).not.toContain("apiKey");
    expect(toCompletionBase(deepseek)).toEqual({ profileId: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" });
  });

  it("suggests unique, vault-safe ids", () => {
    upsertCustomModel(deepseek);
    expect(suggestProfileId("DeepSeek")).toBe("deepseek-2");
    expect(suggestProfileId("我的模型")).toBe("model");
    expect(isValidProfileId("deepseek-2")).toBe(true);
    expect(isValidProfileId("../escape")).toBe(false);
    expect(isValidProfileId("a".repeat(65))).toBe(false);
  });
});
