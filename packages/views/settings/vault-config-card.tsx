"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { FolderOpen, Loader2 } from "../icons";
import { useNotes } from "../workspace/hooks/use-files";
import {
  getDesktopVaultApi,
  getVaultLastSync,
  markVaultLastSync,
  syncAllNotesToVault,
  useVaultConfig,
  VAULT_CONFIG_QUERY_KEY,
  type VaultConfig,
} from "../workspace/note-vault";

function toApiDateTime(d: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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
  const [lastSync, setLastSync] = useState<string | null>(null);

  // "All my meetings" — same wide range the notes page uses, so the sync
  // covers exactly the notes the user sees there.
  const endTime = useMemo(() => toApiDateTime(new Date()), []);
  const { data: notes } = useNotes({
    startTime: "2020-01-01T00:00:00",
    endTime,
  });

  useEffect(() => {
    setPath(config?.path ?? null);
    setLastSync(getVaultLastSync());
  }, [config?.path]);

  if (!vaultApi) return null;

  async function persist(next: VaultConfig) {
    if (!vaultApi) return;
    setSaving(true);
    try {
      const saved = await vaultApi.saveConfig(next);
      qc.setQueryData(VAULT_CONFIG_QUERY_KEY, saved);
      setPath(saved.path ?? null);
    } catch (error) {
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
      const summary = await syncAllNotesToVault(notes ?? [], {
        outline: t("vault.section_outline"),
        summary: t("vault.section_summary"),
      });
      markVaultLastSync();
      setLastSync(getVaultLastSync());
      if (summary.failed > 0) {
        toast.error(
          t("vault.sync_partial", { written: summary.written, failed: summary.failed }),
          { id: loadingToastId },
        );
      } else {
        toast.success(t("vault.sync_done", { count: summary.written }), { id: loadingToastId });
      }
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
        <p className="text-2xs leading-relaxed text-muted-foreground">{t("vault.hint")}</p>

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
      </CardContent>
    </Card>
  );
}
