import { api } from "@lynse/core/api/client";
import type { LiveConnectionDescriptor } from "../types";
import type {
  LiveTranslationProviderPlugin,
  ProviderConnectionContext,
} from "./types";

interface RawRealtimeSessionResponse {
  sessionId: string;
  epoch?: number;
  expiresAt?: string;
  connections?: LiveConnectionDescriptor[];
  streams?: LiveConnectionDescriptor[] | Partial<Record<"mic" | "system", { url: string } | string>>;
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

/**
 * Lynse backend relay — the zero-config default. The server mints signed
 * double-stream websocket URLs; no local credentials exist for this plugin.
 */
export const lynseBackendPlugin: LiveTranslationProviderPlugin = {
  id: "lynse_backend",
  nameKey: "live_translation.provider_backend",
  name: "Lynse 后端签名",
  protocol: "direct",
  capabilities: { translation: true },
  fields: [],
  async buildConnections(ctx: ProviderConnectionContext) {
    const response = await api().post<RawRealtimeSessionResponse>(
      "/api/business/translate/realtime/session",
      {
        workspaceId: ctx.workspaceId,
        sourceLanguage: ctx.sourceLanguage,
        targetLanguage: ctx.targetLanguage,
        sessionId: ctx.sessionId,
        epoch: ctx.epoch,
      },
    );
    const connections = normalizeConnections(response).filter((connection) =>
      ctx.sources.includes(connection.source),
    );
    if (!response.sessionId || connections.length === 0) {
      throw new Error("实时翻译服务未返回有效的双流连接");
    }
    return connections;
  },
};
