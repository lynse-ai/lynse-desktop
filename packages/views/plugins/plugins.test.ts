import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "./types";

/**
 * Fresh module instances per test: the store reads localStorage and subscribes
 * a persistence hook at import time, and the migration probe has a module-level
 * "already checked" guard. `loadPluginModules` installs a window/localStorage
 * shim before the modules evaluate so those side effects run against the shim.
 */
async function loadPluginModules(map: Map<string, string>) {
  vi.resetModules();
  // defaultStorage (core/platform) touches the bare global `localStorage`;
  // core/config reads window.location.origin at module load. Shim both.
  const localStorageShim = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  (globalThis as { localStorage?: unknown }).localStorage = localStorageShim;
  (globalThis as { window?: unknown }).window = {
    location: { origin: "http://localhost:3000" },
    localStorage: localStorageShim,
  };
  const registry = await import("./registry");
  const state = await import("./state");
  const events = await import("./events");
  return { map, registry, state, events };
}

function testManifest(
  overrides: Partial<PluginManifest> & Pick<PluginManifest, "id">,
): PluginManifest {
  return {
    kind: "app",
    version: "1.0.0",
    minAppVersion: "1.0.0",
    nameKey: "plugins.test.name",
    descriptionKey: "plugins.test.description",
    icon: (() => null) as unknown as PluginManifest["icon"],
    category: "tool",
    platforms: ["desktop", "web"],
    permissions: [],
    ...overrides,
  };
}

describe("plugin registry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("filters plugins by platform and availability", async () => {
    // The window shim has no desktopAPI bridge, so this session is "web".
    const { registry } = await loadPluginModules(new Map());
    registry.registerPlugin(testManifest({ id: "desktop-only", platforms: ["desktop"] }));
    registry.registerPlugin(testManifest({ id: "everywhere" }));
    registry.registerPlugin(
      testManifest({ id: "gated", availability: () => false }),
    );
    const visible = registry
      .getAllPlugins()
      .filter(registry.isPluginAvailable)
      .map((m) => m.id);
    expect(visible).toEqual(["everywhere"]);
  });

  it("mounts connection plugins only when available, installed and enabled", async () => {
    const { registry } = await loadPluginModules(new Map());
    let beta = true;
    registry.registerPlugin(testManifest({ id: "gmail", availability: () => beta, contributions: { connectionProvider: { provider: "gmail", kind: "source" } } }));
    const installed = { gmail: { installedAt: 1, enabled: true } };
    const options = { respectInstallState: true };
    expect(registry.getConnectionProviders({}, options)).toEqual([]);
    expect(registry.getConnectionProviders({ gmail: { installedAt: 1, enabled: false } }, options)).toEqual([]);
    expect(registry.getConnectionProviders(installed, options).map((p) => p.connection.provider)).toEqual(["gmail"]);
    beta = false;
    expect(registry.getConnectionProviders(installed, options)).toEqual([]);
  });

  it("collects settings sections in contribution order and respects install state", async () => {
    const { registry } = await loadPluginModules(new Map());
    registry.registerPlugin(
      testManifest({
        id: "later",
        platforms: ["web"],
        contributions: {
          settingsSection: { id: "later", order: 200, component: () => null },
        },
      }),
    );
    registry.registerPlugin(
      testManifest({
        id: "earlier",
        platforms: ["web"],
        contributions: {
          settingsSection: { id: "earlier", order: 100, component: () => null },
        },
      }),
    );

    const entries = { earlier: { installedAt: 1, enabled: true } };

    const gated = registry.getSettingsSections(entries, { respectInstallState: true });
    expect(gated.map((b) => b.section.id)).toEqual(["earlier"]);

    // Flag-off fallback: every available contributor shows, pre-plugin style.
    const ungated = registry.getSettingsSections(entries, { respectInstallState: false });
    expect(ungated.map((b) => b.section.id)).toEqual(["earlier", "later"]);
  });
});

describe("plugin store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("persists install / enable / disable / uninstall transitions", async () => {
    const map = new Map<string, string>();
    const { state } = await loadPluginModules(map);
    const store = state.usePluginStore;

    expect(Object.keys(store.getState().entries)).toEqual([]);

    store.getState().install("lynse.p1");
    const installed = store.getState().entries["lynse.p1"];
    expect(installed?.enabled).toBe(true);
    expect(JSON.parse(map.get("lynse_plugins_state") ?? "{}")["lynse.p1"]?.enabled).toBe(true);

    store.getState().disable("lynse.p1");
    expect(store.getState().entries["lynse.p1"]?.enabled).toBe(false);

    store.getState().enable("lynse.p1");
    expect(store.getState().entries["lynse.p1"]?.enabled).toBe(true);

    store.getState().uninstall("lynse.p1");
    expect(store.getState().entries["lynse.p1"]).toBeUndefined();
    expect(map.get("lynse_plugins_state")).not.toContain("lynse.p1");
  });

  it("seeds upgrades exactly once and never resurrects uninstalled plugins", async () => {
    const map = new Map<string, string>();
    const first = await loadPluginModules(map);
    first.registry.registerPlugin(testManifest({ id: "legacy", migrate: () => true }));
    first.registry.registerPlugin(testManifest({ id: "modern", migrate: () => false }));

    await first.state.initPluginMigrations();
    expect(first.state.usePluginStore.getState().entries.legacy?.enabled).toBe(true);
    expect(first.state.usePluginStore.getState().entries.modern).toBeUndefined();

    // The user uninstalls the seeded plugin; state is now persisted.
    first.state.usePluginStore.getState().uninstall("legacy");
    expect(map.get("lynse_plugins_state")).not.toContain("legacy");

    // Second session: the probe must not run again (state key exists).
    const second = await loadPluginModules(map);
    second.registry.registerPlugin(testManifest({ id: "legacy", migrate: () => true }));
    await second.state.initPluginMigrations();
    expect(second.state.usePluginStore.getState().entries.legacy).toBeUndefined();
  });
});

describe("plugin events", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("delivers payloads, isolates failing handlers, and supports unsubscribe", async () => {
    const { events } = await loadPluginModules(new Map());
    const seen: string[] = [];
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const keeping = vi.fn((payload: { recordId: string }) => {
      seen.push(payload.recordId);
    });

    const offThrowing = events.subscribePluginEvent("transcription-completed", throwing);
    const offKeeping = events.subscribePluginEvent("transcription-completed", keeping);

    events.emitPluginEvent("transcription-completed", {
      recordId: "r1",
      source: "local",
    });
    expect(seen).toEqual(["r1"]);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(keeping).toHaveBeenCalledTimes(1);

    offThrowing();
    offKeeping();
    events.emitPluginEvent("transcription-completed", {
      recordId: "r2",
      source: "cloud",
    });
    expect(seen).toEqual(["r1"]);
  });
});
