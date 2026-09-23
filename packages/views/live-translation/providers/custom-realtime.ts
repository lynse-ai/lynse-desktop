import type { LiveTranslationProviderPlugin } from "./types";
import { resolveDashScopeEndpoint } from "./qwen";

const DEFAULT_CUSTOM_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const DEFAULT_CUSTOM_MODEL = "qwen3.8-livetranslate-flash-realtime";
/** Default ASR model requested in the Rust session.update; overridable via
 * the optional `asrModel` field for services that name theirs differently. */
const DEFAULT_CUSTOM_ASR_MODEL = "qwen3-asr-flash-realtime";

/** Merge the chosen model into the endpoint's `?model=` query parameter,
 * preserving any other query parameters the user's endpoint carries. */
export function buildCustomRealtimeEndpoint(endpoint: string, model: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("model", model.trim());
  return url.toString();
}

/**
 * User-configured provider speaking the DashScope realtime JSON protocol
 * (`session.update` / `input_audio_buffer.append` / recognition + translation
 * events). Anything compatible with that wire shape works with just an
 * endpoint, a model name and a key — no code change required.
 */
export const customRealtimePlugin: LiveTranslationProviderPlugin = {
  id: "custom",
  nameKey: "live_translation.provider_custom",
  name: "自定义（DashScope 兼容）",
  hintKey: "live_translation.custom_hint",
  protocol: "dashscope",
  capabilities: { translation: true },
  fields: [
    {
      key: "endpoint",
      kind: "text",
      labelKey: "live_translation.provider_websocket_endpoint",
      required: true,
      defaultValue: DEFAULT_CUSTOM_ENDPOINT,
    },
    {
      key: "model",
      kind: "text",
      labelKey: "live_translation.provider_custom_model",
      required: true,
      defaultValue: DEFAULT_CUSTOM_MODEL,
    },
    {
      key: "apiKey",
      kind: "password",
      labelKey: "live_translation.provider_custom_api_key",
      secret: true,
      required: true,
      placeholder: "sk-...",
    },
    {
      key: "asrModel",
      kind: "text",
      labelKey: "live_translation.provider_custom_asr_model",
      placeholder: DEFAULT_CUSTOM_ASR_MODEL,
      hintKey: "live_translation.provider_custom_asr_model_hint",
    },
  ],
  async buildConnections(ctx) {
    const base = resolveDashScopeEndpoint(ctx.values.endpoint, "自定义");
    const model = ctx.values.model?.trim();
    if (!model) {
      throw new Error("自定义翻译引擎需要填写模型名称");
    }
    const apiKey = ctx.values.apiKey?.trim();
    if (!apiKey) {
      throw new Error("自定义翻译引擎需要填写 API Key");
    }
    const url = buildCustomRealtimeEndpoint(base, model);
    const asrModel = ctx.values.asrModel?.trim();
    return ctx.sources.map((source) => ({
      source,
      url,
      provider: "dashscope",
      apiKey,
      extra: asrModel ? { asrModel } : undefined,
    }));
  },
};
