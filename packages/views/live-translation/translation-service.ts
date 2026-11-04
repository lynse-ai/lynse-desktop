import { getDesktopLiveTranslationApi } from "./desktop-api";
import { resolveProvider } from "./providers";
import type { LiveTranslationProviderConfig } from "./types";

/** Translation service layer: a provider-priority chain used when the active
 *  ASR provider has no translation leg (Apple on-device, Tencent ASR). Chain
 *  order lives in a small localStorage blob; the Ling API key rides the apple
 *  provider plugin's keychain-backed `lingKey` field. */

export interface TranslationServiceConfig {
  /** Provider order, tried head-first: "apple" | "google" | "ling". */
  providers: string[];
}

const CONFIG_KEY = "lynse_translation_service";

export function readTranslationServiceConfig(): TranslationServiceConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TranslationServiceConfig>;
      const providers = Array.isArray(parsed.providers)
        ? parsed.providers.map(String).filter((name) => ["apple", "google", "ling"].includes(name))
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

/** True when the active provider leaves translation to the service layer. */
export function needsTranslationService(providerId: string): boolean {
  const provider = resolveProvider(providerId);
  return provider ? !provider.capabilities.translation : false;
}

/** Translate one finalized segment through the chain; null on total failure
 *  (the subtitle keeps its untranslated text). */
export async function translateSegment(
  text: string,
  source: string,
  target: string,
  providerConfig: LiveTranslationProviderConfig,
): Promise<string | null> {
  const api = getDesktopLiveTranslationApi();
  if (!api?.translate) return null;
  const config = readTranslationServiceConfig();
  const providers = config.providers.includes("ling") || readLingKey(providerConfig)
    ? config.providers
    : config.providers.filter((name) => name !== "ling");
  if (providers.length === 0) return null;
  try {
    const result = await api.translate({
      text,
      source,
      target,
      kind: "sentence",
      providers,
      lingKey: readLingKey(providerConfig),
    });
    return result.text;
  } catch {
    return null;
  }
}
