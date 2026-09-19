"use client";

/**
 * Remote plugin catalog (PRD §7): display metadata for the plugin community,
 * served from the same CloudBase static-hosting environment as the app
 * updater (`plugins/catalog.json`). The built-in registry is always the
 * source of truth — the remote catalog can only override display copy and add
 * "coming soon" placeholder entries. Every failure is silent: offline or a
 * broken catalog falls back to the built-in directory with zero UI impact.
 */

/** Same hosting environment as the updater endpoints in tauri.conf.json. */
const CATALOG_URL =
  "https://lynse-d8g49o1i956741f9e-1401959758.tcloudbaseapp.com/plugins/catalog.json";

/** Display-only overrides for a built-in plugin id, or a placeholder entry
 * for something not yet shipped (`installed: false`, id not in the registry). */
export interface CatalogPluginEntry {
  id: string;
  name?: string;
  description?: string;
  /** Placeholder card ("coming soon") — never installable. */
  comingSoon?: boolean;
}

export interface RemoteCatalog {
  catalogVersion: string;
  updatedAt: string;
  plugins: CatalogPluginEntry[];
}

let cache: RemoteCatalog | null = null;

/** Fetch and cache the remote catalog. Returns null on any failure (offline,
 *  malformed JSON, non-2xx) — callers keep the built-in directory. */
export async function fetchRemoteCatalog(timeoutMs = 5000): Promise<RemoteCatalog | null> {
  if (cache) return cache;
  if (typeof window === "undefined") return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(CATALOG_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    const plugins = (parsed as RemoteCatalog | null)?.plugins;
    if (!Array.isArray(plugins)) return null;
    cache = parsed as RemoteCatalog;
    return cache;
  } catch {
    return null;
  }
}

/** Apply remote display overrides for a manifest's name/description keys.
 *  Built-in i18n keys win whenever the catalog has no entry. */
export function catalogOverrideFor(
  catalog: RemoteCatalog | null,
  pluginId: string,
): CatalogPluginEntry | undefined {
  return catalog?.plugins.find((entry) => entry.id === pluginId && !entry.comingSoon);
}

/** Placeholder entries the catalog advertises that are not built in yet. */
export function catalogComingSoonEntries(catalog: RemoteCatalog | null): CatalogPluginEntry[] {
  if (!catalog) return [];
  return catalog.plugins.filter(
    (entry) => entry.comingSoon && entry.name && entry.description,
  );
}
