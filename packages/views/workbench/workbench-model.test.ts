// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeCustomModel, upsertCustomModel } from "../custom-models";
import {
  loadWorkbenchModelBinding,
  resolveWorkbenchModelOverride,
  saveWorkbenchModelBinding,
  WORKBENCH_MODEL_CHANGED_EVENT,
} from "./workbench-model";

const profile = {
  id: "deepseek", label: "DeepSeek",
  baseUrl: "https://api.deepseek.com", model: "deepseek-flash", createdAt: "2026-11-11T00:00:00.000Z",
};

describe("workbench organize-model binding", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("resolves to nothing until a profile is bound", () => {
    expect(loadWorkbenchModelBinding()).toBeNull();
    expect(resolveWorkbenchModelOverride()).toBeNull();
    upsertCustomModel(profile);
    // An existing profile alone is not a choice: organization never picks one implicitly.
    expect(resolveWorkbenchModelOverride()).toBeNull();
  });

  it("resolves the bound profile into a keyless override and announces changes", () => {
    let events = 0;
    const listener = () => { events += 1; };
    window.addEventListener(WORKBENCH_MODEL_CHANGED_EVENT, listener);
    upsertCustomModel(profile);
    saveWorkbenchModelBinding("deepseek");
    expect(resolveWorkbenchModelOverride()).toEqual({ baseUrl: "https://api.deepseek.com", model: "deepseek-flash", profileId: "deepseek" });
    saveWorkbenchModelBinding(null);
    expect(resolveWorkbenchModelOverride()).toBeNull();
    expect(events).toBe(2);
    window.removeEventListener(WORKBENCH_MODEL_CHANGED_EVENT, listener);
  });

  it("treats a deleted profile as unconfigured", () => {
    upsertCustomModel(profile);
    saveWorkbenchModelBinding("deepseek");
    removeCustomModel("deepseek");
    expect(loadWorkbenchModelBinding()).toBe("deepseek");
    expect(resolveWorkbenchModelOverride()).toBeNull();
  });
});
