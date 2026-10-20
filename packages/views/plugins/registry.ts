import type {
  PluginManifest,
  PluginPlatform,
  PluginSettingsSectionContribution,
  PluginStateEntry,
} from "./types";

const registry = new Map<string, PluginManifest>();

/** Identity helper that gives plugin manifests a typed home. */
export function definePlugin<M extends PluginManifest>(manifest: M): M {
  return manifest;
}

export function registerPlugin(manifest: PluginManifest): void {
  if (registry.has(manifest.id)) {
    // Duplicate ids would make install state ambiguous; surface it loudly.
    console.warn(`[plugins] duplicate plugin id "${manifest.id}" — overwriting`);
  }
  registry.set(manifest.id, manifest);
}

export function getAllPlugins(): PluginManifest[] {
  return [...registry.values()];
}

export function getPluginById(pluginId: string): PluginManifest | undefined {
  return registry.get(pluginId);
}

/** The renderer platform, mirroring how desktop features detect the bridge
 * (`window.desktopAPI`, see apps/tauri/src/tauri-bridge.ts). */
export function detectPluginPlatform(): PluginPlatform {
  return typeof window !== "undefined" && "desktopAPI" in window ? "desktop" : "web";
}

export function isPluginAvailable(manifest: PluginManifest): boolean {
  if (!manifest.platforms.includes(detectPluginPlatform())) return false;
  if (manifest.availability && !manifest.availability()) return false;
  return true;
}

export interface PluginSectionBinding {
  manifest: PluginManifest;
  section: PluginSettingsSectionContribution;
}

/**
 * Settings sections contributed by app plugins, in contribution order.
 *
 * With `respectInstallState` off (marketplace flag disabled) every available
 * contributor shows — reproducing the pre-plugin behavior exactly, which is
 * the rollback story for the whole plugin system.
 */
export function getSettingsSections(
  entries: Record<string, PluginStateEntry>,
  options: { respectInstallState: boolean },
): PluginSectionBinding[] {
  const bindings: PluginSectionBinding[] = [];
  for (const manifest of getAllPlugins()) {
    const section =
      manifest.kind === "app" ? manifest.contributions?.settingsSection : undefined;
    if (!section) continue;
    if (!isPluginAvailable(manifest)) continue;
    if (options.respectInstallState && !entries[manifest.id]?.enabled) continue;
    bindings.push({ manifest, section });
  }
  return bindings.sort((a, b) => (a.section.order ?? 500) - (b.section.order ?? 500));
}

/** Connection plugins use the shared Connections host rather than a separate settings section. */
export function getConnectionProviders(entries: Record<string, PluginStateEntry>, options: { respectInstallState: boolean }) {
  return getAllPlugins().filter((manifest) => manifest.kind === "app" && !!manifest.contributions?.connectionProvider && isPluginAvailable(manifest) && (!options.respectInstallState || entries[manifest.id]?.enabled)).map((manifest) => ({ manifest, connection: manifest.contributions!.connectionProvider! }));
}
