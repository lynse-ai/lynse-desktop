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
import {
  INTEGRATIONS_ERROR,
  isIntegrationAuthError,
  isNoDestinationError,
  isNotConfiguredError,
  isRequiresProError,
  type IntegrationAccount,
  type IntegrationsProvider,
} from "@lynse/core/integrations";
import { Loader2, Plus, RefreshCw } from "../icons";
import { DeleteConfirmDialog } from "../workspace/delete-confirm-dialog";
import { FeishuSetupDialog } from "./feishu-setup-dialog";
import {
  useAccountToggles,
  useAutoExport,
  useDestinations,
  useDisconnect,
  useDefaultDestination,
} from "./use-connections";
import { useConnectFlow } from "./use-connect-flow";

/**
 * One provider's row in the Connections section: identity + status, the
 * connect / add / disconnect verbs, and whatever per-account configuration the
 * provider kind owns (calendar accounts carry Sync/Notify, task and document
 * providers carry a default destination).
 *
 * Header/badge/confirm-destructive idiom follows `bots/channel-card-shell.tsx`;
 * the connected-identity block follows `settings/workbuddy-config-card.tsx`.
 * Unlike those two this one is list-shaped, because Pocket allows several
 * accounts per provider (PRD FR-1).
 */

export type ProviderKind = "calendar" | "destination";

export interface ProviderRowProps {
  provider: IntegrationsProvider;
  kind: ProviderKind;
  /** Show the per-account auto-export switch (task providers, PRD FR-2). */
  supportsAutoExport?: boolean;
  isAuthenticated: boolean;
}

/** Map the server's dotted keys to copy; unknown errors interpolate raw. */
export function errorCopy(error: unknown, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (isIntegrationAuthError(error)) return t("connections.error.unauthorized");
  if (isRequiresProError(error)) return t("connections.requires_pro");
  if (isNotConfiguredError(error)) return t("connections.not_configured");
  if (isNoDestinationError(error)) return t("connections.pick_a_destination_first");
  const message = error instanceof Error ? error.message : String(error);
  for (const key of Object.values(INTEGRATIONS_ERROR)) {
    if (message.includes(key)) return t(`connections.error.${key.split(".").pop()}`);
  }
  return t("connections.error.generic", { error: message });
}

export function ProviderRow({
  provider,
  kind,
  supportsAutoExport = false,
  isAuthenticated,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const [disconnectTarget, setDisconnectTarget] = useState<IntegrationAccount | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const flow = useConnectFlow(provider, { isAuthenticated });
  const requestError = flow.error ?? flow.query.error;
  const reconnectRequired = isIntegrationAuthError(requestError);
  const status = flow.query.isError ? undefined : flow.query.data;
  const destinations = useDestinations(provider, kind === "destination" && Boolean(status?.connected));
  const disconnect = useDisconnect(provider);
  const toggles = useAccountToggles(provider);
  const autoExport = useAutoExport(provider);

  const accounts = status?.accounts ?? [];
  // Feishu (Model B): until the user's own org app exists there is no
  // authorize URL to open — route Connect into the guided setup dialog. While
  // the status query is still loading we also treat setup as required: the
  // alternative (straight authorize) can only fail with not_configured, which
  // is what the "点击后连接失效" report traced back to.
  const needsSetup =
    provider.startsWith("feishu-") && (status === undefined || status.setup_required === true);

  const onDisconnected = () => {
    setDisconnectTarget(null);
    toast.success(t("connections.disconnected", { provider: t(`connections.provider.${provider}`) }));
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-13 font-medium">{t(`connections.provider.${provider}`)}</p>
          <p className="truncate text-2xs text-muted-foreground">
            {t(`connections.hint.${provider}`)}
          </p>
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
            onClick={() => (needsSetup ? setSetupOpen(true) : flow.start())}
          >
            {t(reconnectRequired ? "connections.reconnect" : "connections.connect")}
          </Button>
        )}
      </div>

      {requestError && (
        <p role="alert" className="text-2xs text-destructive">{errorCopy(requestError, t)}</p>
      )}

      {accounts.length > 0 && (
        <ul className="space-y-2">
          {accounts.map((account) => (
            <li key={account.id} className="space-y-1.5 rounded-md bg-background/40 px-2.5 py-2">
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

              {kind === "calendar" && (
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
              )}

              {kind === "destination" && (
                <DestinationPicker
                  provider={provider}
                  account={account}
                  query={destinations}
                  onSaved={() => flow.refetchStatus()}
                />
              )}

              {supportsAutoExport && (
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
              )}
            </li>
          ))}
        </ul>
      )}

      {needsSetup && (
        <FeishuSetupDialog provider={provider} open={setupOpen} onOpenChange={setSetupOpen} />
      )}

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

function DestinationPicker({
  provider,
  account,
  query,
  onSaved,
}: {
  provider: IntegrationsProvider;
  account: IntegrationAccount;
  query: ReturnType<typeof useDestinations>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const setDestination = useDefaultDestination(provider);
  const options = query.data?.destinations ?? [];

  return (
    <div className="flex items-center gap-2">
      <Label className="shrink-0 text-2xs text-muted-foreground">
        {t("connections.default_destination")}
      </Label>
      <Select
        value={account.default_destination_id ?? undefined}
        onValueChange={(value) =>
          setDestination.mutate(
            { accountId: account.id, destinationId: String(value) },
            {
              onSuccess: onSaved,
              onError: (e) => toast.error(errorCopy(e, t)),
            },
          )
        }
      >
        <SelectTrigger className="h-7 min-w-0 flex-1 text-2xs">
          <SelectValue placeholder={t("connections.no_destination")} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
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
        onClick={() => void query.refetch()}
        aria-label={t("connections.refresh")}
      >
        {query.isFetching ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
      </Button>
    </div>
  );
}
