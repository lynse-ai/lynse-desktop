"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { DeleteConfirmDialog } from "../workspace/delete-confirm-dialog";
import {
  CircleDot,
  Cpu,
  FileClock,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2,
  Mic,
  Terminal,
} from "../icons";
import {
  formatBytes,
  getDesktopStorageApi,
  type StorageCategoryId,
  type StorageUsage,
} from "./storage";
import { useVaultConfig } from "../workspace/note-vault";

type StorageRowMeta = {
  id: StorageCategoryId;
  icon: typeof Cpu;
  labelKey: string;
  hintKey?: string;
  /** "open" reveals the folder; "manage" jumps to the STT model list. */
  actions: ("open" | "manage" | "clear")[];
};

/** Display order mirrors the shell's USAGE_CATEGORIES; the icons and copy live
 * here so the shell stays UI-agnostic. */
const STORAGE_ROWS: StorageRowMeta[] = [
  { id: "stt", icon: Cpu, labelKey: "settings.storage_cat_stt", hintKey: "settings.storage_cat_stt_hint", actions: ["manage"] },
  { id: "inspirations", icon: Mic, labelKey: "settings.storage_cat_inspirations", actions: ["open"] },
  { id: "recovery", icon: CircleDot, labelKey: "settings.storage_cat_recovery", hintKey: "settings.storage_cat_recovery_hint", actions: ["open", "clear"] },
  { id: "transcriptions", icon: FileText, labelKey: "settings.storage_cat_transcriptions", hintKey: "settings.storage_cat_transcriptions_hint", actions: ["open"] },
  { id: "vault", icon: FolderOpen, labelKey: "settings.storage_cat_vault", hintKey: "settings.storage_cat_vault_hint", actions: ["open"] },
  { id: "reports", icon: FileClock, labelKey: "settings.storage_cat_reports", actions: ["open"] },
  { id: "logs", icon: Terminal, labelKey: "settings.storage_cat_logs", actions: ["open", "clear"] },
];

/** Rows whose files live inside the vault folder once it is enabled (the
 * shell relocates them automatically — see content_migration.rs). */
const VAULT_HOSTED_ROW_IDS: ReadonlySet<StorageCategoryId> = new Set([
  "inspirations",
  "recovery",
  "transcriptions",
]);

/**
 * Local-storage manager: total app-data footprint, per-category sizes, reveal
 * in the system file manager, and clearing for the two disposable categories
 * (app logs and unsynced live-recording recovery files). Desktop-only — the
 * shell bridge is missing on web, where the card renders nothing.
 */
export function StorageCard({ onManageModels }: { onManageModels?: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const storageApi = getDesktopStorageApi();
  const canManageModels = typeof onManageModels === "function";
  const { data: vaultConfig } = useVaultConfig();
  const vaultConfigured = !!vaultConfig?.path;
  const vaultHosted = !!vaultConfig?.enabled && vaultConfigured;

  const { data: usage, isLoading } = useQuery<StorageUsage>({
    queryKey: ["storage", "usage"],
    queryFn: () => storageApi!.usage(),
    enabled: !!storageApi,
    staleTime: 30_000,
  });
  // Storage row staged for clearing behind the themed confirm dialog.
  const [pendingClearRow, setPendingClearRow] = useState<StorageRowMeta | null>(null);
  const [clearing, setClearing] = useState(false);

  if (!storageApi) return null;

  const bytesByCategory = new Map(
    (usage?.categories ?? []).map((category) => [category.id, category.bytes]),
  );

  async function handleClear(row: StorageRowMeta) {
    if (row.id !== "logs" && row.id !== "recovery") return;
    // Stage the row; the themed confirm dialog runs the clear.
    setPendingClearRow(row);
  }

  async function confirmClear() {
    if (!pendingClearRow) return;
    const rowId = pendingClearRow.id;
    if (rowId !== "logs" && rowId !== "recovery") return;
    setClearing(true);
    try {
      await storageApi!.clear(rowId);
      await queryClient.invalidateQueries({ queryKey: ["storage", "usage"] });
      setPendingClearRow(null);
    } catch {
      /* the bridge surfaces its own error toast */
    } finally {
      setClearing(false);
    }
  }

  async function handleOpen(row: StorageRowMeta) {
    try {
      await storageApi!.reveal(row.id);
    } catch {
      /* vault-not-configured and similar shell errors surface as toasts */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("settings.storage_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2.5">
          <HardDrive className="size-4 shrink-0 text-muted-foreground" />
          {isLoading || !usage ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t("settings.storage_calculating")}
            </span>
          ) : (
            <p className="text-xs text-muted-foreground tabular-nums">
              {t("settings.storage_total_used", { size: formatBytes(usage.totalBytes) })}
              {typeof usage.freeBytes === "number" && (
                <span className="text-2xs"> · {t("settings.storage_free_disk", { size: formatBytes(usage.freeBytes) })}</span>
              )}
            </p>
          )}
        </div>

        <div className="space-y-1">
          {STORAGE_ROWS.map((row) => {
            const bytes = bytesByCategory.get(row.id) ?? 0;
            const vaultMissing = row.id === "vault" && !vaultConfigured;
            // Once the vault is enabled these rows sit inside its folder.
            const hintKey =
              vaultHosted && VAULT_HOSTED_ROW_IDS.has(row.id)
                ? "settings.storage_vault_hosted_hint"
                : row.hintKey;
            const Icon = row.icon;
            return (
              <div
                key={row.id}
                className="flex items-center gap-2.5 rounded-md border bg-background px-2.5 py-2"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{t(row.labelKey)}</p>
                  {hintKey && (
                    <p className="truncate text-2xs text-muted-foreground">{t(hintKey)}</p>
                  )}
                  {vaultMissing && (
                    <p className="truncate text-2xs text-muted-foreground">
                      {t("settings.storage_vault_not_configured")}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatBytes(bytes)}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {row.actions.includes("manage") && canManageModels && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-2xs"
                      onClick={onManageModels}
                    >
                      {t("settings.storage_manage_models")}
                    </Button>
                  )}
                  {row.actions.includes("open") && !vaultMissing && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-2xs"
                      onClick={() => void handleOpen(row)}
                    >
                      {t("settings.storage_open_folder")}
                    </Button>
                  )}
                  {row.actions.includes("clear") && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-2xs text-warning-text hover:text-warning-text"
                      onClick={() => void handleClear(row)}
                    >
                      {t("settings.storage_clear")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-2xs leading-relaxed text-muted-foreground text-pretty">
          {t("settings.storage_footnote")}
        </p>
      </CardContent>

      <DeleteConfirmDialog
        open={pendingClearRow !== null}
        description={t(
          pendingClearRow?.id === "recovery"
            ? "settings.storage_recovery_clear_confirm"
            : "settings.storage_clear_confirm",
          { name: t(pendingClearRow?.labelKey ?? "") },
        )}
        confirmLabel={t("settings.storage_clear")}
        pending={clearing}
        onConfirm={() => void confirmClear()}
        onOpenChange={(open) => {
          if (!open) setPendingClearRow(null);
        }}
      />
    </Card>
  );
}
