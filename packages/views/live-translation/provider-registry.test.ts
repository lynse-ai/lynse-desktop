import { describe, expect, it } from "vitest";
import {
  collectLegacyLiveTranslationSnapshot,
  defaultPersistedSettings,
  LEGACY_AUDIO_SOURCE_KEY,
  LEGACY_PROVIDER_KEY,
  LEGACY_TENCENT_APP_ID_KEY,
  migrateLegacyProviderSettings,
  parsePersistedSettings,
} from "./provider-migration";
import { DEFAULT_QWEN_ENDPOINT, DEFAULT_TENCENT_ASR_ENDPOINT } from "./types";
import {
  effectiveValues,
  getProvider,
  isProviderConfigured,
  listProviders,
  listSecretVaultKeys,
  resolveProvider,
  secretVaultKey,
} from "./providers";

describe("provider registry", () => {
  it("registers every built-in plugin once", () => {
    const ids = listProviders().map((plugin) => plugin.id);
    expect(ids).toEqual([
      "lynse_backend",
      "ilivedata_direct",
      "qwen",
      "volc",
      "tencent",
      "custom",
    ]);
  });

  it("derives the legacy vault key names from the plugins", () => {
    const ilivedata = getProvider("ilivedata_direct")!;
    const secretKey = ilivedata.fields.find((field) => field.key === "secretKey")!;
    expect(secretVaultKey(ilivedata, secretKey)).toBe(
      "lynse_live_translation_ilivedata_secret_key",
    );
    const qwen = getProvider("qwen")!;
    const apiKey = qwen.fields.find((field) => field.key === "apiKey")!;
    expect(secretVaultKey(qwen, apiKey)).toBe("lynse_live_translation_qwen_api_key");
    const custom = getProvider("custom")!;
    const customKey = custom.fields.find((field) => field.key === "apiKey")!;
    expect(secretVaultKey(custom, customKey)).toBe("lynse_live_translation_custom_api_key");
  });

  it("enumerates every secret field across plugins", () => {
    expect(listSecretVaultKeys().sort()).toEqual([
      "lynse_live_translation_custom_api_key",
      "lynse_live_translation_ilivedata_secret_key",
      "lynse_live_translation_qwen_api_key",
      "lynse_live_translation_tencent_secret_id",
      "lynse_live_translation_tencent_secret_key",
      "lynse_live_translation_volc_api_key",
    ]);
  });

  it("checks readiness from required fields with defaults applied", () => {
    const qwen = getProvider("qwen")!;
    expect(isProviderConfigured(qwen, { apiKey: "sk-test" })).toBe(true);
    expect(isProviderConfigured(qwen, { apiKey: "" })).toBe(false);
    expect(isProviderConfigured(qwen, undefined)).toBe(false);

    // Tencent needs all three credentials.
    const tencent = getProvider("tencent")!;
    expect(isProviderConfigured(tencent, { appId: "1", secretId: "a", secretKey: "b" })).toBe(true);
    expect(isProviderConfigured(tencent, { appId: "1", secretId: "a" })).toBe(false);

    // The backend relay needs nothing.
    expect(isProviderConfigured(getProvider("lynse_backend")!)).toBe(true);

    // The custom provider's endpoint/model defaults always apply, so only
    // the key is decisive.
    const custom = getProvider("custom")!;
    expect(isProviderConfigured(custom, { apiKey: "sk" })).toBe(true);
    expect(isProviderConfigured(custom, {})).toBe(false);
  });

  it("applies field defaults without mutating stored values", () => {
    const custom = getProvider("custom")!;
    const values = effectiveValues(custom, { apiKey: "sk-custom" });
    expect(values.model).toBe("qwen3.8-livetranslate-flash-realtime");
    expect(values.endpoint).toBe("wss://dashscope.aliyuncs.com/api-ws/v1/realtime");
    expect(values.apiKey).toBe("sk-custom");
    // asrModel has no default — it stays empty so Rust keeps its own.
    expect(values.asrModel).toBe("");
  });

  it("falls back to the backend relay for unknown ids", () => {
    expect(resolveProvider("nope").id).toBe("lynse_backend");
    expect(resolveProvider(undefined).id).toBe("lynse_backend");
    expect(resolveProvider("tencent").id).toBe("tencent");
  });
});

