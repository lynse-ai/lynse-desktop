/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { bindInspirationCloud } from "./cloud";
const fixture = vi.hoisted(() => ({ bind: vi.fn(), token: "new-account-token" }));
vi.mock("./desktop-api", () => ({ getDesktopInspirationApi: () => ({cloudBind:fixture.bind}) }));
vi.mock("@lynse/core/api", () => ({api:()=>({getToken:()=>fixture.token,getBaseUrl:()=>"https://login.test"})}));
afterEach(() => {vi.unstubAllGlobals();fixture.bind.mockReset();});
it("lets native code invalidate an old account before offline identity verification", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("offline"));vi.stubGlobal("fetch",fetch);
  fixture.bind.mockRejectedValue(new Error("identity_unavailable"));
  await expect(bindInspirationCloud()).rejects.toThrow("identity_unavailable");
  expect(fixture.bind).toHaveBeenCalledWith("",expect.stringContaining("https://"),"new-account-token","https://login.test");
  expect(fetch).not.toHaveBeenCalled();
});
