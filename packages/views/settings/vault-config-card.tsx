"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@lynse/ui/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { FolderOpen, Loader2, ShieldAlert } from "../icons";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import type { VaultAccessReport } from "../live-translation/types";
import { getWorkbenchApi, refreshWorkbench, useWorkbench, useWikiEnabled } from "../workbench/api";
import { WorkbenchSettingsContent } from "../workbench/components";
import { BetaBadge } from "../beta-badge";
import {
  getDesktopVaultApi,
  isVaultPermissionError,
  useVaultConfig,
  VAULT_CONFIG_QUERY_KEY,
  type VaultConfig,
} from "../workspace/note-vault";

/** Settings card for the local markdown vault (desktop only). Renders nothing
 *  when the vault bridge is unavailable (web). */
export function VaultConfigCard({ onManageKnowledge, wikiSettings = false }: { onManageKnowledge?: () => void; wikiSettings?: boolean } = {}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const vaultApi = getDesktopVaultApi();
  const { data: config } = useVaultConfig();
  const [path, setPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [access, setAccess] = useState<VaultAccessReport | null>(null);
  const wikiEnabled = useWikiEnabled();
  const workbench = useWorkbench((state) => state.status);
  const lastSync = workbench?.initialComplete ? workbench.updatedAt : null;

  useEffect(() => {
    setPath(config?.path ?? null);
  }, [config?.path]);

  // Probe folder access whenever the configured folder changes, and keep
  // polling while the OS withholds it so the banner clears on its own once
  // the user flips the grant in System Settings (same cadence as onboarding).
  const accessBlocked = access?.state === "permissionDenied" || access?.state === "missing";
  useEffect(() => {
    const live = getDesktopLiveTranslationApi();
    if (!live?.vaultAccessCheck || !config?.enabled) {
      setAccess(null);
      return;
    }
    let cancelled = false;
    const probe = () => {
      live.vaultAccessCheck?.()
        .then((report) => {
          if (!cancelled) setAccess(report);
        })
        .catch(() => undefined);
    };
    probe();
    const timer = accessBlocked ? window.setInterval(probe, 2000) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [config?.enabled, config?.path, accessBlocked]);

  if (!vaultApi) return null;

  async function persist(next: VaultConfig) {
    if (!vaultApi) return;
    setSaving(true);
    try {
      const saved = await vaultApi.saveConfig(next);
      qc.setQueryData(VAULT_CONFIG_QUERY_KEY, saved);
      setPath(saved.path ?? null);
      await refreshWorkbench().catch(() => undefined);
    } catch (error) {
      await qc.invalidateQueries({ queryKey: VAULT_CONFIG_QUERY_KEY });
      await refreshWorkbench().catch(() => undefined);
      toast.error(
        t("vault.config_save_failed", { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(enabled: boolean) {
    if (!vaultApi) return;
    let target = path;
    if (enabled && !target) {
      // First-time enable: suggest ~/Documents/Lynse知识库 so one click works.
      target = await vaultApi.getDefaultPath().catch(() => null);
    }
    await persist({ enabled, path: target });
  }

  async function handleChangeFolder() {
    if (!vaultApi) return;
    const picked = await vaultApi.pickDirectory();
    if (!picked) return;
    await persist({ enabled: config?.enabled ?? false, path: picked });
  }

  async function handleOpenFolder() {
    if (!vaultApi || !path || opening) return;
    setOpening(true);
    try {
      await vaultApi.openVaultFolder(path);
    } catch {
      toast.error(t("vault.open_folder_failed"));
    } finally {
      setOpening(false);
    }
  }

  async function handleSyncAll() {
    if (!vaultApi || syncing) return;
    setSyncing(true);
    const loadingToastId = toast.loading(t("vault.sync_started"));
    try {
      const bridge = getWorkbenchApi();
      if (!bridge) throw new Error(t("workbench.sign_in"));
      await bridge.sync();
      await refreshWorkbench();
      toast.dismiss(loadingToastId);
    } catch (error) {
      if (isVaultPermissionError(error)) {
        toast.error(t("vault.sync_permission_denied"), { id: loadingToastId, duration: 10000 });
      } else {
        toast.error(t("vault.sync_failed", { error: error instanceof Error ? error.message : String(error) }), {
          id: loadingToastId,
        });
      }
    } finally {
      setSyncing(false);
    }
  }

  const enabled = config?.enabled ?? false;

  // Banner shown while the OS withholds the folder: the one place the user
  // is told what to flip, with a jump straight to the pane. Polls away on
  // its own once the grant lands.
  const accessBanner = enabled && accessBlocked && (
    <Alert variant="destructive" className="mt-1">
      <ShieldAlert className="size-4" />
      <AlertTitle className="text-xs">
        {access?.state === "missing" ? t("vault.access_missing_title") : t("vault.access_denied_title")}
      </AlertTitle>
      <AlertDescription className="text-2xs leading-relaxed">
        <p>{access?.state === "missing" ? t("vault.access_missing_hint") : t("vault.access_denied_hint")}</p>
        {access?.state === "permissionDenied" && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => void getDesktopLiveTranslationApi()?.openPrivacyPane("files")}
            >
              {t("vault.access_open_settings")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => {
                void getDesktopLiveTranslationApi()
                  ?.vaultRepairConsent?.()
                  .then((reset) => {
                    if (reset) toast.info(t("vault.access_repair_done"), { duration: 8000 });
                    else toast.error(t("vault.access_repair_failed"));
                  })
                  .catch(() => toast.error(t("vault.access_repair_failed")))
                  .then(() => getDesktopLiveTranslationApi()?.vaultAccessCheck?.())
                  .then((report) => report && setAccess(report))
                  .catch(() => undefined);
              }}
            >
              {t("vault.access_repair")}
            </Button>
          </div>
        )}
      </AlertDescription>
    </Alert>
  );

  const localFiles = <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor="vault-enable" className="text-xs">
        {t("vault.enable")}
      </Label>
      <Switch
        id="vault-enable"
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={saving}
      />
    </div>
    <p className="text-2xs leading-relaxed text-muted-foreground text-pretty">{t("vault.hint")}</p>
    {accessBanner}

    {enabled && (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate rounded-md border bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground"
            title={path ?? undefined}
          >
            {path ?? t("vault.no_path")}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            onClick={handleChangeFolder}
            disabled={saving}
          >
            <FolderOpen className="size-3.5" />
            {t("vault.change_folder")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-2xs text-muted-foreground">
            {lastSync
              ? t("vault.last_sync", { time: new Date(lastSync).toLocaleString() })
              : t("vault.never_synced")}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={handleOpenFolder}
              disabled={!path || opening}
            >
              {opening && <Loader2 className="size-3.5 animate-spin" />}
              {t("vault.open_folder")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleSyncAll}
              disabled={syncing}
            >
              {syncing && <Loader2 className="size-3.5 animate-spin" />}
              {t("vault.sync_now")}
            </Button>
          </div>
        </div>
      </>
    )}
  </div>;

  if (wikiSettings) return <WorkbenchSettingsContent disabled={saving} localFiles={localFiles} />;
  return <Card>
    <CardHeader className="pb-2"><CardTitle className="text-sm">{t("vault.title")}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {localFiles}
      {onManageKnowledge && wikiEnabled && <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.memory_settings_moved")}</p>
        <Button size="sm" variant="outline" onClick={onManageKnowledge}>{t("workbench.memory_manage")}<span aria-hidden="true"><BetaBadge /></span></Button>
      </div>}
    </CardContent>
  </Card>;
}
