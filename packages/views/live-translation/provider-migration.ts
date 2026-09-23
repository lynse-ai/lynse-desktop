import type {
  LiveAudioSourceMode,
  PersistedLiveTranslationSettings,
} from "./types";
import { normalizeMaxSpeakers } from "./providers/shared";

/**
 * One-time migration from the pre-registry storage layout (one localStorage
 * key per provider field, provider ids from the old hard-coded union) to the
 * v2 settings blob. Pure and snapshot-driven so it is unit-testable without
 * Tauri or localStorage.
 *
 * Secrets are deliberately NOT part of the snapshot: they already live in the
 * OS-keychain vault under the same `lynse_live_translation_<provider>_<field>`
 * keys the registry derives, so there is nothing to move.
 */

export const LEGACY_PROVIDER_KEY = "lynse_live_translation_provider";
export const LEGACY_ILIVEDATA_ENDPOINT_KEY = "lynse_live_translation_ilivedata_endpoint";
export const LEGACY_ILIVEDATA_PID_KEY = "lynse_live_translation_ilivedata_pid";
export const LEGACY_ILIVEDATA_MAX_SPEAKERS_KEY = "lynse_live_translation_ilivedata_max_speakers";
export const LEGACY_QWEN_ENDPOINT_KEY = "lynse_live_translation_qwen_endpoint";
export const LEGACY_VOLC_ENDPOINT_KEY = "lynse_live_translation_volc_endpoint";
export const LEGACY_TENCENT_ENDPOINT_KEY = "lynse_live_translation_tencent_endpoint";
export const LEGACY_TENCENT_APP_ID_KEY = "lynse_live_translation_tencent_app_id";
export const LEGACY_TENCENT_ENGINE_KEY = "lynse_live_translation_tencent_engine";
export const LEGACY_AUDIO_SOURCE_KEY = "lynse_live_translation_audio_source";
export const LEGACY_SOURCE_LANGUAGE_KEY = "lynse_live_translation_source_language";
export const LEGACY_TARGET_LANGUAGE_KEY = "lynse_live_translation_target_language";

/** Written by builds that still supported the legacy (App Key) console. */
export const LEGACY_VOLC_APP_KEY = "lynse_live_translation_volc_app_key";

/** Written by builds that shipped the qwen3.5 realtime model. */
const LEGACY_QWEN_ENDPOINT_VALUE =
  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime";
/** Written by early direct-connection builds pointing at the test gate. */
const LEGACY_ILIVEDATA_ENDPOINT_VALUE = "wss://rtvt-bj-test.ilivedata.com/gate/websocket";

/** Providers the legacy union knew about; anything else was the backend. */
const LEGACY_DIRECT_PROVIDERS = new Set(["ilivedata_direct", "qwen", "volc", "tencent"]);

export interface LegacyLiveTranslationSnapshot {
  provider: string | null;
  ilivedataEndpoint: string | null;
  ilivedataPid: string | null;
  ilivedataMaxSpeakers: string | null;
  qwenEndpoint: string | null;
  volcEndpoint: string | null;
  tencentEndpoint: string | null;
  tencentAppId: string | null;
  tencentEngine: string | null;
  audioSource: string | null;
  sourceLanguage: string | null;
  targetLanguage: string | null;
}

/** Assemble a snapshot from localStorage the way the legacy bridge read it. */
export function collectLegacyLiveTranslationSnapshot(
  read: (key: string) => string | null,
): LegacyLiveTranslationSnapshot {
  return {
    provider: read(LEGACY_PROVIDER_KEY),
    ilivedataEndpoint: read(LEGACY_ILIVEDATA_ENDPOINT_KEY),
    ilivedataPid: read(LEGACY_ILIVEDATA_PID_KEY),
    ilivedataMaxSpeakers: read(LEGACY_ILIVEDATA_MAX_SPEAKERS_KEY),
    qwenEndpoint: read(LEGACY_QWEN_ENDPOINT_KEY),
    volcEndpoint: read(LEGACY_VOLC_ENDPOINT_KEY),
    tencentEndpoint: read(LEGACY_TENCENT_ENDPOINT_KEY),
    tencentAppId: read(LEGACY_TENCENT_APP_ID_KEY),
    tencentEngine: read(LEGACY_TENCENT_ENGINE_KEY),
    audioSource: read(LEGACY_AUDIO_SOURCE_KEY),
    sourceLanguage: read(LEGACY_SOURCE_LANGUAGE_KEY),
    targetLanguage: read(LEGACY_TARGET_LANGUAGE_KEY),
  };
}

/** Non-empty strings survive; retired test/legacy values are dropped so the
 * plugin defaults take over. */
function pickEndpoint(value: string | null, retired?: string): Record<string, string> {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === retired) return {};
  return { endpoint: trimmed };
}

export function migrateLegacyProviderSettings(
  snapshot: LegacyLiveTranslationSnapshot,
): PersistedLiveTranslationSettings {
  const audioSource: LiveAudioSourceMode =
    snapshot.audioSource === "mic" || snapshot.audioSource === "system"
      ? snapshot.audioSource
      : "both";
  const sourceLanguage = snapshot.sourceLanguage?.trim() || undefined;
  const targetLanguage = snapshot.targetLanguage?.trim() || undefined;

  const savedMaxSpeakers = snapshot.ilivedataMaxSpeakers
    ? Number.parseInt(snapshot.ilivedataMaxSpeakers, 10)
    // The legacy reader defaulted to 2 (self + counterpart) when unset.
    : 2;
  const maxSpeakers = Number.isNaN(savedMaxSpeakers) ? 0 : savedMaxSpeakers;

  return {
    version: 2,
    activeProvider:
      snapshot.provider && LEGACY_DIRECT_PROVIDERS.has(snapshot.provider)
        ? snapshot.provider
        : "lynse_backend",
    audioSource,
    sourceLanguage,
    targetLanguage,
    fields: {
      ilivedata_direct: {
        ...pickEndpoint(snapshot.ilivedataEndpoint, LEGACY_ILIVEDATA_ENDPOINT_VALUE),
        pid: snapshot.ilivedataPid?.trim() ?? "",
        maxSpeakers: String(normalizeMaxSpeakers(maxSpeakers)),
      },
      qwen: pickEndpoint(snapshot.qwenEndpoint, LEGACY_QWEN_ENDPOINT_VALUE),
      volc: pickEndpoint(snapshot.volcEndpoint),
      tencent: {
        ...pickEndpoint(snapshot.tencentEndpoint),
        appId: snapshot.tencentAppId?.trim() ?? "",
        engineType: snapshot.tencentEngine?.trim() ?? "",
      },
    },
  };
}

/** Guard against corrupt or future-shaped blobs: anything that does not parse
 * into the v2 layout yields null and the caller falls back to migration. */
export function parsePersistedSettings(raw: string | null): PersistedLiveTranslationSettings | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; fields?: unknown };
    if (parsed?.version !== 2 || typeof parsed.fields !== "object" || parsed.fields === null) {
      return null;
    }
    const settings = parsed as unknown as PersistedLiveTranslationSettings;
    if (typeof settings.activeProvider !== "string") return null;
    return settings;
  } catch {
    return null;
  }
}

/** Default settings for a fresh install (no blob, no legacy keys). */
export function defaultPersistedSettings(): PersistedLiveTranslationSettings {
  return {
    version: 2,
    activeProvider: "lynse_backend",
    audioSource: "both",
    fields: { ilivedata_direct: { maxSpeakers: "2" } },
  };
}
