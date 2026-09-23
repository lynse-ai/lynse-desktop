import type { LiveTranslationProviderConfig } from "../types";
import type {
  LiveTranslationProviderPlugin,
  ProviderFieldSpec,
  ProviderFieldValues,
} from "./types";

const registry = new Map<string, LiveTranslationProviderPlugin>();

/** Register a provider plugin. Duplicate ids are a programming error — the
 * built-in set is static, so a collision means two files picked one id. */
export function registerProvider(plugin: LiveTranslationProviderPlugin): void {
  if (registry.has(plugin.id)) {
    throw new Error(`live translation provider already registered: ${plugin.id}`);
  }
  registry.set(plugin.id, plugin);
}

export function getProvider(id: string): LiveTranslationProviderPlugin | undefined {
  return registry.get(id);
}

/** All registered plugins in registration order (drives the settings UI). */
export function listProviders(): LiveTranslationProviderPlugin[] {
  return [...registry.values()];
}

/** Resolve the plugin a session should attach to. Unknown or absent ids fall
 * back to the zero-config Lynse backend relay, mirroring the legacy bridge
 * behaviour where any unrecognized provider string meant the relay. */
export function resolveProvider(id: string | undefined): LiveTranslationProviderPlugin {
  const plugin = id ? registry.get(id) : undefined;
  if (plugin) return plugin;
  const backend = registry.get("lynse_backend");
  if (!backend) {
    throw new Error("lynse_backend provider plugin is not registered");
  }
  return backend;
}

/** OS-keychain vault key for one secret field:
 * `lynse_live_translation_<prefix>_<fieldKey>`. The prefix defaults to the
 * plugin id; `secretKeyPrefix` keeps legacy ids resolving in place. Field
 * keys are converted to snake_case to match the vault layout the
 * pre-registry builds wrote (`…_qwen_api_key`, `…_tencent_secret_id`), so
 * existing credentials keep resolving without re-keying the vault. */
export function secretVaultKey(
  plugin: LiveTranslationProviderPlugin,
  field: ProviderFieldSpec,
): string {
  const prefix = plugin.secretKeyPrefix ?? plugin.id;
  const segment = field.key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return `lynse_live_translation_${prefix}_${segment}`;
}

/** Every secret vault key across all registered plugins — the allowlist the
 * desktop secure-storage module needs up front. */
export function listSecretVaultKeys(): string[] {
  const keys: string[] = [];
  for (const plugin of registry.values()) {
    for (const field of plugin.fields) {
      if (field.secret) keys.push(secretVaultKey(plugin, field));
    }
  }
  return keys;
}

/** Stored values with per-field defaults applied for empty entries. Defaults
 * are never persisted back — the plugin owns them, not the storage. */
export function effectiveValues(
  plugin: LiveTranslationProviderPlugin,
  raw?: ProviderFieldValues,
): ProviderFieldValues {
  const values: ProviderFieldValues = {};
  for (const field of plugin.fields) {
    const value = raw?.[field.key]?.trim() ?? "";
    values[field.key] = value || field.defaultValue?.trim() || "";
  }
  return values;
}

/** True when the provider has everything it needs to open a session. Direct
 * providers talk to the vendor from this machine, so their credentials must
 * be complete before a session can start; the backend relay needs nothing. */
export function isProviderConfigured(
  plugin: LiveTranslationProviderPlugin,
  raw?: ProviderFieldValues,
): boolean {
  if (plugin.isConfigured) return plugin.isConfigured(effectiveValues(plugin, raw));
  const values = effectiveValues(plugin, raw);
  return plugin.fields.filter((field) => field.required).every((field) => values[field.key]);
}

/** Merge a provider's stored values with its resolved secrets into the flat
 * value map the UI edits and `buildConnections` consumes. */
export function providerFieldValues(
  config: LiveTranslationProviderConfig,
  pluginId: string,
): ProviderFieldValues {
  return config.values[pluginId] ?? {};
}
