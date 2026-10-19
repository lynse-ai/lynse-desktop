"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { FolderOpen, Loader2 } from "../icons";
import { getWorkbenchApi, refreshWorkbench, useWorkbench } from "../workbench/api";
import { WorkbenchSettingsContent } from "../workbench/components";
import {
  getDesktopVaultApi,
  useVaultConfig,
  VAULT_CONFIG_QUERY_KEY,
  type VaultConfig,
} from "../workspace/note-vault";

/** Settings card for the local markdown vault (desktop only). Renders nothing
 *  when the vault bridge is unavailable (web). */
export function VaultConfigCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const vaultApi = getDesktopVaultApi();
  const { data: config } = useVaultConfig();
  const [path, setPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const workbench = useWorkbench((state) => state.status);
  const lastSync = workbench?.initialComplete ? workbench.updatedAt : null;

  useEffect(() => {
    setPath(config?.path ?? null);
  }, [config?.path]);

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
        t("vault.config_save_failed", { error: error instanceof Error ? error.message : "" }),
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
    if (!vaultApi || !path) return;
    try {
      await vaultApi.openVaultFolder(path);
    } catch {
      toast.error(t("vault.open_folder_failed"));
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
      toast.error(t("vault.sync_failed", { error: error instanceof Error ? error.message : "" }), {
        id: loadingToastId,
      });
    } finally {
      setSyncing(false);
    }
  }

  const enabled = config?.enabled ?? false;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("vault.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
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

        {enabled && (
          <>
            <div className="flex items-center gap-2">
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
            <div className="flex items-center justify-between gap-3">
              <span className="text-2xs text-muted-foreground">
                {lastSync
                  ? t("vault.last_sync", { time: new Date(lastSync).toLocaleString() })
                  : t("vault.never_synced")}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={handleOpenFolder}
                  disabled={!path}
                >
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
        <WorkbenchSettingsContent disabled={saving} />
      </CardContent>
    </Card>
  );
}
