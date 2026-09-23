import { DEFAULT_ILIVEDATA_RTVT_ENDPOINT } from "../types";
import type { LiveTranslationProviderPlugin } from "./types";
import { normalizeMaxSpeakers } from "./shared";

/** Selectable max-speaker counts for iLiveData diarization. `0` renders as
 * "off"; the API requires a value greater than 1, so the enabled range
 * starts at 2. */
const SPEAKER_COUNT_OPTIONS = [2, 3, 4, 5] as const;
const SPEAKER_OFF = "0";

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

function createILiveDataUserId(sessionId: string, source: "mic" | "system", epoch: number): string {
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

/**
 * iLiveData RTVT client-direct — the token is minted here with WebCrypto and
 * every parameter rides on the signed URL, so the websocket itself needs no
 * handshake auth. The Rust side speaks the plain JSON `method` protocol
 * (same wire shape as the backend relay).
 */
export const iliveDataDirectPlugin: LiveTranslationProviderPlugin = {
  id: "ilivedata_direct",
  nameKey: "live_translation.provider_ilivedata_direct",
  name: "iLiveData 客户端直连（测试）",
  hintKey: "live_translation.direct_test_hint",
  // Legacy keychain entries live under "…_ilivedata_secret_key"; keep them
  // resolving instead of re-keying the vault.
  secretKeyPrefix: "ilivedata",
  protocol: "direct",
  capabilities: { translation: true, speakerDiarization: true },
  fields: [
    { key: "endpoint", kind: "text", labelKey: "live_translation.provider_websocket_endpoint", defaultValue: DEFAULT_ILIVEDATA_RTVT_ENDPOINT },
    { key: "pid", kind: "text", labelKey: "live_translation.provider_pid", required: true },
    { key: "secretKey", kind: "password", labelKey: "live_translation.provider_secret_key", secret: true, required: true },
    {
      key: "maxSpeakers",
      kind: "select",
      labelKey: "live_translation.speaker_diarization",
      defaultValue: "2",
      hintKey: "live_translation.speaker_max_hint",
      options: [
        { value: SPEAKER_OFF, labelKey: "live_translation.speaker_off" },
        ...SPEAKER_COUNT_OPTIONS.map((count) => ({ value: String(count), label: String(count) })),
      ],
    },
  ],
  async buildConnections(ctx) {
    const pid = ctx.values.pid?.trim();
    if (!pid) throw new Error("iLiveData 翻译引擎需要填写 PID");
    const secretKey = ctx.values.secretKey?.trim();
    if (!secretKey) throw new Error("iLiveData 翻译引擎需要填写 Secret Key");
    const timestamp = Math.floor(Date.now() / 1_000);
    const token = await createILiveDataToken(pid, timestamp, secretKey);
    const maxSpeakers = Number.parseInt(ctx.values.maxSpeakers ?? "", 10);
    return Promise.all(
      ctx.sources.map(async (source) => ({
        source,
        url: buildILiveDataWebSocketUrl({
          endpoint: ctx.values.endpoint ?? "",
          pid,
          token,
          timestamp,
          sourceLanguage: ctx.sourceLanguage,
          targetLanguage: ctx.targetLanguage,
          userId: createILiveDataUserId(ctx.sessionId, source, ctx.epoch),
          maxSpeakers: Number.isNaN(maxSpeakers) ? undefined : maxSpeakers,
        }),
      })),
    );
  },
};
