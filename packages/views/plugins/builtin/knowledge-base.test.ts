import { describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_BASE_PLUGIN_ID } from "../plugin-ids";

/**
 * Fresh module instances per test (same discipline as plugins.test.ts): the
 * store reads localStorage at import time and the migration probe has a
 * module-level "already checked" guard, so the shim is installed before the
 * modules evaluate. The real feature-flags module loads too so the wiki gate
 * composition is exercised end to end; the platform is simulated by
 * (un)setting `window.desktopAPI` — the exact signal detectPluginPlatform
 * reads.
 */
async function loadModules(map: Map<string, string>) {
  vi.resetModules();
  const localStorageShim = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  (globalThis as { localStorage?: unknown }).localStorage = localStorageShim;
  const windowShim: Record<string, unknown> = {
    location: { origin: "http://localhost:3000" },
    localStorage: localStorageShim,
  };
  (globalThis as { window?: unknown }).window = windowShim;
  const registry = await import("../registry");
  const state = await import("../state");
  const flags = await import("../../feature-flags");
  const manifest = await import("./knowledge-base");
  return { map, registry, state, flags, manifest, windowShim };
}

function setDesktopPlatform(windowShim: Record<string, unknown>): void {
  windowShim.desktopAPI = {};
}

describe("knowledge base plugin", () => {
  it("registers as the first builtin app plugin with the desktop-only contract", async () => {
    const { registry, manifest } = await loadModules(new Map());
    const plugins = await import("../index");
    const all = plugins.getAllPlugins();
    // Registration order defines the community listing order (top first).
    expect(all[0]?.id).toBe(KNOWLEDGE_BASE_PLUGIN_ID);
    expect(all[0]).toBe(manifest.knowledgeBasePlugin);
    expect(registry.getPluginById(KNOWLEDGE_BASE_PLUGIN_ID)?.kind).toBe("app");
    expect(manifest.knowledgeBasePlugin.platforms).toEqual(["desktop"]);
    // Without a desktop bridge (web) the availability gate hides every
    // surface, community card included.
    expect(manifest.knowledgeBasePlugin.availability?.()).toBe(false);
  });

  it("availability opens only on a desktop bridge in a beta channel", async () => {
    const { flags, manifest, windowShim } = await loadModules(new Map());
    const availability = manifest.knowledgeBasePlugin.availability as () => boolean;
    // Desktop bridge but official channel: the beta gate stays shut.
    setDesktopPlatform(windowShim);
    (windowShim.desktopAPI as Record<string, unknown>).workbench = {};
    expect(availability()).toBe(false);
    flags.configureBuildChannel("debug");
    expect(availability()).toBe(true);
  });

  it("gates by plugin install state on desktop but never on web or with the flag off", async () => {
    const { flags, windowShim } = await loadModules(new Map());

    // Web (no desktopAPI bridge): the gate stays open — web never runs the
    // plugin host and must keep its cloud fallback surfaces.
    expect(flags.isKnowledgePluginActiveIn({})).toBe(true);

    // Desktop with nothing installed yet (before the migration probe runs).
    setDesktopPlatform(windowShim);
    expect(flags.isKnowledgePluginActiveIn({})).toBe(false);

    const enabled = { [KNOWLEDGE_BASE_PLUGIN_ID]: { installedAt: 1, enabled: true } };
    const disabled = { [KNOWLEDGE_BASE_PLUGIN_ID]: { installedAt: 1, enabled: false } };
    expect(flags.isKnowledgePluginActiveIn(enabled)).toBe(true);
    expect(flags.isKnowledgePluginActiveIn(disabled)).toBe(false);

    // Marketplace rollback flag: pre-plugin behavior regardless of state.
    (flags.featureFlags as { pluginMarketplace: boolean }).pluginMarketplace = false;
    expect(flags.isKnowledgePluginActiveIn(disabled)).toBe(true);
  });

  it("isWikiEnabled folds the plugin state in on top of flag and beta gates", async () => {
    const { state, flags, windowShim } = await loadModules(new Map());
    flags.configureBuildChannel("debug"); // unlock the beta gate
    setDesktopPlatform(windowShim);

    // Plugin not seeded yet → wiki hidden even in a debug build.
    expect(flags.isWikiEnabled()).toBe(false);

    state.usePluginStore.setState({
      entries: { [KNOWLEDGE_BASE_PLUGIN_ID]: { installedAt: 1, enabled: true } },
    });
    expect(flags.isWikiEnabled()).toBe(true);

    state.usePluginStore.setState({
      entries: { [KNOWLEDGE_BASE_PLUGIN_ID]: { installedAt: 1, enabled: false } },
    });
    expect(flags.isWikiEnabled()).toBe(false);
  });

  it("starts off and follows the saved Desktop switch", async () => {
    const map = new Map<string, string>();
    const { state, registry, flags, manifest, windowShim } = await loadModules(map);
    const unbind = vi.fn();
    windowShim.desktopAPI = { workbench: { unbind } };
    flags.configureBuildChannel("debug");
    registry.registerPlugin(manifest.knowledgeBasePlugin);
    await state.initPluginMigrations();
    expect(state.usePluginStore.getState().entries[KNOWLEDGE_BASE_PLUGIN_ID]).toBeUndefined();
    expect(flags.isWikiEnabled()).toBe(false);

    state.usePluginStore.getState().install(KNOWLEDGE_BASE_PLUGIN_ID);
    expect(flags.isWikiEnabled()).toBe(true);

    await manifest.knowledgeBasePlugin.lifecycle?.onDisable?.();
    state.usePluginStore.getState().disable(KNOWLEDGE_BASE_PLUGIN_ID);
    expect(unbind).toHaveBeenCalledOnce();
    expect(flags.isWikiEnabled()).toBe(false);

    const restarted = await loadModules(map);
    setDesktopPlatform(restarted.windowShim);
    restarted.flags.configureBuildChannel("debug");
    restarted.registry.registerPlugin(restarted.manifest.knowledgeBasePlugin);
    await restarted.state.initPluginMigrations();
    expect(restarted.flags.isWikiEnabled()).toBe(false);
    restarted.state.usePluginStore.getState().enable(KNOWLEDGE_BASE_PLUGIN_ID);
    expect(restarted.flags.isWikiEnabled()).toBe(true);
  });
});
