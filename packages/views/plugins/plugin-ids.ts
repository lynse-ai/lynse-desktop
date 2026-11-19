/**
 * Plugin id constants shared across modules that must not import the plugin
 * registry or builtin manifests (e.g. feature-flags) — keeps this a leaf
 * module with zero imports so nothing can form an import cycle through it.
 */
export const KNOWLEDGE_BASE_PLUGIN_ID = "lynse.knowledge-base";
