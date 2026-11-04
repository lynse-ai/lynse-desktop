/**
 * Live-translation provider registry — built-in plugin registration.
 *
 * Every consumer (settings UI, connection minting, config bridge) imports
 * from this module so the built-ins are registered exactly once, in a stable
 * display order. Adding a provider that speaks an existing wire protocol is
 * one new plugin file plus a line here — no dispatch, storage or form code
 * changes.
 */
import { registerProvider } from "./registry";
import { lynseBackendPlugin } from "./lynse-backend";
import { iliveDataDirectPlugin } from "./ilivedata-direct";
import { qwenPlugin } from "./qwen";
import { volcPlugin } from "./volc";
import { tencentPlugin } from "./tencent";
import { customRealtimePlugin } from "./custom-realtime";
import { applePlugin } from "./apple";
import { isAppleLiveAsrSupported } from "./apple-support";

registerProvider(lynseBackendPlugin);
registerProvider(iliveDataDirectPlugin);
registerProvider(qwenPlugin);
registerProvider(volcPlugin);
registerProvider(tencentPlugin);
registerProvider(customRealtimePlugin);
// macOS 26+ only — registered late so the settings dropdown lists it last.
if (isAppleLiveAsrSupported()) {
  registerProvider(applePlugin);
}

export {
  effectiveValues,
  getProvider,
  isProviderConfigured,
  listProviders,
  listSecretVaultKeys,
  providerFieldValues,
  registerProvider,
  resolveProvider,
  secretVaultKey,
} from "./registry";
export type {
  LiveTranslationProviderPlugin,
  ProviderConnectionContext,
  ProviderFieldOption,
  ProviderFieldSpec,
  ProviderFieldValues,
} from "./types";
