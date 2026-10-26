import { api } from "@lynse/core/api/client";

import { DEFAULT_LYNSE_QWEN_RELAY_ENDPOINT } from "../types";
import type { LiveTranslationProviderPlugin } from "./types";
import { resolveDashScopeEndpoint } from "./qwen";

/**
 * Lynse-hosted Qwen Live Translate: the same DashScope realtime wire
 * protocol as the `qwen` plugin, but the websocket terminates on the
 * Lynse relay (services/realtime-relay) instead of DashScope directly.
 * The relay authenticates the handshake with the logged-in user's Lynse
 * accessToken and injects the server-held DashScope key upstream, so this
 * provider has no API-key field at all — being signed in is the only
 * requirement, and the key never touches the device.
 */
export const lynseQwenPlugin: LiveTranslationProviderPlugin = {
  id: "lynse_qwen",
  nameKey: "live_translation.provider_lynse_qwen",
  name: "Lynse 内置 · 通义实时翻译",
  hintKey: "live_translation.lynse_qwen_hint",
  protocol: "dashscope",
  capabilities: { translation: true },
  fields: [
    {
      key: "endpoint",
      kind: "text",
      labelKey: "live_translation.provider_lynse_qwen_endpoint",
      defaultValue: DEFAULT_LYNSE_QWEN_RELAY_ENDPOINT,
    },
  ],
  async buildConnections(ctx) {
    const endpoint = resolveDashScopeEndpoint(ctx.values.endpoint, "Lynse 通义");
    // The handshake credential is the Lynse session token, resolved at
    // mint time — never persisted with the settings, never stored in the
    // secret vault (it changes on every login).
    const apiKey = api().getToken()?.trim() ?? "";
    if (!apiKey) {
      throw new Error("Lynse 内置通义翻译需要先登录 Lynse 账号");
    }
    return ctx.sources.map((source) => ({
      source,
      url: endpoint,
      // Same engine tag as the BYO plugin: persisted records keep reading
      // as Qwen realtime output, and Rust routes it to the DashScope
      // adapter unchanged.
      provider: "qwen",
      apiKey,
    }));
  },
};
