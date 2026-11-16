import { definePlugin } from "../registry";
import { KNOWLEDGE_BASE_PLUGIN_ID } from "../plugin-ids";
import { isBetaFeaturesUnlocked } from "../../feature-flags";
import { getWorkbenchApi, refreshWorkbench } from "../../workbench/api";
import { BookOpen } from "../../icons";

/**
 * Knowledge base (workbench wiki / memory) as a first-class plugin. Like
 * every builtin it ships inside the binary — the manifest only gates its
 * user-facing surfaces: every entry point (sidebar, /memory page, desktop
 * chat context, home card, settings card, automation bind) reads the wiki
 * gate, which folds in this plugin's install state via
 * `isKnowledgePluginActiveIn` (see feature-flags.isWikiEnabled) and
 * WorkbenchSupervisor re-binds the native worker when it flips. Uninstalling
 * never deletes knowledge data — the destructive wipe stays the explicit
 * settings maintenance button.
 */
export const knowledgeBasePlugin = definePlugin({
  id: KNOWLEDGE_BASE_PLUGIN_ID,
  kind: "app",
  version: "1.0.0",
  minAppVersion: "1.2.11",
  nameKey: "plugins.knowledgeBase.name",
  descriptionKey: "plugins.knowledgeBase.description",
  icon: BookOpen,
  category: "tool",
  platforms: ["desktop"],
  permissions: ["storage:plugin-scope", "network:lynclaw"],
  // Same surfaces the wiki gate already hides: no desktop bridge (web) or a
  // non-beta channel means the whole plugin, community card included, stays
  // off — exactly the pre-plugin exposure.
  availability: () => !!getWorkbenchApi() && isBetaFeaturesUnlocked(),
  lifecycle: {
    // Re-binding and tearing down the native worker is owned by the
    // supervisor (it subscribes to this plugin's install state); these hooks
    // are belt-and-braces so the lifecycle contract holds on its own.
    onEnable: () => {
      void refreshWorkbench();
    },
    onDisable: () => {
      // Idempotent runtime stop: aborts the worker, clears the session —
      // safe to call repeatedly and without a bound session.
      void getWorkbenchApi()?.unbind();
    },
    // No-op on purpose: user data (memories, artifacts, index) is kept.
    onUninstall: () => {},
  },
  // The knowledge base predates the plugin system and shipped enabled for
  // every beta user — come up installed + enabled (workbuddy precedent).
  migrate: () => true,
});
