/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { bindInspirationCloud, memoryApiBase, syncInspirationCloud, DEFAULT_MEMORY_API_URL } from "./cloud";
const fixture = vi.hoisted(() => ({ bind: vi.fn(), sync: vi.fn(), enabled: false, token: "new-account-token", host: "https://login.test" }));
vi.mock("../feature-flags", () => ({ featureFlags: { get inspirationCloudSync() { return fixture.enabled; } } }));
vi.mock("./desktop-api", () => ({ getDesktopInspirationApi: () => ({ cloudBind: fixture.bind, cloudSync: fixture.sync }) }));
vi.mock("@lynse/core/api", () => ({api:()=>({getToken:()=>fixture.token,getBaseUrl:()=>fixture.host})}));
afterEach(() => {vi.unstubAllGlobals();fixture.bind.mockReset();fixture.sync.mockReset();fixture.enabled=false;fixture.host="https://login.test";localStorage.clear();});
it("disables cloud binding and sync even on staging with a saved endpoint", async () => {
  const { featureFlags } = await vi.importActual<typeof import("../feature-flags")>("../feature-flags");
  expect(featureFlags.inspirationCloudSync).toBe(false);
  fixture.host = "https://gapp.lynse.cn";
  localStorage.setItem("lynse_memory_api_url", "https://custom.invalid");
  expect(memoryApiBase()).toBe("");
  await expect(bindInspirationCloud()).resolves.toBeNull();
  await expect(syncInspirationCloud()).resolves.toBeNull();
  expect(fixture.bind).not.toHaveBeenCalled();
  expect(fixture.sync).not.toHaveBeenCalled();
});
it("moves the default and previously saved production preset to staging with the login gateway", () => {
  fixture.enabled = true;
  fixture.host="https://gapp.lynse.cn";
  const staging="https://lynse-memory-336033-11-1401959758.sh.run.tcloudbase.com";
  expect(memoryApiBase()).toBe(staging);
  localStorage.setItem("lynse_memory_api_url",DEFAULT_MEMORY_API_URL);
  expect(memoryApiBase()).toBe(staging);
  localStorage.setItem("lynse_memory_api_url",staging);
});
it("keeps production local-only even when an override tries to re-enable cloud (2026-10-31 gate)", () => {
  fixture.enabled = true;
  fixture.host="https://api.lynse.cn";
  expect(memoryApiBase()).toBe("");
  localStorage.setItem("lynse_memory_api_url",DEFAULT_MEMORY_API_URL);
  expect(memoryApiBase()).toBe("");
  localStorage.setItem("lynse_memory_api_url","https://custom.invalid");
  expect(memoryApiBase()).toBe("");
});
it("keeps explicit custom endpoints and the disabled setting", () => {
  fixture.enabled = true;
  fixture.host="https://gapp.lynse.cn";
  localStorage.setItem("lynse_memory_api_url","https://custom.invalid");
  expect(memoryApiBase()).toBe("https://custom.invalid");
  localStorage.setItem("lynse_memory_api_url","");
  expect(memoryApiBase()).toBe("");
});
it("lets native code invalidate an old account before offline identity verification", async () => {
  fixture.enabled = true;
  fixture.host="https://gapp.lynse.cn";
  const fetch = vi.fn().mockRejectedValue(new Error("offline"));vi.stubGlobal("fetch",fetch);
  fixture.bind.mockRejectedValue(new Error("identity_unavailable"));
  await expect(bindInspirationCloud()).rejects.toThrow("identity_unavailable");
  expect(fixture.bind).toHaveBeenCalledWith("",expect.stringContaining("https://"),"new-account-token","https://gapp.lynse.cn");
  expect(fetch).not.toHaveBeenCalled();
});
