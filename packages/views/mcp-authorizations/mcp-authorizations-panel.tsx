"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { api } from "@lynse/core/api/client";
import { Button } from "@lynse/ui/components/ui/button";
import { Badge } from "@lynse/ui/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@lynse/ui/lib/utils";
import { bootstrapConsole, consoleAction, fetchConsoleState, type McpAuthorization } from "./mcp-bridge";

/** Status badge tone per the bridge's valid → revoked/expired → delete state machine. */
const STATUS_VARIANT: Record<McpAuthorization["status"], "default" | "secondary" | "destructive"> = {
  valid: "default",
  expired: "secondary",
  revoked: "destructive",
};

function formatTime(seconds: number): string {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * Console list of MCP application authorizations: silent token-login
 * bootstrap, then list / revoke / delete against the website bridge.
 * Reused by the standalone /authorizations page and the Agent 配置 console.
 */
export function McpAuthorizationsPanel({ dense = false }: { dense?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ action: "revoke" | "delete"; item: McpAuthorization } | null>(null);

  const query = useQuery({
    queryKey: ["mcp", "authorizations"],
    queryFn: async () => {
      let state = await fetchConsoleState();
      if (!state.user) {
        // Silent sign-in with the web app's own account token; a mismatched
        // environment (e.g. production token against the test bridge) keeps
        // the console in its logged-out state instead of erroring out.
        const token = api().getToken();
        if (token) {
          try {
            state = await bootstrapConsole(state, token);
          } catch {
            // fall through with the logged-out state
          }
        }
      }
      return state;
    },
  });

  const act = useMutation({
    mutationFn: async ({ action, item }: { action: "revoke" | "delete"; item: McpAuthorization }) => {
      const csrf = query.data?.csrf ?? "";
      const verb = action === "revoke" ? "authorization-revoke" : "authorization-delete";
      await consoleAction(verb, csrf, { authorization_id: item.authorization_id });
    },
    onSuccess: (_data, variables) => {
      toast.success(t(variables.action === "revoke" ? "mcpAuthorizations.revoked_ok" : "mcpAuthorizations.deleted_ok"));
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ["mcp", "authorizations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const state = query.data;
  const authorizations = [...(state?.authorizations ?? [])].sort(
    (a, b) => b.authorized_at - a.authorized_at,
  );

  return (
    <div className={cn("space-y-3", dense && "text-sm")}>
      {query.isLoading && <p className="text-xs text-muted-foreground">{t("mcpAuthorizations.loading")}</p>}
      {query.isError && <p className="text-2xs text-destructive" role="alert">{t("mcpAuthorizations.load_failed")}</p>}
      {state && !state.user && !query.isLoading && (
        <p className="text-xs text-muted-foreground">{t("mcpAuthorizations.not_logged_in")}</p>
      )}
      {state?.user && authorizations.length === 0 && !query.isLoading && (
        <p className="text-xs text-muted-foreground">{t("mcpAuthorizations.empty")}</p>
      )}
      {authorizations.map((item) => (
        <div key={item.authorization_id} className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{item.client_name}</p>
              <p className="truncate text-2xs text-muted-foreground">{item.client_id}</p>
            </div>
            <Badge variant={STATUS_VARIANT[item.status]} className="shrink-0 text-2xs">
              {t(`mcpAuthorizations.status_${item.status}`)}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
            <span>{item.scopes.join("、")}</span>
            <span>{t("mcpAuthorizations.authorized_at")}: {formatTime(item.authorized_at)}</span>
            <span>{t("mcpAuthorizations.expires_at")}: {formatTime(item.expires_at)}</span>
          </div>
          <div className="flex justify-end gap-2">
            {item.status === "valid" && (
              <Button size="sm" variant="outline" disabled={act.isPending}
                onClick={() => setPending({ action: "revoke", item })}>
                {t("mcpAuthorizations.revoke")}
              </Button>
            )}
            {item.status !== "valid" && (
              <Button size="sm" variant="ghost" disabled={act.isPending}
                onClick={() => setPending({ action: "delete", item })}>
                {t("mcpAuthorizations.delete")}
              </Button>
            )}
          </div>
        </div>
      ))}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t(pending?.action === "delete" ? "mcpAuthorizations.delete_title" : "mcpAuthorizations.revoke_title")}
            </DialogTitle>
            <DialogDescription>
              {pending?.item.client_name}
              {pending?.action === "revoke"
                ? t("mcpAuthorizations.revoke_body")
                : t("mcpAuthorizations.delete_body")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => setPending(null)}>
              {t("mcpAuthorizations.cancel")}
            </Button>
            <Button size="sm" variant={pending?.action === "revoke" ? "destructive" : "default"}
              className={cn(pending?.action === "delete" && "hidden")} disabled={act.isPending}
              onClick={() => pending && act.mutate(pending)}>
              {t("mcpAuthorizations.confirm_revoke")}
            </Button>
            <Button size="sm" variant={pending?.action === "delete" ? "destructive" : "default"}
              className={cn(pending?.action === "revoke" && "hidden")} disabled={act.isPending}
              onClick={() => pending && act.mutate(pending)}>
              {t("mcpAuthorizations.confirm_delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
