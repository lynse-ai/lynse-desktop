/**
 * Per-turn chat model override (桌面端自定义模型切换).
 *
 * The lynclaw agent service accepts an optional `modelOverride` on every chat
 * turn (see the PRD "桌面端自定义模型切换"); this module owns the client side:
 * the locally persisted setting, its conversion to the wire shape, and the
 * built-in preset list fetch. The setting never reaches the server as stored
 * state — each turn reads it fresh and attaches the override only when the
 * user picked something, so an unconfigured app sends byte-identical requests
 * to before.
 */

import { api } from "@lynse/core/api";

/** A built-in preset as served by `GET /api/model/presets`. */
export interface ModelPreset {
  id: string;
  label: string;
  /** Already interpolated server-side; shown/used as-is. */
  baseUrl: string;
  models: string[];
  defaultModel: string;
  /** True when the server has no credential for this preset and the user
   *  must supply their own API key. */
  requiresApiKey: boolean;
  note?: string;
}

/** The `modelOverride` object sent with a chat turn. */
export interface RequestModelOverride {
  preset?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

/**
 * The user's model choice. "default" sends no override at all (the server's
 * own configuration answers); "preset" picks from the served preset list
 * (optionally with a user key when `requiresApiKey`); "custom" points at an
 * arbitrary OpenAI-compatible endpoint.
 */
export type ChatModelSetting =
  | { mode: "default" }
  | { mode: "preset"; presetId: string; model: string; apiKey?: string }
  | { mode: "custom"; baseUrl: string; apiKey: string; model: string };

export const MODEL_OVERRIDE_STORAGE_KEY = "lynse_chat_model_override";

/** Absent/corrupt storage means "follow the server default" — never throw. */
export function loadChatModelSetting(): ChatModelSetting {
  if (typeof localStorage === "undefined") return { mode: "default" };
  try {
    const raw = localStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY);
    if (!raw) return { mode: "default" };
    return parseChatModelSetting(JSON.parse(raw));
  } catch {
    return { mode: "default" };
  }
}

/** Coerce untrusted JSON into a setting; anything malformed falls back to
 *  "default" so a bad write can never poison outgoing requests. */
export function parseChatModelSetting(value: unknown): ChatModelSetting {
  if (!value || typeof value !== "object") return { mode: "default" };
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  if (v.mode === "preset") {
    const presetId = str(v.presetId);
    const model = str(v.model);
    if (!presetId || !model) return { mode: "default" };
    const apiKey = str(v.apiKey);
    return apiKey ? { mode: "preset", presetId, model, apiKey } : { mode: "preset", presetId, model };
  }
  if (v.mode === "custom") {
    const baseUrl = str(v.baseUrl);
    const apiKey = str(v.apiKey);
    const model = str(v.model);
    if (!isHttpUrl(baseUrl) || !apiKey || !model) return { mode: "default" };
    return { mode: "custom", baseUrl, apiKey, model };
  }
  return { mode: "default" };
}

export function saveChatModelSetting(setting: ChatModelSetting): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (setting.mode === "default") localStorage.removeItem(MODEL_OVERRIDE_STORAGE_KEY);
    else localStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify(setting));
    if (typeof window !== "undefined") window.dispatchEvent(new Event("lynse-chat-model-setting"));
  } catch {
    // Storage unavailable (quota/private mode): the setting just won't persist.
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Wire conversion. Returns null unless the setting is complete — an
 * incomplete preset pick (server removed the preset) or custom form degrades
 * to "no override" so the turn keeps working on the server default.
 */
export function toRequestOverride(setting: ChatModelSetting): RequestModelOverride | null {
  if (setting.mode === "preset") {
    return { preset: setting.presetId, model: setting.model, ...(setting.apiKey ? { apiKey: setting.apiKey } : {}) };
  }
  if (setting.mode === "custom") {
    if (!isHttpUrl(setting.baseUrl) || !setting.apiKey || !setting.model) return null;
    return { baseUrl: setting.baseUrl, apiKey: setting.apiKey, model: setting.model };
  }
  return null;
}

/**
 * Routing mirrors the chat transport: direct agent connections (route B, the
 * CloudBase-hosted lynclaw) serve `/api/model/presets` natively; through the
 * main backend the Lynse gateway fronts the same service under
 * `/api/business/ai`. Kept local so this module stays a leaf — chat-transport
 * imports its types, not the other way around.
 */
const GATEWAY_MODEL_PRESETS_PATH = "/api/business/ai/model/presets";
const AGENT_MODEL_PRESETS_PATH = "/api/model/presets";

/**
 * Fetch the built-in preset list. Throws on network/auth failure — the
 * settings card renders the error and still allows the custom form; callers
 * must not hardcode a fallback list (the served list is the source of truth).
 */
export async function fetchModelPresets(): Promise<ModelPreset[]> {
  let agentBase: string | undefined;
  try {
    agentBase = api().getAgentBaseUrl() ?? undefined;
  } catch {
    agentBase = undefined; // client not initialized — main backend
  }
  const res = await api().get<{ presets?: unknown }>(
    agentBase ? AGENT_MODEL_PRESETS_PATH : GATEWAY_MODEL_PRESETS_PATH,
    { baseUrl: agentBase },
  );
  if (!Array.isArray(res?.presets)) return [];
  return res.presets.filter((p): p is ModelPreset => {
    if (!p || typeof p !== "object") return false;
    const preset = p as Record<string, unknown>;
    return typeof preset.id === "string" && !!preset.id &&
      typeof preset.label === "string" &&
      Array.isArray(preset.models) && preset.models.every((m) => typeof m === "string");
  });
}
