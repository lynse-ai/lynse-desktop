"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
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

const STATUS_VARIANT: Record<McpAuthorization["status"], "default" | "secondary" | "destructive"> = {
  valid: "default",
  expired: "secondary",
  revoked: "destructive",
  reset_required: "secondary",
};

type AuthorizationAction = "revoke" | "reset" | "delete";

function formatTime(seconds: number): string {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * Account-level console for MCP and CLI authorizations.
 * Reused by the standalone /authorizations page and the Agent 配置 console.
 */
export function McpAuthorizationsPanel({ dense = false }: { dense?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const subject = useAuthStore((state) => state.user?.id ?? "");
  const [pending, setPending] = useState<{ action: AuthorizationAction; item: McpAuthorization; subject: string } | null>(null);
  const seen = useRef<{ subject: string; records: Set<string> } | null>(null);
  const queryKey = ["mcp", "authorizations", subject];

  const query = useQuery({
    queryKey,
    refetchInterval: 15_000,
    queryFn: async () => {
      let state = await fetchConsoleState();
      if (!state.user || (subject && state.user.subject && state.user.subject !== subject)) {
        const token = api().getToken();
        if (token) {
          try {
            state = await bootstrapConsole(state, token);
          } catch {
            return { ...state, user: null, authorizations: [] };
          }
        }
      }
      if (subject && state.user?.subject && state.user.subject !== subject) {
        return { ...state, user: null, authorizations: [] };
      }
      return state;
    },
  });

  useEffect(() => {
    const state = query.data;
    if (!state?.user) return;
    const owner = state.user.subject ?? subject;
    const previous = seen.current;
    seen.current = { subject: owner, records: new Set(state.authorizations.map((record) => record.authorization_id)) };
    if (previous?.subject !== owner) return;
    for (const record of state.authorizations) {
      if (!previous.records.has(record.authorization_id) && record.status === "valid") {
        toast.success(t("mcpAuthorizations.new_authorization", { name: record.client_name }));
      }
    }
  }, [query.data, subject, t]);

  const act = useMutation({
    mutationFn: async ({ action, item }: { action: AuthorizationAction; item: McpAuthorization }) => {
      const csrf = query.data?.csrf ?? "";
      const verb = action === "revoke" && query.data?.supportsReset ? "unbind" : action;
      await consoleAction("authorization-" + verb, csrf, { authorization_id: item.authorization_id });
    },
    onSuccess: (_data, variables) => {
      const message = { revoke: "revoked_ok", reset: "reset_ok", delete: "deleted_ok" } as const;
      toast.success(t(`mcpAuthorizations.${message[variables.action]}`));
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ["mcp", "authorizations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const state = query.data;
  const confirmation = pending?.subject === subject ? pending : null;
  const action = confirmation?.action ?? "revoke";
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
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="outline" className="text-2xs">{item.source.toUpperCase()}</Badge>
              <Badge variant={STATUS_VARIANT[item.status]} className="text-2xs">
                {t(`mcpAuthorizations.status_${item.status}`)}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
            <span>{item.scopes.join("、")}</span>
            <span>{t("mcpAuthorizations.authorized_at")}: {formatTime(item.authorized_at)}</span>
            <span>{t("mcpAuthorizations.expires_at")}: {formatTime(item.expires_at)}</span>
          </div>
          <div className="flex justify-end gap-2">
            {item.status === "valid" && state?.supportsReset && (
              <Button size="sm" variant="outline" disabled={act.isPending}
                onClick={() => setPending({ action: "reset", item, subject })}>
                {t("mcpAuthorizations.reset")}
              </Button>
            )}
            {(item.status === "valid" || item.status === "reset_required") && (
              <Button size="sm" variant="outline" disabled={act.isPending}
                onClick={() => setPending({ action: "revoke", item, subject })}>
                {t("mcpAuthorizations.revoke")}
              </Button>
            )}
            {item.status !== "valid" && (
              <Button size="sm" variant="ghost" disabled={act.isPending}
                onClick={() => setPending({ action: "delete", item, subject })}>
                {t("mcpAuthorizations.delete")}
              </Button>
            )}
          </div>
        </div>
      ))}

      <Dialog open={confirmation !== null} onOpenChange={(open) => !open && !act.isPending && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t(`mcpAuthorizations.${action}_title`)}</DialogTitle>
            <DialogDescription>
              {confirmation?.item.client_name}
              {t(`mcpAuthorizations.${action}_body`)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => setPending(null)}>
              {t("mcpAuthorizations.cancel")}
            </Button>
            <Button size="sm" variant="destructive" disabled={act.isPending}
              onClick={() => confirmation && act.mutate(confirmation)}>
              {t(`mcpAuthorizations.confirm_${action}`)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
