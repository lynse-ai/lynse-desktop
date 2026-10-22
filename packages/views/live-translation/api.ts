import type {
  LiveConnectionDescriptor,
  LiveAudioSource,
  LiveTranslationProviderConfig,
} from "./types";
import { effectiveValues, resolveProvider } from "./providers";
import { audioModeSources } from "./providers/shared";

// Public helpers that predate the provider registry; the implementations
// live with the plugins that use them now.
export { audioModeSources, normalizeMaxSpeakers, realtimeEngineLabel } from "./providers/shared";
export { buildILiveDataWebSocketUrl, createILiveDataToken } from "./providers/ilivedata-direct";
export { tencentEngineType } from "./providers/tencent";
export { buildCustomRealtimeEndpoint } from "./providers/custom-realtime";

interface RealtimeSessionRequest {
  workspaceId?: string;
  audioSources?: LiveAudioSource[];
  sourceLanguage: string;
  targetLanguage: string;
  sessionId?: string;
  epoch: number;
}

export interface RealtimeSessionCredentials {
  sessionId: string;
  epoch: number;
  expiresAt?: string;
  connections: LiveConnectionDescriptor[];
}

/**
 * Mint the websocket connections for a session by dispatching to the active
 * provider plugin. Every start entry point (recording page, tray, quick
 * recording, island, meeting auto-record) funnels through here; per-provider
 * credential validation errors surface to the caller untouched.
 */
export async function requestRealtimeSession(
  request: RealtimeSessionRequest,
  config?: LiveTranslationProviderConfig,
): Promise<RealtimeSessionCredentials> {
  const plugin = resolveProvider(config?.activeProvider);
  const sessionId = request.sessionId ?? crypto.randomUUID();
  const connections = await plugin.buildConnections({
    // Field defaults (endpoints, model names) apply at use time — the
    // storage layer never bakes them in.
    values: effectiveValues(plugin, config?.values[plugin.id]),
    sources: request.audioSources?.length ? request.audioSources : audioModeSources(config?.audioSource),
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    sessionId,
    epoch: request.epoch,
    workspaceId: request.workspaceId,
  });
  return {
    sessionId,
    epoch: request.epoch,
    connections,
  };
}
