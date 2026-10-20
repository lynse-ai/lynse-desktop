/**
 * Lynse plugin system (PRD: docs/plugin-architecture-prd.md, guide:
 * docs/plugin-development-guide.md).
 *
 * v1 = built-in plugins: manifests are compiled in but gated behind an
 * install/enable state, so users opt in via Settings → Plugins and entry
 * points appear only for installed plugins. Importing this module registers
 * the built-in plugins; the upgrade migration probe runs from PluginHost's
 * mount effect (after the Tauri bridge exists).
 */
export type {
  PluginManifest,
  PluginKind,
  PluginCategory,
  PluginPlatform,
  PluginPermission,
  PluginContributions,
  PluginSettingsSectionContribution,
  PluginSidebarItemContribution,
  PluginLifecycle,
  PluginStateEntry,
} from "./types";
export {
  definePlugin,
  registerPlugin,
  getAllPlugins,
  getPluginById,
  isPluginAvailable,
  detectPluginPlatform,
  getSettingsSections,
  getConnectionProviders,
} from "./registry";
export { usePluginStore, initPluginMigrations } from "./state";
export { emitPluginEvent, subscribePluginEvent } from "./events";
export { isBotChannelActive } from "./channel-plugin-gate";
export { useEmitTranscriptionCompleted } from "./transcription-events";
export { PluginHost } from "./plugin-host";
export { PluginCommunitySection } from "./plugin-community-section";

import "./builtin";
