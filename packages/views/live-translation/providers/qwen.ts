import { DEFAULT_QWEN_ENDPOINT } from "../types";
import type { LiveTranslationProviderPlugin } from "./types";

/** Validate a DashScope realtime endpoint and resolve it against the default. */
export function resolveDashScopeEndpoint(endpoint: string | undefined, label: string): string {
  const trimmed = endpoint?.trim() ?? "";
  if (!trimmed.startsWith("wss://")) {
    throw new Error(`${label} WebSocket 地址必须使用 wss://`);
  }
  return trimmed;
}

/**
 * Qwen Live Translate (阿里云百炼 DashScope) — OpenAI-Realtime-style JSON
 * event protocol. The API key attaches to the websocket handshake on the
 * Rust side; the model rides on the endpoint's `?model=` query parameter.
 */
export const qwenPlugin: LiveTranslationProviderPlugin = {
  id: "qwen",
  nameKey: "live_translation.provider_qwen",
  name: "Qwen 实时翻译（通义）",
  hintKey: "live_translation.qwen_hint",
  protocol: "dashscope",
  capabilities: { translation: true },
  fields: [
    {
      key: "apiKey",
      kind: "password",
      labelKey: "live_translation.provider_qwen_api_key",
      secret: true,
      required: true,
      placeholder: "sk-...",
    },
    {
      key: "endpoint",
      kind: "text",
      labelKey: "live_translation.provider_qwen_endpoint",
      defaultValue: DEFAULT_QWEN_ENDPOINT,
    },
  ],
  async buildConnections(ctx) {
    const endpoint = resolveDashScopeEndpoint(ctx.values.endpoint, "Qwen");
    const apiKey = ctx.values.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Qwen 翻译引擎需要填写 DashScope API Key");
    }
    return ctx.sources.map((source) => ({
      source,
      url: endpoint,
      // The legacy tag: keeps persisted-record engine labels ("qwen_…")
      // continuous across the refactor. Rust routes it to the DashScope
      // adapter together with the generic "dashscope" tag.
      provider: "qwen",
      apiKey,
    }));
  },
};
