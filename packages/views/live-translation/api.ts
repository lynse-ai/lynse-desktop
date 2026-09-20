import { api } from "@lynse/core/api/client";
import type {
  LiveAudioSource,
  LiveAudioSourceMode,
  LiveConnectionDescriptor,
  LiveTranslationProviderConfig,
} from "./types";
import { DEFAULT_QWEN_ENDPOINT, DEFAULT_TENCENT_ASR_ENDPOINT, DEFAULT_VOLC_AST_ENDPOINT } from "./types";

/** Expand the capture-source mode into the connection source list. Unused
 * sources get no websocket, so a "system"-only session pays for one stream
 * instead of two. */
export function audioModeSources(mode: LiveAudioSourceMode | undefined): LiveAudioSource[] {
  if (mode === "mic") return ["mic"];
  if (mode === "system") return ["system"];
  return ["mic", "system"];
}

/** Human-readable identity of the endpoint a session is actually about to
 * dial: the `model` query parameter when present (Qwen realtime), otherwise
 * the host. Derived from the connection URL itself — never from the saved
 * config — so the confirmation shown to the user is what will really run. */
export function realtimeEngineLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("model") ?? parsed.host;
  } catch {
    return url;
  }
}

interface RealtimeSessionRequest {
  workspaceId?: string;
  sourceLanguage: string;
  targetLanguage: string;
  sessionId?: string;
  epoch: number;
}

interface RawRealtimeSessionResponse {
  sessionId: string;
  epoch?: number;
  expiresAt?: string;
  connections?: LiveConnectionDescriptor[];
  streams?: LiveConnectionDescriptor[] | Partial<Record<LiveAudioSource, { url: string } | string>>;
}

export interface RealtimeSessionCredentials {
  sessionId: string;
  epoch: number;
  expiresAt?: string;
  connections: LiveConnectionDescriptor[];
}

export async function requestRealtimeSession(
  request: RealtimeSessionRequest,
  providerConfig?: LiveTranslationProviderConfig,
): Promise<RealtimeSessionCredentials> {
  if (providerConfig?.provider === "ilivedata_direct") {
    return requestILiveDataRealtimeSession(request, providerConfig);
  }
  if (providerConfig?.provider === "qwen") {
    return requestQwenRealtimeSession(request, providerConfig);
  }
  if (providerConfig?.provider === "volc") {
    return requestVolcRealtimeSession(request, providerConfig);
  }
  if (providerConfig?.provider === "tencent") {
    return requestTencentRealtimeSession(request, providerConfig);
  }
  const response = await api().post<RawRealtimeSessionResponse>(
    "/api/business/translate/realtime/session",
    request,
  );
  const sources = audioModeSources(providerConfig?.audioSource);
  const connections = normalizeConnections(response)
    .filter((connection) => sources.includes(connection.source));
  if (!response.sessionId || connections.length === 0) {
    throw new Error("实时翻译服务未返回有效的双流连接");
  }
  return {
    sessionId: response.sessionId,
    epoch: response.epoch ?? request.epoch,
    expiresAt: response.expiresAt,
    connections,
  };
}

async function requestILiveDataRealtimeSession(
  request: RealtimeSessionRequest,
  config: LiveTranslationProviderConfig,
): Promise<RealtimeSessionCredentials> {
  const sessionId = request.sessionId ?? crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1_000);
  const token = await createILiveDataToken(
    config.ilivedata.pid,
    timestamp,
    config.ilivedata.secretKey,
  );
  const connections = await Promise.all(
    audioModeSources(config.audioSource).map(async (source) => ({
      source,
      url: buildILiveDataWebSocketUrl({
        endpoint: config.ilivedata.endpoint,
        pid: config.ilivedata.pid,
        token,
        timestamp,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        userId: createILiveDataUserId(sessionId, source, request.epoch),
        maxSpeakers: config.ilivedata.maxSpeakers,
      }),
    })),
  );
  return {
    sessionId,
    epoch: request.epoch,
    connections,
  };
}

