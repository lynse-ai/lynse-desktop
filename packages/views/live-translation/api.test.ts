import { describe, expect, it } from "vitest";
import { buildILiveDataWebSocketUrl, createILiveDataToken } from "./api";

describe("iLiveData direct authentication", () => {
  it("generates the documented HMAC-SHA256 token", async () => {
    await expect(
      createILiveDataToken("81700002", 1_700_000_000, btoa("test-secret")),
    ).resolves.toBe("G2AjoLuRWSDYmCbIlFWB5ggMrHwAOGh0acsU0ZUBVx8=");
  });

  it("builds a signed realtime translation URL", () => {
    const result = buildILiveDataWebSocketUrl({
      endpoint: "wss://rtvt-cn-app.ilivedata.com/gate/websocket",
      pid: "81700002",
      token: "signed/token=",
      timestamp: 1_700_000_000,
      sourceLanguage: "zh",
      targetLanguage: "en",
      userId: "lynse-test-mic-0",
    });
    const url = new URL(result);

    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("rtvt-cn-app.ilivedata.com");
    expect(url.searchParams.get("pid")).toBe("81700002");
    expect(url.searchParams.get("token")).toBe("signed/token=");
    expect(url.searchParams.get("srcLanguage")).toBe("zh");
    expect(url.searchParams.get("destLanguage")).toBe("en");
    expect(url.searchParams.get("asrTempResult")).toBe("true");
    expect(url.searchParams.get("codec")).toBe("0");
  });

  it("rejects malformed credentials and insecure endpoints", async () => {
    await expect(createILiveDataToken("not-a-pid", 1, btoa("key"))).rejects.toThrow("PID");
    expect(() => buildILiveDataWebSocketUrl({
      endpoint: "ws://example.com/socket",
      pid: "1",
      token: "token",
      timestamp: 1,
      sourceLanguage: "zh",
      targetLanguage: "en",
      userId: "test",
    })).toThrow("wss://");
  });
});
