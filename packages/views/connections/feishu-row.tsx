"use client";

import { useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { isIntegrationAuthError, type IntegrationAccount } from "@lynse/core/integrations";
import { Loader2, Plus, RefreshCw } from "../icons";
import { DeleteConfirmDialog } from "../workspace/delete-confirm-dialog";
import { FeishuSetupDialog } from "./feishu-setup-dialog";
import { errorCopy } from "./provider-row";
import {
  useAccountToggles,
  useAutoExport,
  useDestinations,
  useDisconnect,
  useDefaultDestination,
} from "./use-connections";
import { useConnectFlow } from "./use-connect-flow";

/**
 * The CN-edition Feishu row.
 *
 * Domestic platforms authorize once and cover every service, so instead of
 * scattering feishu-calendar/feishu-docs/feishu-tasks rows across the service
 * groups, this single row binds the account (one consent, guided setup on
 * first connect) and renders the capabilities inline:
 *   - 日历: Sync/Notify switches (reminder pipeline)
 *   - 任务: default tasklist + auto-export switch
 *   - 同步/邮箱: no per-row config — exports start from the note page
 *
 * Status/connect ride `feishu-calendar`; the task controls write through the
 * `feishu-tasks` contract endpoints. All four share one gateway connection.
 */
export function FeishuRow({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslation();
  const [disconnectTarget, setDisconnectTarget] = useState<IntegrationAccount | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const flow = useConnectFlow("feishu-calendar", { isAuthenticated });
  const requestError = flow.error ?? flow.query.error;
  const reconnectRequired = isIntegrationAuthError(requestError);
  const status = flow.query.isError ? undefined : flow.query.data;
  const destinations = useDestinations("feishu-tasks", Boolean(status?.connected));
  const setDestination = useDefaultDestination("feishu-tasks");
  const autoExport = useAutoExport("feishu-tasks");
  const toggles = useAccountToggles("feishu-calendar");
  const disconnect = useDisconnect("feishu-calendar");

  const account = status?.accounts?.[0] ?? null;

  const onDisconnected = () => {
    setDisconnectTarget(null);
    toast.success(t("connections.disconnected", { provider: t("connections.provider.feishu") }));
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-13 font-medium">{t("connections.provider.feishu")}</p>
          <p className="truncate text-2xs text-muted-foreground">{t("connections.hint.feishu")}</p>
        </div>
        {status?.connected && (
          <span className="shrink-0 text-2xs text-success">{t("connections.connected")}</span>
        )}
        {flow.connecting && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {flow.error && (
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={flow.reset}>
            {t("connections.retry")}
          </Button>
        )}
        {status?.connected ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1 text-2xs"
            onClick={flow.start}
          >
            <Plus className="size-3" />
            {t("connections.add_account")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 text-2xs"
            disabled={flow.connecting}
            onClick={() => setSetupOpen(true)}
          >
            {t(reconnectRequired ? "connections.reconnect" : "connections.connect")}
          </Button>
        )}
      </div>

      {requestError && <p role="alert" className="text-2xs text-destructive">{errorCopy(requestError, t)}</p>}

      {account && (
        <div className="space-y-2.5 rounded-md bg-background/40 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
              {account.email}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-2xs text-muted-foreground hover:text-destructive"
              onClick={() => setDisconnectTarget(account)}
            >
              {t("connections.disconnect")}
            </Button>
          </div>

          <div>
            <p className="mb-1 text-2xs font-medium text-muted-foreground">
              {t("connections.group_calendar")}
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-1.5 text-2xs">
                <Switch
                  checked={account.sync_enabled}
                  disabled={toggles.isPending}
                  onCheckedChange={(checked) =>
                    toggles.mutate(
                      { accountId: account.id, syncEnabled: checked },
                      { onError: (e) => toast.error(errorCopy(e, t)) },
                    )
                  }
                />
                {t("connections.sync")}
              </label>
              <label className="flex items-center gap-1.5 text-2xs">
                <Switch
                  checked={account.notify_enabled}
                  disabled={toggles.isPending}
                  onCheckedChange={(checked) =>
                    toggles.mutate(
                      { accountId: account.id, notifyEnabled: checked },
                      { onError: (e) => toast.error(errorCopy(e, t)) },
                    )
                  }
                />
                {t("connections.notify")}
              </label>
            </div>
          </div>

          <div>
            <p className="mb-1 text-2xs font-medium text-muted-foreground">
              {t("connections.group_task")}
            </p>
            <div className="flex items-center gap-2">
              <Label className="shrink-0 text-2xs text-muted-foreground">
                {t("connections.default_destination")}
              </Label>
              <Select
                value={account.default_destination_id ?? undefined}
                onValueChange={(value) =>
                  setDestination.mutate(
                    { accountId: account.id, destinationId: String(value) },
                    { onError: (e) => toast.error(errorCopy(e, t)) },
                  )
                }
              >
                <SelectTrigger className="h-7 min-w-0 flex-1 text-2xs">
                  <SelectValue placeholder={t("connections.no_destination")} />
                </SelectTrigger>
                <SelectContent>
                  {(destinations.data?.destinations ?? []).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0"
                onClick={() => void destinations.refetch()}
                aria-label={t("connections.refresh")}
              >
                {destinations.isFetching ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw />
                )}
              </Button>
              <label className="flex items-center gap-1.5 text-2xs">
                <Switch
                  checked={account.auto_export}
                  disabled={autoExport.isPending}
                  onCheckedChange={(checked) =>
                    autoExport.mutate(
                      { accountId: account.id, autoExport: checked },
                      { onError: (e) => toast.error(errorCopy(e, t)) },
                    )
                  }
                />
                {t("connections.auto_export")}
              </label>
            </div>
          </div>

          <div>
            <p className="mb-1 text-2xs font-medium text-muted-foreground">
              {t("connections.group_sync")}
            </p>
            <p className="text-2xs text-muted-foreground">{t("connections.hint.feishu-docs")}</p>
            <p className="text-2xs text-muted-foreground">{t("connections.hint.feishu-mail")}</p>
          </div>
        </div>
      )}

      <FeishuSetupDialog provider="feishu-calendar" open={setupOpen} onOpenChange={setSetupOpen} />

      <DeleteConfirmDialog
        open={disconnectTarget !== null}
        description={t("connections.disconnect_confirm", {
          email: disconnectTarget?.email ?? "",
        })}
        pending={disconnect.isPending}
        confirmLabel={t("connections.disconnect")}
        onConfirm={() => {
          if (!disconnectTarget) return;
          disconnect.mutate(disconnectTarget.id, {
            onSuccess: onDisconnected,
            onError: (e) => toast.error(errorCopy(e, t)),
          });
        }}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
      />
    </div>
  );
}
