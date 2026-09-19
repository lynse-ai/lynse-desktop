"use client";

import { featureFlags } from "../feature-flags";
import { usePluginStore } from "./state";

/**
 * Bot channels contributed as plugins (channel id → plugin id). Channels
 * without an entry stay always-on until they are pluginized. Keep in sync
 * with the builtin registry (bots/types.ts BOT_CHANNELS ↔ Rust bots.rs).
 */
const CHANNEL_PLUGIN_IDS: Record<string, string> = {
  feishu: "lynse.feishu-bot",
};

/**
 * Whether a bot channel may run. With the marketplace flag off every channel
 * behaves pre-plugin; otherwise the channel must map to an installed + enabled
 * plugin (Rust auto-start is separately suppressed by the plugin lifecycle
 * persisting `enabled: false` into the channel config).
 */
export function isBotChannelActive(channel: string): boolean {
  if (!featureFlags.pluginMarketplace) return true;
  const pluginId = CHANNEL_PLUGIN_IDS[channel];
  if (!pluginId) return true;
  return !!usePluginStore.getState().entries[pluginId]?.enabled;
}
