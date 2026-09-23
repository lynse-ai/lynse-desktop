import { DEFAULT_VOLC_AST_ENDPOINT } from "../types";
import type { LiveTranslationProviderPlugin } from "./types";
import { resolveDashScopeEndpoint } from "./qwen";

/**
 * Volcengine AST (火山引擎语音同传) — protobuf over binary websocket frames.
 * It authenticates on the upgrade headers (`X-Api-Key`), so there is no token
 * to mint here — the credentials are handed to the Rust side, which attaches
 * them to the handshake and speaks the protocol.
 */
export const volcPlugin: LiveTranslationProviderPlugin = {
  id: "volc",
  nameKey: "live_translation.provider_volc",
  name: "火山同声传译（豆包）",
  hintKey: "live_translation.volc_hint",
  protocol: "volc",
  capabilities: { translation: true, speakerDiarization: true },
  fields: [
    {
      key: "apiKey",
      kind: "password",
      labelKey: "live_translation.provider_volc_api_key",
      secret: true,
      required: true,
    },
    {
      key: "endpoint",
      kind: "text",
      labelKey: "live_translation.provider_volc_endpoint",
      defaultValue: DEFAULT_VOLC_AST_ENDPOINT,
    },
  ],
  async buildConnections(ctx) {
    const endpoint = resolveDashScopeEndpoint(ctx.values.endpoint, "火山");
    const apiKey = ctx.values.apiKey?.trim();
    if (!apiKey) {
      throw new Error("火山同声传译需要填写 Access Key");
    }
    return ctx.sources.map((source) => ({
      source,
      url: endpoint,
      provider: "volc",
      apiKey,
    }));
  },
};
