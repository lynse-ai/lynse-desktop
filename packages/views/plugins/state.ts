"use client";

import { create } from "zustand";
import { defaultStorage } from "@lynse/core/platform";
import { getAllPlugins } from "./registry";
import type { PluginStateEntry } from "./types";

const STORAGE_KEY = "lynse_plugins_state";

interface PluginRuntimeState {
  entries: Record<string, PluginStateEntry>;
  install: (pluginId: string) => void;
  uninstall: (pluginId: string) => void;
  enable: (pluginId: string) => void;
  disable: (pluginId: string) => void;
}

function loadEntries(): Record<string, PluginStateEntry> {
  const raw = defaultStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, PluginStateEntry>)
      : {};
  } catch {
    return {};
  }
}

export const usePluginStore = create<PluginRuntimeState>((set) => ({
  entries: loadEntries(),
  install: (pluginId) =>
    set((s) => ({
      entries: { ...s.entries, [pluginId]: { installedAt: Date.now(), enabled: true } },
    })),
  uninstall: (pluginId) =>
    set((s) => {
      const entries = { ...s.entries };
      delete entries[pluginId];
      return { entries };
    }),
  enable: (pluginId) =>
    set((s) => {
      const current = s.entries[pluginId];
      if (!current) return s;
      return { entries: { ...s.entries, [pluginId]: { ...current, enabled: true } } };
    }),
  disable: (pluginId) =>
    set((s) => {
      const current = s.entries[pluginId];
      if (!current) return s;
      return { entries: { ...s.entries, [pluginId]: { ...current, enabled: false } } };
    }),
}));

if (typeof window !== "undefined") {
  usePluginStore.subscribe((state) => {
    try {
      defaultStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
    } catch {
      // ignore quota / private-mode errors
    }
  });
}

let migrationsChecked = false;

/**
 * One-shot upgrade probe (PRD §6): while no plugin state has ever been
 * persisted, ask each registered plugin whether pre-plugin installs should
 * come up installed + enabled. Runs once per session; once any state lands in
 * storage (including a user uninstall) the probe never runs again, so an
 * uninstalled plugin is not resurrected on the next launch.
 */
export async function initPluginMigrations(): Promise<void> {
  if (migrationsChecked) return;
  migrationsChecked = true;
  if (defaultStorage.getItem(STORAGE_KEY) !== null) return;

  const seeds: Record<string, PluginStateEntry> = {};
  for (const manifest of getAllPlugins()) {
    if (!manifest.migrate) continue;
    try {
      if (await manifest.migrate()) {
        seeds[manifest.id] = { installedAt: Date.now(), enabled: true };
      }
    } catch {
      // A failing probe must never block the store; treat as not installed.
    }
  }
  if (Object.keys(seeds).length > 0) {
    usePluginStore.setState((s) => ({ entries: { ...seeds, ...s.entries } }));
  }
}
