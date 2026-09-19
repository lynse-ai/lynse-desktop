import { useEffect } from "react";
import { definePlugin } from "../registry";
import { subscribePluginEvent } from "../events";
import { getDesktopFeishuApi } from "../../feishu/feishu";
import { FeishuConfigCard } from "../../feishu/feishu-config-card";
import { pushMeetingSummaryToFeishu } from "../../feishu/feishu-push";
import { Bot } from "../../icons";

/**
 * Headless subscriber: pushes the finished summary card to the configured
 * group whenever the host emits a cloud transcription completion. The push
 * helper itself no-ops on web, for local (offline-transcribed) recordings,
 * and when the bot is off or no target group is picked.
 */
function FeishuTranscriptionSubscriber() {
  useEffect(
    () =>
      subscribePluginEvent("transcription-completed", (payload) => {
        void pushMeetingSummaryToFeishu({
          fileId: payload.recordId,
          title: payload.title ?? "",
          summary: payload.summary ?? null,
        });
      }),
    [],
  );
  return null;
}

/**
 * Feishu bot — the first bot-channel plugin (PRD §5.2). The channel-agnostic
 * answering pipeline (`packages/views/bots`) stays host infrastructure; this
 * manifest gates the Feishu-specific surfaces: the settings card, the
 * summary-push subscriber, and whether the channel may run at all (see
 * bots/channel-plugin-gate.ts).
 */
export const feishuBotPlugin = definePlugin({
  id: "lynse.feishu-bot",
  kind: "app",
  version: "1.0.0",
  minAppVersion: "1.0.4",
  nameKey: "plugins.feishuBot.name",
  descriptionKey: "plugins.feishuBot.description",
  icon: Bot,
  category: "integration",
  platforms: ["desktop"],
  permissions: ["background-connection", "secrets", "network:feishu", "events:transcription"],
  contributions: {
    settingsSection: {
      id: "feishu",
      titleKey: "feishu.title",
      order: 90,
      component: FeishuConfigCard,
    },
    eventSubscriptions: ["transcription-completed"],
    subscriberComponent: FeishuTranscriptionSubscriber,
  },
  availability: () => !!getDesktopFeishuApi(),
  lifecycle: {
    // The Rust side auto-starts the bot on launch while config.enabled — that
    // flag stays the single "bot wants to run" source of truth, so disabling
    // the plugin must persist it off, not just tear down the current socket.
    onEnable: async () => {
      const feishu = getDesktopFeishuApi();
      if (!feishu) return;
      const config = await feishu.getConfig();
      // No credentials yet: leave the flag off; the settings card takes over
      // once the user completes setup (its own switch is credential-gated).
      if (!config.appId || !config.hasSecret) return;
      await feishu.saveConfig({ ...config, enabled: true });
      await feishu.start();
    },
    onDisable: async () => {
      const feishu = getDesktopFeishuApi();
      if (!feishu) return;
      try {
        const config = await feishu.getConfig();
        await feishu.saveConfig({ ...config, enabled: false });
      } catch {
        // A failed config save must not block the teardown below.
      }
      await feishu.stop();
    },
  },
  // Pre-plugin installs configured Feishu through an always-present settings
  // section; any trace of that configuration seeds the plugin as installed.
  migrate: async () => {
    const feishu = getDesktopFeishuApi();
    if (!feishu) return false;
    try {
      const config = await feishu.getConfig();
      return !!(config.appId || config.hasSecret || config.enabled);
    } catch {
      return false;
    }
  },
});
