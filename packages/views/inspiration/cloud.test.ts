/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { bindInspirationCloud, memoryApiBase, DEFAULT_MEMORY_API_URL } from "./cloud";
const fixture = vi.hoisted(() => ({ bind: vi.fn(), token: "new-account-token", host: "https://login.test" }));
vi.mock("./desktop-api", () => ({ getDesktopInspirationApi: () => ({cloudBind:fixture.bind}) }));
vi.mock("@lynse/core/api", () => ({api:()=>({getToken:()=>fixture.token,getBaseUrl:()=>fixture.host})}));
afterEach(() => {vi.unstubAllGlobals();fixture.bind.mockReset();fixture.host="https://login.test";localStorage.clear();});
it("moves the default and previously saved production preset to staging with the login gateway", () => {
  fixture.host="https://gapp.lynse.cn";
  const staging="https://lynse-memory-336033-11-1401959758.sh.run.tcloudbase.com";
  expect(memoryApiBase()).toBe(staging);
  localStorage.setItem("lynse_memory_api_url",DEFAULT_MEMORY_API_URL);
  expect(memoryApiBase()).toBe(staging);
  localStorage.setItem("lynse_memory_api_url",staging);
  fixture.host="https://api.lynse.cn";
  expect(memoryApiBase()).toBe(DEFAULT_MEMORY_API_URL);
});
it("keeps explicit custom endpoints and the disabled setting", () => {
  fixture.host="https://gapp.lynse.cn";
  localStorage.setItem("lynse_memory_api_url","https://custom.invalid");
  expect(memoryApiBase()).toBe("https://custom.invalid");
  localStorage.setItem("lynse_memory_api_url","");
  expect(memoryApiBase()).toBe("");
});
it("lets native code invalidate an old account before offline identity verification", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("offline"));vi.stubGlobal("fetch",fetch);
  fixture.bind.mockRejectedValue(new Error("identity_unavailable"));
  await expect(bindInspirationCloud()).rejects.toThrow("identity_unavailable");
  expect(fixture.bind).toHaveBeenCalledWith("",expect.stringContaining("https://"),"new-account-token","https://login.test");
  expect(fetch).not.toHaveBeenCalled();
});
