import { useQuery } from "@tanstack/react-query";

import {
  getDesktopBotsApi,
  type BotChannelConfig,
  type BotChannelStatus,
} from "./types";

export function botConfigKey(channel: string) {
  return ["bot-config", channel] as const;
}

export function botStateKey(channel: string) {
  return ["bot-state", channel] as const;
}

/** A channel's persisted config (`enabled` + channel-specific fields). */
export function useBotConfig(channel: string) {
  const api = getDesktopBotsApi();
  return useQuery({
    queryKey: botConfigKey(channel),
    queryFn: () => api!.config(channel),
    enabled: !!api,
    staleTime: Infinity,
  });
}

/** A channel's live connection status (15s refresh + supervisor updates). */
export function useBotState(channel: string) {
  const api = getDesktopBotsApi();
  return useQuery({
    queryKey: botStateKey(channel),
    queryFn: () => api!.state(channel),
    enabled: !!api,
    refetchInterval: 15_000,
  });
}

export type { BotChannelConfig, BotChannelStatus };