async function requestQwenRealtimeSession(
  request: RealtimeSessionRequest,
  config: LiveTranslationProviderConfig,
): Promise<RealtimeSessionCredentials> {
  const sessionId = request.sessionId ?? crypto.randomUUID();
  const endpoint = config.qwen.endpoint.trim() || DEFAULT_QWEN_ENDPOINT;
  if (!endpoint.startsWith("wss://")) {
    throw new Error("Qwen WebSocket 地址必须使用 wss://");
  }
  if (!config.qwen.apiKey.trim()) {
    throw new Error("Qwen 翻译引擎需要填写 DashScope API Key");
  }
  const connections: LiveConnectionDescriptor[] = audioModeSources(
    config.audioSource,
  ).map((source) => ({
    source,
    url: endpoint,
    provider: "qwen",
    apiKey: config.qwen.apiKey.trim(),
  }));
  return {
    sessionId,
    epoch: request.epoch,
    connections,
  };
}

/**
 * Volcengine AST authenticates on the websocket upgrade headers, so there is no
 * token to mint here — the credentials are handed to the Rust side, which
 * attaches them to the handshake and speaks the protobuf protocol.
 */
async function requestVolcRealtimeSession(
  request: RealtimeSessionRequest,
  config: LiveTranslationProviderConfig,
): Promise<RealtimeSessionCredentials> {
  const sessionId = request.sessionId ?? crypto.randomUUID();
  const endpoint = config.volc.endpoint.trim() || DEFAULT_VOLC_AST_ENDPOINT;
  if (!endpoint.startsWith("wss://")) {
    throw new Error("火山 WebSocket 地址必须使用 wss://");
  }
  const apiKey = config.volc.apiKey.trim();
  if (!apiKey) {
    throw new Error("火山同声传译需要填写 Access Key");
  }
  const connections: LiveConnectionDescriptor[] = audioModeSources(
    config.audioSource,
  ).map((source) => ({
    source,
    url: endpoint,
    provider: "volc",
    apiKey,
  }));
  return {
    sessionId,
    epoch: request.epoch,
    connections,
  };
}

/**
 * Tencent Cloud real-time ASR authenticates through the URL itself (the query
 * string is HMAC-signed), and every websocket (re)connect needs a fresh
 * signature. The frontend therefore hands over only the base endpoint plus
 * the credentials; the Rust connection loop builds and signs the per-connect
 * URL. Tencent recognises but does not translate — a translation target is
 * ignored (the config card says so).
 */
async function requestTencentRealtimeSession(
  request: RealtimeSessionRequest,
  config: LiveTranslationProviderConfig,
): Promise<RealtimeSessionCredentials> {
  const sessionId = request.sessionId ?? crypto.randomUUID();
  const endpoint = config.tencent.endpoint.trim() || DEFAULT_TENCENT_ASR_ENDPOINT;
  if (!endpoint.startsWith("wss://")) {
    throw new Error("腾讯 WebSocket 地址必须使用 wss://");
  }
  const appId = config.tencent.appId.trim();
  if (!appId) {
    throw new Error("腾讯实时识别需要填写 AppID");
  }
  const secretId = config.tencent.secretId.trim();
  const secretKey = config.tencent.secretKey.trim();
  if (!secretId || !secretKey) {
    throw new Error("腾讯实时识别需要填写 SecretId 与 SecretKey");
  }
  const engineType = tencentEngineType(request.sourceLanguage, config.tencent.engineType);
  const base = `${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(appId)}`;
  const connections: LiveConnectionDescriptor[] = audioModeSources(
    config.audioSource,
  ).map((source) => ({
    source,
    url: base,
    provider: "tencent",
    extra: { secretId, secretKey, engineType },
  }));
  return {
    sessionId,
    epoch: request.epoch,
    connections,
  };
}

/** Resolve the Tencent engine type for a Lynse source language. An explicit
 * setting wins; otherwise a fixed engine is derived from the language (the
 * service has no auto-detect). Languages without a dedicated engine fall
 * back to Mandarin — callers should override the engine for them. */
export function tencentEngineType(sourceLanguage: string, configured?: string): string {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  switch (sourceLanguage) {
    case "zh-yue":
      return "16k_zh-PY";
    case "en":
      return "16k_en";
    case "ja":
      return "16k_ja";
    default:
      return "16k_zh";
  }
}

