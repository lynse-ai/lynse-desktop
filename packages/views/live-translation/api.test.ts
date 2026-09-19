import { describe, expect, it } from "vitest";
import {
  buildILiveDataWebSocketUrl,
  createILiveDataToken,
  requestRealtimeSession,
  tencentEngineType,
} from "./api";
import type { LiveAudioSourceMode, LiveTranslationProviderConfig } from "./types";
import {
  DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
  DEFAULT_QWEN_ENDPOINT,
  DEFAULT_TENCENT_ASR_ENDPOINT,
  DEFAULT_VOLC_AST_ENDPOINT,
} from "./types";

function tencentConfig(
  overrides: Partial<LiveTranslationProviderConfig["tencent"]> = {},
  audioSource?: LiveAudioSourceMode,
) {
  return {
    provider: "tencent",
    audioSource,
    ilivedata: { endpoint: DEFAULT_ILIVEDATA_RTVT_ENDPOINT, pid: "", secretKey: "" },
    qwen: { endpoint: DEFAULT_QWEN_ENDPOINT, apiKey: "" },
    volc: { endpoint: DEFAULT_VOLC_AST_ENDPOINT, apiKey: "" },
    tencent: {
      endpoint: DEFAULT_TENCENT_ASR_ENDPOINT,
      appId: "125000000",
      secretId: "AKIDexample",
      secretKey: "secret-key",
      engineType: "",
      ...overrides,
    },
  } as LiveTranslationProviderConfig;
}

describe("Tencent real-time ASR session", () => {
  it("derives the engine type from the source language unless set explicitly", () => {
    expect(tencentEngineType("zh")).toBe("16k_zh");
    expect(tencentEngineType("zh-yue")).toBe("16k_zh-PY");
    expect(tencentEngineType("en")).toBe("16k_en");
    expect(tencentEngineType("ja")).toBe("16k_ja");
    // Languages without a dedicated engine fall back to Mandarin.
    expect(tencentEngineType("ko")).toBe("16k_zh");
    expect(tencentEngineType("auto")).toBe("16k_zh");
    // An explicit engine setting always wins.
    expect(tencentEngineType("zh", "16k_zh_medical")).toBe("16k_zh_medical");
  });

  it("builds one signed-base connection per capture source", async () => {
    const session = await requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      tencentConfig(),
    );
    expect(session.connections).toHaveLength(2);
    for (const connection of session.connections) {
      expect(connection.provider).toBe("tencent");
      // The app id rides on the path; signing happens on the Rust side.
      expect(connection.url).toBe("wss://asr.cloud.tencent.com/asr/v2/125000000");
      expect(connection.extra).toEqual({
        secretId: "AKIDexample",
        secretKey: "secret-key",
        engineType: "16k_zh",
      });
    }
    expect(session.connections.map((connection) => connection.source).sort())
      .toEqual(["mic", "system"]);
  });

  it("honours the system-only capture mode and explicit engines", async () => {
    const session = await requestRealtimeSession(
      { sourceLanguage: "ja", targetLanguage: "none", epoch: 0 },
      tencentConfig({ engineType: "16k_ja" }, "system"),
    );
    expect(session.connections).toHaveLength(1);
    expect(session.connections[0]?.source).toBe("system");
    expect(session.connections[0]?.extra?.engineType).toBe("16k_ja");
  });

  it("rejects incomplete credentials and insecure endpoints", async () => {
    await expect(requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      tencentConfig({ secretKey: "" }),
    )).rejects.toThrow("SecretId");
    await expect(requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      tencentConfig({ appId: "" }),
    )).rejects.toThrow("AppID");
    await expect(requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      tencentConfig({ endpoint: "ws://asr.cloud.tencent.com/asr/v2" }),
    )).rejects.toThrow("wss://");
  });
});

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
    expect(url.searchParams.get("asrModel")).toBe("ViiTor");
    expect(url.searchParams.get("digitalize")).toBe("true");
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
