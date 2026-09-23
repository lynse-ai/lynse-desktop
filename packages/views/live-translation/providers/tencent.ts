import { DEFAULT_TENCENT_ASR_ENDPOINT } from "../types";
import type { LiveTranslationProviderPlugin } from "./types";

/**
 * Resolve the Tencent engine type for a Lynse source language. An explicit
 * setting wins; otherwise a fixed engine is derived from the language (the
 * service has no auto-detect). Languages without a dedicated engine fall
 * back to Mandarin — callers should override the engine for them.
 */
export function tencentEngineType(sourceLanguage: string, configured?: string): string {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  switch (sourceLanguage) {
    case "zh-yue":
      return "16k_zh-PY";
    case "en":
      return "16k_en";
    case "ja":
      return "16k_ja";
    default:
      return "16k_zh";
  }
}

/**
 * Tencent Cloud real-time ASR — recognition only, no translation leg (a
 * translation target is ignored; the config card says so). It authenticates
 * through the URL itself (the query string is HMAC-signed), and every
 * websocket (re)connect needs a fresh signature: the frontend hands over
 * only the base endpoint plus the credentials, and the Rust connection loop
 * builds and signs the per-connect URL.
 */
export const tencentPlugin: LiveTranslationProviderPlugin = {
  id: "tencent",
  nameKey: "live_translation.provider_tencent",
  name: "腾讯云实时识别",
  hintKey: "live_translation.tencent_hint",
  protocol: "tencent",
  capabilities: { translation: false, speakerDiarization: true },
  fields: [
    { key: "appId", kind: "text", labelKey: "live_translation.provider_tencent_app_id", required: true },
    { key: "secretId", kind: "text", labelKey: "live_translation.provider_tencent_secret_id", secret: true, required: true },
    { key: "secretKey", kind: "password", labelKey: "live_translation.provider_tencent_secret_key", secret: true, required: true },
    {
      key: "engineType",
      kind: "text",
      labelKey: "live_translation.provider_tencent_engine",
      placeholder: "16k_zh",
    },
    {
      key: "endpoint",
      kind: "text",
      labelKey: "live_translation.provider_websocket_endpoint",
      defaultValue: DEFAULT_TENCENT_ASR_ENDPOINT,
    },
  ],
  async buildConnections(ctx) {
    const endpoint = ctx.values.endpoint?.trim() || DEFAULT_TENCENT_ASR_ENDPOINT;
    if (!endpoint.startsWith("wss://")) {
      throw new Error("腾讯 WebSocket 地址必须使用 wss://");
    }
    const appId = ctx.values.appId?.trim();
    if (!appId) {
      throw new Error("腾讯实时识别需要填写 AppID");
    }
    const secretId = ctx.values.secretId?.trim();
    const secretKey = ctx.values.secretKey?.trim();
    if (!secretId || !secretKey) {
      throw new Error("腾讯实时识别需要填写 SecretId 与 SecretKey");
    }
    const engineType = tencentEngineType(ctx.sourceLanguage, ctx.values.engineType);
    const base = `${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(appId)}`;
    return ctx.sources.map((source) => ({
      source,
      url: base,
      provider: "tencent",
      extra: { secretId, secretKey, engineType },
    }));
  },
};