export async function createILiveDataToken(
  pid: string,
  timestamp: number,
  secretKey: string,
): Promise<string> {
  const normalizedPid = pid.trim();
  if (!/^\d+$/.test(normalizedPid)) {
    throw new Error("iLiveData PID 必须为数字");
  }
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new Error("iLiveData 鉴权时间戳无效");
  }
  const keyBytes = decodeBase64(secretKey);
  const keyData = new Uint8Array(keyBytes).buffer;
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${normalizedPid}:${timestamp}`),
  );
  return encodeBase64(new Uint8Array(signature));
}

export function buildILiveDataWebSocketUrl(input: {
  endpoint: string;
  pid: string;
  token: string;
  timestamp: number;
  sourceLanguage: string;
  targetLanguage: string;
  userId: string;
  /** Max speaker count for diarization; `0`/undefined disables it. */
  maxSpeakers?: number;
}): string {
  let url: URL;
  try {
    url = new URL(input.endpoint.trim());
  } catch {
    throw new Error("iLiveData WebSocket 地址无效");
  }
  if (url.protocol !== "wss:") {
    throw new Error("iLiveData WebSocket 地址必须使用 wss://");
  }
  url.searchParams.set("pid", input.pid.trim());
  url.searchParams.set("token", input.token);
  url.searchParams.set("ts", String(input.timestamp));
  url.searchParams.set("version", "1.0");
  url.searchParams.set("srcLanguage", input.sourceLanguage);
  url.searchParams.set("destLanguage", input.targetLanguage);
  url.searchParams.set("asrResult", "true");
  url.searchParams.set("asrTempResult", "true");
  url.searchParams.set("transResult", "true");
  url.searchParams.set("ttsResult", "false");
  url.searchParams.set("codec", "0");
  url.searchParams.set("userId", input.userId);
  // 1500ms VAD silence: natural pauses are common in meetings; a slightly
  // longer silence window keeps one sentence from being split into two.
  url.searchParams.set("vadSilenceTime", "1500");
  // ViiTor ASR 大模型：启用更高质量识别流程（空值或不传则保持默认识别）。
  url.searchParams.set("asrModel", "ViiTor");
  // digitalize：开启文本数字格式化（"100" → "一百" 等）。
  url.searchParams.set("digitalize", "true");
  // 说话人识别：maxSpeakers 仅在 speakerEnabled=true 时生效，
  // 且 API 要求取值大于 1，因此 normalizeMaxSpeakers 会把 <2 收敛为关闭。
  const maxSpeakers = normalizeMaxSpeakers(input.maxSpeakers);
  url.searchParams.set("speakerEnabled", String(maxSpeakers > 0));
  if (maxSpeakers > 0) {
    url.searchParams.set("maxSpeakers", String(maxSpeakers));
  }
  return url.toString();
}

/** Clamp the speaker-count setting to the documented range: 2..5, or 0 = off. */
export function normalizeMaxSpeakers(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  const rounded = Math.trunc(value);
  if (rounded < 2) return 0;
  return Math.min(5, rounded);
}

function createILiveDataUserId(sessionId: string, source: LiveAudioSource, epoch: number): string {
  const compactSessionId = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  return `lynse-${compactSessionId}-${source}-${epoch}`;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim().replace(/\s+/g, "");
  if (!normalized) throw new Error("iLiveData Secret Key 不能为空");
  try {
    const binary = atob(normalized);
    if (!binary) throw new Error("empty key");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("iLiveData Secret Key 必须是有效的 Base64 字符串");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function normalizeConnections(response: RawRealtimeSessionResponse): LiveConnectionDescriptor[] {
  if (Array.isArray(response.connections)) return response.connections;
  const streams = response.streams;
  if (Array.isArray(streams)) return streams;
  if (!streams) return [];
  return (["mic", "system"] as const).flatMap((source) => {
    const value = streams[source];
    const url = typeof value === "string" ? value : value?.url;
    return url ? [{ source, url }] : [];
  });
}
