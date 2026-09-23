import { describe, expect, it } from "vitest";
import {
  buildCustomRealtimeEndpoint,
  buildILiveDataWebSocketUrl,
  createILiveDataToken,
  realtimeEngineLabel,
  requestRealtimeSession,
  tencentEngineType,
} from "./api";
import type {
  LiveAudioSourceMode,
  LiveTranslationProviderConfig,
} from "./types";
import {
  DEFAULT_QWEN_ENDPOINT,
} from "./types";
import { DEFAULT_TENCENT_ASR_ENDPOINT } from "./types";

/** Build a runtime config where every provider's field map holds `values`. */
function configWith(
  activeProvider: string,
  values: Record<string, Record<string, string>>,
  audioSource?: LiveAudioSourceMode,
): LiveTranslationProviderConfig {
  return { activeProvider, audioSource, values };
}

function tencentValues(
  overrides: Record<string, string> = {},
  audioSource?: LiveAudioSourceMode,
) {
  return configWith(
    "tencent",
    {
      tencent: {
        appId: "125000000",
        secretId: "AKIDexample",
        secretKey: "secret-key",
        engineType: "",
        endpoint: "",
        ...overrides,
      },
    },
    audioSource,
  );
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
      tencentValues(),
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
      tencentValues({ engineType: "16k_ja" }, "system"),
    );
    expect(session.connections).toHaveLength(1);
    expect(session.connections[0]?.source).toBe("system");
    expect(session.connections[0]?.extra?.engineType).toBe("16k_ja");
  });

  it("rejects incomplete credentials and insecure endpoints", async () => {
    await expect(requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      tencentValues({ secretKey: "" }),
    )).rejects.toThrow("SecretId");
    await expect(requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      tencentValues({ appId: "" }),
    )).rejects.toThrow("AppID");
    await expect(requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      tencentValues({ endpoint: "ws://asr.cloud.tencent.com/asr/v2" }),
    )).rejects.toThrow("wss://");
  });
});

describe("Qwen realtime session", () => {
  it("stamps the legacy qwen tag and the api key onto each connection", async () => {
    const session = await requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      configWith("qwen", { qwen: { apiKey: "sk-test", endpoint: "" } }, "mic"),
    );
    expect(session.connections).toHaveLength(1);
    expect(session.connections[0]?.provider).toBe("qwen");
    // The default endpoint applies when the stored value is empty.
    expect(session.connections[0]?.url).toBe(DEFAULT_QWEN_ENDPOINT);
    expect(session.connections[0]?.apiKey).toBe("sk-test");
  });

  it("rejects a missing api key", async () => {
    await expect(requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      configWith("qwen", { qwen: { apiKey: "", endpoint: "" } }),
    )).rejects.toThrow("DashScope API Key");
  });
});

describe("custom DashScope-compatible realtime session", () => {
  it("merges the model into the endpoint query", () => {
    expect(buildCustomRealtimeEndpoint(
      "wss://example.com/api/realtime?foo=bar",
      " my-model ",
    )).toBe("wss://example.com/api/realtime?foo=bar&model=my-model");
  });

  it("builds connections with the model query and optional asrModel extra", async () => {
    const session = await requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      configWith("custom", {
        custom: {
          endpoint: "wss://relay.example.com/realtime",
          model: "translate-v1",
          apiKey: "sk-custom",
          asrModel: "asr-v2",
        },
      }, "system"),
    );
    expect(session.connections).toHaveLength(1);
    const connection = session.connections[0];
    expect(new URL(connection!.url!).searchParams.get("model")).toBe("translate-v1");
    expect(connection?.provider).toBe("dashscope");
    expect(connection?.extra).toEqual({ asrModel: "asr-v2" });
  });

  it("falls back to defaults when endpoint/model are empty", async () => {
    const session = await requestRealtimeSession(
      { sourceLanguage: "zh", targetLanguage: "en", epoch: 0 },
      configWith("custom", { custom: { apiKey: "sk-custom" } }),
    );
    const url = new URL(session.connections[0]!.url!);
    expect(url.searchParams.get("model")).toBe("qwen3.8-livetranslate-flash-realtime");
  });
});

describe("provider resolution", () => {
  it("falls back to the backend relay for unknown or absent provider ids", async () => {
    // No network here — the backend plugin posts through the shared client,
    // which fails in tests; assert via connection-less behaviour instead.
    const { resolveProvider } = await import("./providers");
    expect(resolveProvider(undefined).id).toBe("lynse_backend");
    expect(resolveProvider("nope").id).toBe("lynse_backend");
    expect(resolveProvider("qwen").id).toBe("qwen");
    expect(resolveProvider("custom").id).toBe("custom");
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

describe("realtimeEngineLabel", () => {
  it("prefers the model query parameter over the host", () => {
    expect(realtimeEngineLabel(DEFAULT_QWEN_ENDPOINT)).toBe(
      "qwen3.8-livetranslate-flash-realtime",
    );
  });

  it("falls back to the host and survives signed query strings", () => {
    expect(
      realtimeEngineLabel(
        `wss://asr.cloud.tencent.com/asr/v2/125000000?signature=abc&engine=16k_zh`,
      ),
    ).toBe("asr.cloud.tencent.com");
    expect(realtimeEngineLabel("not a url")).toBe("not a url");
  });
});

describe("tencent default endpoint constant", () => {
  it("stays the documented ASR gate", () => {
    expect(DEFAULT_TENCENT_ASR_ENDPOINT).toBe("wss://asr.cloud.tencent.com/asr/v2");
  });
});
