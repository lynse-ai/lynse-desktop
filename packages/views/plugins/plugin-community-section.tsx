"use client";

import { useEffect, useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  catalogComingSoonEntries,
  catalogOverrideFor,
  fetchRemoteCatalog,
  type CatalogPluginEntry,
  type RemoteCatalog,
} from "./catalog";
import { getAllPlugins, isPluginAvailable } from "./registry";
import { usePluginStore } from "./state";
import { TranscriptionModelsSection } from "./transcription-models";
import type { PluginManifest, PluginStateEntry } from "./types";

/**
 * The plugin community (PRD §4.6): browse, install, enable/disable and
 * uninstall plugins. Renders inside Settings → Plugins; only plugins
 * available on the current platform are listed. The transcription-models
 * category (asset plugins) renders above the app plugins. A remote catalog
 * (PRD §7) may override display copy and add "coming soon" placeholders —
 * it never changes installability.
 */
export function PluginCommunitySection({
  onOpenSection,
}: {
  onOpenSection?: (sectionId: string) => void;
}) {
  const { t } = useTranslation();
  const entries = usePluginStore((s) => s.entries);
  const [catalog, setCatalog] = useState<RemoteCatalog | null>(null);
  const plugins = getAllPlugins().filter(
    (manifest) => manifest.kind === "app" && isPluginAvailable(manifest),
  );

  useEffect(() => {
    let cancelled = false;
    void fetchRemoteCatalog().then((remote) => {
      if (!cancelled && remote) setCatalog(remote);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <TranscriptionModelsSection onOpenSettings={onOpenSection ? () => onOpenSection("stt") : undefined} />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("plugins.community.title")}</CardTitle>
        </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t("plugins.community.hint")}
        </p>
        {plugins.map((manifest) => (
          <PluginRow
            key={manifest.id}
            manifest={manifest}
            entry={entries[manifest.id]}
            override={catalogOverrideFor(catalog, manifest.id)}
            onOpenSection={onOpenSection}
          />
        ))}
        {catalogComingSoonEntries(catalog).map((entry) => (
          <div key={entry.id} className="flex items-start gap-3 rounded-md border border-dashed bg-muted/20 p-2.5 opacity-70">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-xs font-medium">{entry.name}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                  {t("plugins.community.coming_soon")}
                </span>
              </div>
              <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{entry.description}</p>
            </div>
          </div>
        ))}
      </CardContent>
      </Card>
    </>
  );
}

function PluginRow({
  manifest,
  entry,
  override,
  onOpenSection,
}: {
  manifest: PluginManifest;
  entry: PluginStateEntry | undefined;
  override?: CatalogPluginEntry;
  onOpenSection?: (sectionId: string) => void;
}) {
  const { t } = useTranslation();
  const install = usePluginStore((s) => s.install);
  const uninstall = usePluginStore((s) => s.uninstall);
  const enable = usePluginStore((s) => s.enable);
  const disable = usePluginStore((s) => s.disable);
  // Two-step uninstall: the first click arms the destructive confirm, any
  // blur disarms it. Lighter than a dialog for a reversible action.
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);

  const Icon = manifest.icon;
  const installed = !!entry;
  const enabled = !!entry?.enabled;
  const section = manifest.contributions?.settingsSection;
  const sectionId = section?.id ?? (manifest.contributions?.connectionProvider ? "connections" : undefined);
  // Remote-catalog copy overrides the built-in i18n strings (PRD §7).
  const name = override?.name ?? t(manifest.nameKey);
  const description = override?.description ?? t(manifest.descriptionKey);

  async function handleInstall() {
    await manifest.lifecycle?.onInstall?.();
    install(manifest.id);
  }

  async function handleEnable() {
    await manifest.lifecycle?.onEnable?.();
    enable(manifest.id);
  }

  async function handleDisable() {
    await manifest.lifecycle?.onDisable?.();
    disable(manifest.id);
  }

  async function handleUninstall() {
    if (!confirmingUninstall) {
      setConfirmingUninstall(true);
      return;
    }
    setConfirmingUninstall(false);
    if (enabled) await manifest.lifecycle?.onDisable?.();
    await manifest.lifecycle?.onUninstall?.();
    uninstall(manifest.id);
  }

  return (
    <div className="flex items-start gap-3 rounded-md border bg-background p-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">{name}</span>
          {installed && (
            <span
              className={
                enabled
                  ? "rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary"
                  : "rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground"
              }
            >
              {enabled ? t("plugins.status.enabled") : t("plugins.status.disabled")}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
          {description}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!installed && (
            <Button size="sm" className="h-7 text-xs" onClick={handleInstall}>
              {t("plugins.action.install")}
            </Button>
          )}
          {installed && enabled && (
            <>
              {sectionId && onOpenSection && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onOpenSection(sectionId)}
                >
                  {t("plugins.action.settings")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={handleDisable}
              >
                {t("plugins.action.disable")}
              </Button>
            </>
          )}
          {installed && !enabled && (
            <Button size="sm" className="h-7 text-xs" onClick={handleEnable}>
              {t("plugins.action.enable")}
            </Button>
          )}
          {installed && (
            <Button
              size="sm"
              variant={confirmingUninstall ? "destructive" : "ghost"}
              className="h-7 text-xs"
              onClick={handleUninstall}
              onBlur={() => setConfirmingUninstall(false)}
            >
              {confirmingUninstall
                ? t("plugins.action.uninstall_confirm")
                : t("plugins.action.uninstall")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