describe("legacy settings migration", () => {
  it("assembles the v2 blob from the legacy per-field layout", () => {
    const snapshot = collectLegacyLiveTranslationSnapshot((key) => {
      const store: Record<string, string> = {
        [LEGACY_PROVIDER_KEY]: "tencent",
        "lynse_live_translation_tencent_endpoint": "wss://asr.cloud.tencent.com/asr/v2",
        [LEGACY_TENCENT_APP_ID_KEY]: "125000000",
        [LEGACY_AUDIO_SOURCE_KEY]: "system",
        "lynse_live_translation_source_language": " zh ",
        "lynse_live_translation_ilivedata_pid": "81700002",
      };
      return store[key] ?? null;
    });
    const migrated = migrateLegacyProviderSettings(snapshot);
    expect(migrated).toEqual({
      version: 2,
      activeProvider: "tencent",
      audioSource: "system",
      sourceLanguage: "zh",
      targetLanguage: undefined,
      fields: {
        ilivedata_direct: { pid: "81700002", maxSpeakers: "2" },
        qwen: {},
        volc: {},
        tencent: {
          endpoint: DEFAULT_TENCENT_ASR_ENDPOINT,
          appId: "125000000",
          engineType: "",
        },
      },
    });
  });

  it("drops retired endpoints so plugin defaults take over", () => {
    const migrated = migrateLegacyProviderSettings({
      provider: "qwen",
      ilivedataEndpoint: null,
      ilivedataPid: null,
      ilivedataMaxSpeakers: null,
      // The retired qwen3.5 model URL must not survive the migration.
      qwenEndpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime",
      volcEndpoint: null,
      tencentEndpoint: null,
      tencentAppId: null,
      tencentEngine: null,
      audioSource: "weird",
      sourceLanguage: null,
      targetLanguage: null,
    });
    expect(migrated.fields.qwen).toEqual({});
    expect(migrated.audioSource).toBe("both");
    expect(migrated.activeProvider).toBe("qwen");
    // The effective qwen endpoint resolves to the current default.
    expect(effectiveValues(getProvider("qwen")!, migrated.fields.qwen).endpoint).toBe(
      DEFAULT_QWEN_ENDPOINT,
    );
  });

  it("maps unknown legacy providers to the backend relay", () => {
    const migrated = migrateLegacyProviderSettings({
      provider: "mystery",
      ilivedataEndpoint: null,
      ilivedataPid: null,
      ilivedataMaxSpeakers: "9",
      qwenEndpoint: null,
      volcEndpoint: null,
      tencentEndpoint: null,
      tencentAppId: null,
      tencentEngine: null,
      audioSource: null,
      sourceLanguage: null,
      targetLanguage: null,
    });
    expect(migrated.activeProvider).toBe("lynse_backend");
    // Speaker counts above the documented range clamp to 5, matching the
    // legacy reader's normalize step.
    expect(migrated.fields.ilivedata_direct?.maxSpeakers).toBe("5");
  });

  it("rejects corrupt or future-shaped blobs", () => {
    expect(parsePersistedSettings(null)).toBeNull();
    expect(parsePersistedSettings("not json")).toBeNull();
    expect(parsePersistedSettings(JSON.stringify({ version: 1 }))).toBeNull();
    expect(
      parsePersistedSettings(
        JSON.stringify({ version: 2, activeProvider: "qwen", fields: {} }),
      )?.activeProvider,
    ).toBe("qwen");
  });

  it("seeds fresh installs with the backend relay", () => {
    expect(defaultPersistedSettings().activeProvider).toBe("lynse_backend");
  });
});
