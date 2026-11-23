import { getDesktopLiveTranslationApi } from "./desktop-api";
import { resolveProvider } from "./providers";
import type { LiveTranslationProviderConfig } from "./types";

/** Translation service layer: a provider-priority chain used when the active
 *  ASR provider has no translation leg (Apple on-device, Tencent ASR). Chain
 *  order lives in a small localStorage blob; the Ling API key rides the apple
 *  provider plugin's keychain-backed `lingKey` field, and Qwen-MT reuses the
 *  realtime provider's DashScope `apiKey` + optional endpoint override. */

export interface TranslationServiceConfig {
  /** Provider order, tried head-first: "qwen_mt" | "apple" | "google" | "ling". */
  providers: string[];
}

const CONFIG_KEY = "lynse_translation_service";

/** Chain members the UI can offer, in default display order. */
export const TRANSLATION_ENGINES: { id: string; labelKey: string }[] = [
  { id: "qwen_mt", labelKey: "live_translation.engine_qwen_mt" },
  { id: "ling", labelKey: "live_translation.engine_ling" },
  { id: "google", labelKey: "live_translation.engine_google" },
  { id: "apple", labelKey: "live_translation.engine_apple" },
];

export function readTranslationServiceConfig(): TranslationServiceConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TranslationServiceConfig>;
      const providers = Array.isArray(parsed.providers)
        ? parsed.providers.map(String).filter((name) => ["qwen_mt", "apple", "google", "ling"].includes(name))
        : [];
      if (providers.length > 0) return { providers };
    }
  } catch {
    // Corrupt blob falls through to the default.
  }
  return { providers: ["apple", "google"] };
}

export function saveTranslationServiceConfig(config: TranslationServiceConfig): void {
  window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

/** The Ling key from the apple provider's keychain field; null when unset. */
export function readLingKey(providerConfig: LiveTranslationProviderConfig): string | null {
  const key = providerConfig.values.apple?.lingKey?.trim();
  return key ? key : null;
}

/** The DashScope key from the qwen realtime provider's keychain field — the
 *  same credential the realtime WS uses, now shared with the MT chain. */
export function readQwenKey(providerConfig: LiveTranslationProviderConfig): string | null {
  const key = providerConfig.values.qwen?.apiKey?.trim();
  return key ? key : null;
}

/** Derive the Qwen-MT HTTP endpoint from the realtime provider's WebSocket
 *  endpoint. The `endpoint` field holds a `wss://…/api-ws/v1/realtime` URL —
 *  passing it to the chat/completions call would 404, so keep only the host
 *  and rebuild the compatible-mode path. International-station keys (whose WS
 *  endpoint points at dashscope-intl) thereby follow automatically; null
 *  keeps the Rust-side mainland default. */
export function readQwenEndpoint(providerConfig: LiveTranslationProviderConfig): string | null {
  const endpoint = providerConfig.values.qwen?.endpoint?.trim();
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return `https://${url.host}/compatible-mode/v1/chat/completions`;
  } catch {
    return null;
  }
}

/** True when the active provider leaves translation to the service layer. */
export function needsTranslationService(providerId: string): boolean {
  const provider = resolveProvider(providerId);
  return provider ? !provider.capabilities.translation : false;
}

/** Fatal translation errors — retrying cannot help, so the chain stops
 *  immediately instead of burning its backoff budget. */
const FATAL_TRANSLATION_ERROR = /invalidKey|key missing/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Translate one finalized segment through the chain, with a short backoff
 *  retry for transient failures (network blips, cold gateways). Key errors
 *  fail fast. Null on total failure — the subtitle keeps its original text
 *  and the page's retranslation sweep picks it up once a stream recovers. */
export async function translateSegment(
  text: string,
  source: string,
  target: string,
  providerConfig: LiveTranslationProviderConfig,
): Promise<string | null> {
  const api = getDesktopLiveTranslationApi();
  if (!api?.translate) return null;
  const config = readTranslationServiceConfig();
  const providers = config.providers.filter((name) => {
    if (name === "ling") return Boolean(readLingKey(providerConfig));
    if (name === "qwen_mt") return Boolean(readQwenKey(providerConfig));
    return true;
  });
  if (providers.length === 0) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(500 * attempt);
    try {
      const result = await api.translate({
        text,
        source,
        target,
        kind: "sentence",
        providers,
        lingKey: readLingKey(providerConfig),
        qwenKey: readQwenKey(providerConfig),
        qwenEndpoint: readQwenEndpoint(providerConfig),
      });
      if (result.text) return result.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (FATAL_TRANSLATION_ERROR.test(message)) return null;
    }
  }
  return null;
}
