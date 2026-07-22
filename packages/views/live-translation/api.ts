import { api } from "@lynse/core/api/client";
import type {
  LiveAudioSource,
  LiveConnectionDescriptor,
  LiveTranslationProviderConfig,
  LiveTranslationSegment,
} from "./types";

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
  const response = await api().post<RawRealtimeSessionResponse>(
    "/api/business/translate/realtime/session",
    request,
  );
  const connections = normalizeConnections(response);
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
    (["mic", "system"] as const).map(async (source) => ({
      source,
      url: buildILiveDataWebSocketUrl({
        endpoint: config.ilivedata.endpoint,
        pid: config.ilivedata.pid,
        token,
        timestamp,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        userId: createILiveDataUserId(sessionId, source, request.epoch),
      }),
    })),
  );
  return {
    sessionId,
    epoch: request.epoch,
    connections,
  };
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
  url.searchParams.set("vadSilenceTime", "1000");
  return url.toString();
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

export async function completeRealtimeSession(input: {
  sessionId: string;
  fileId: string;
  durationMs: number;
  segments: LiveTranslationSegment[];
}) {
  return api().post<unknown>(
    `/api/business/translate/realtime/session/${encodeURIComponent(input.sessionId)}/complete`,
    {
      fileId: input.fileId,
      durationMs: input.durationMs,
      segments: input.segments,
    },
  );
}
