import type {
  LiveAudioSource,
  LiveConnectionDescriptor,
  LiveTranslationProtocol,
} from "../types";

/**
 * One form field a provider needs the user to fill in. The declarative schema
 * is what the settings UI renders and what the config bridge persists — adding
 * a provider never touches form code.
 */
export interface ProviderFieldSpec {
  /** Stable key inside the per-provider value map (e.g. "apiKey"). */
  key: string;
  /** i18n key for the field label; `label` is the fallback when unset. */
  labelKey?: string;
  label?: string;
  kind: "text" | "password" | "select";
  /** Persisted to the OS keychain vault instead of localStorage. */
  secret?: boolean;
  /** Part of the default `isConfigured` readiness check. */
  required?: boolean;
  /** Shown for empty inputs; defaults to the field's `defaultValue`. */
  placeholder?: string;
  /** Applied when the stored value is empty (never persisted back). */
  defaultValue?: string;
  options?: ProviderFieldOption[];
  /** i18n key + fallback for helper text rendered under the field. */
  hintKey?: string;
  hint?: string;
}

export interface ProviderFieldOption {
  value: string;
  labelKey?: string;
  label?: string;
}

/** Field values for one provider, keyed by `ProviderFieldSpec.key`. */
export type ProviderFieldValues = Record<string, string>;

/** Everything a provider needs to mint the websocket connections for a
 * session. `values` arrives with per-field defaults already applied. */
export interface ProviderConnectionContext {
  values: ProviderFieldValues;
  sourceLanguage: string;
  targetLanguage: string;
  /** Capture streams to mint one connection per. */
  sources: LiveAudioSource[];
  sessionId: string;
  epoch: number;
  /** Lynse workspace for the backend relay (ignored by direct providers). */
  workspaceId?: string;
}

/**
 * A live-translation provider plugin: a self-describing module carrying its
 * display metadata, credential schema and connection-minting logic. New
 * providers that speak an existing wire protocol (`protocol`) need nothing
 * but this file — the Rust side dispatches on the protocol tag, not the id.
 */
export interface LiveTranslationProviderPlugin {
  /** Stable id persisted as `activeProvider` (e.g. "qwen", "custom"). */
  id: string;
  nameKey?: string;
  name: string;
  descriptionKey?: string;
  description?: string;
  /** Usage hint rendered at the top of the provider's form (warnings etc.). */
  hintKey?: string;
  hint?: string;
  /**
   * Wire protocol the Rust websocket loop speaks for this provider. Stamped
   * onto `LiveConnectionDescriptor.provider` by `buildConnections`.
   */
  protocol: LiveTranslationProtocol;
  capabilities: {
    translation: boolean;
    speakerDiarization?: boolean;
  };
  fields: ProviderFieldSpec[];
  /**
   * Vault-key segment override for secrets. Defaults to the plugin id; set it
   * when the id changed but legacy keychain entries must keep resolving
   * (iLiveData: id "ilivedata_direct", keys "…_ilivedata_…").
   */
  secretKeyPrefix?: string;
  /** Readiness check; defaults to "every required field non-empty". */
  isConfigured?(values: ProviderFieldValues): boolean;
  buildConnections(ctx: ProviderConnectionContext): Promise<LiveConnectionDescriptor[]>;
}
