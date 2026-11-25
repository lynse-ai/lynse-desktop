import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const access = { apiBaseUrl: "https://api.lynse.cn", authSn: "CARD-123", bleMac: "12:34:56:78:9A:BC" };
const binding = { macAddress: "123456789abc", authSn: null, bindStatus: 1 };

function verify(overrides: Partial<typeof access> = {}, token = "current-session") {
  return POST(new Request("https://www.lynse.cn/app/api/recording-card/ownership", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ ...access, ...overrides }),
  }));
}

function mockBindings(data: unknown, code = 200) {
  const fetch = vi.fn(async () => Response.json({ code, data }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("recording card ownership route", () => {
  it("uses the current session to validate an active binding through the compiled verifier", async () => {
    const upstream = mockBindings([binding]);
    const response = await verify();
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(upstream).toHaveBeenCalledWith("https://api.lynse.cn/api/business/device/mine", expect.objectContaining({
      headers: { Authorization: "current-session", "Cache-Control": "no-cache, no-store" },
      redirect: "error",
    }));
  });

  it.each([
    [],
    [{ ...binding, macAddress: "12:34:56:78:9A:BD", authSn: "CARD-123" }],
    [{ ...binding, authSn: "DIFFERENT-CARD" }],
    [{ ...binding, bindStatus: 0 }],
    [{ ...binding, bindStatus: 4294967297 }],
  ].map((rows) => [rows]))("denies missing, conflicting, and inactive bindings", async (rows) => {
    mockBindings(rows);
    expect((await verify()).status).toBe(403);
  });

  it("refuses unknown origins, missing card identity, and missing logins", async () => {
    const upstream = mockBindings([binding]);
    expect((await verify({ apiBaseUrl: "https://api.lynse.cn.example.com" })).status).toBe(400);
    expect((await verify({ bleMac: "" })).status).toBe(400);
    expect((await verify({}, "")).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects expired sessions, malformed responses, and failed requests", async () => {
    mockBindings([binding], 2000);
    expect((await verify()).status).toBe(401);
    mockBindings({ records: [binding] });
    expect((await verify()).status).toBe(503);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Network unavailable"); }));
    expect((await verify()).status).toBe(503);
  });
});
