"use client";

import { useEffect } from "react";
import { getAllPlugins, isPluginAvailable } from "./registry";
import { initPluginMigrations, usePluginStore } from "./state";

/**
 * Mounts headless subscriber components for every installed + enabled plugin
 * that declares event subscriptions (see events.ts), and kicks the one-shot
 * upgrade migration probe. Renders nothing until a plugin contributes a
 * subscriber — the first is the Feishu summary-push subscriber (PRD P3).
 *
 * The probe runs in a mount effect, not at import time: the Tauri bridge is
 * installed in main.tsx's body, after the module graph has already evaluated,
 * so bridge-dependent migrate probes would see no desktopAPI at import time.
 */
export function PluginHost() {
  const entries = usePluginStore((s) => s.entries);

  useEffect(() => {
    void initPluginMigrations();
  }, []);

  const subscribers = getAllPlugins().filter(
    (manifest) =>
      manifest.kind === "app" &&
      !!manifest.contributions?.subscriberComponent &&
      !!manifest.contributions?.eventSubscriptions?.length &&
      isPluginAvailable(manifest) &&
      !!entries[manifest.id]?.enabled,
  );
  return (
    <>
      {subscribers.map((manifest) => {
        const Subscriber = manifest.contributions!.subscriberComponent!;
        return <Subscriber key={manifest.id} />;
      })}
    </>
  );
}
