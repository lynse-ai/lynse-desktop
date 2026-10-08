"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, cancelConnectorRequest, getConnectorRequest, normalizeConnectionRequest, resumeConnectorRequest, type ConnectorConnectionRequest, type ConnectorRequestResult } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Calendar, Check, FileText, Loader2 } from "../icons";
import { useChatStore } from "../workspace/hooks/use-chat-store";

/** Only continue the conversation containing this card, preserving its file context. */
export function continueConnection(messageId: string, prompt: string): boolean {
  const store = useChatStore.getState();
  if (store.isLoading) return false;
  const conversation = store.conversations.find((entry) => entry.messages.some((message) => message.id === messageId));
  if (!conversation || conversation.id !== store.activeConversationId) return false;
  const index = conversation.messages.findIndex((message) => message.id === messageId);
  const question = conversation.messages.slice(0, index).findLast((message) => message.role === "user");
  store.sendMessage(`${prompt}\n${question?.content ?? ""}`, question?.fileIds, Boolean(question?.fileIds?.length));
  return true;
}

export function ChatConnectionCards({ requests, messageId }: { requests?: ConnectorConnectionRequest[]; messageId: string }) {
  const { t } = useTranslation();
  const isLoading = useChatStore((store) => store.isLoading);
  if (!requests?.length) return null;
  return <div className="mt-3 flex flex-col items-start gap-2">
    {requests.map(normalizeConnectionRequest).filter((request) => request !== null).map((request) => (
      <ChatConnectionCard key={request.request_id || request.provider} request={request} disabled={isLoading}
        onContinue={(accountId) => continueConnection(messageId, t(accountId ? "chat.connection.account_reply" : "chat.connection.continue_reply", {
          provider: request.provider_display_name, account: accountId,
        }))} />
    ))}
  </div>;
}

export function ChatConnectionCard({ request, onContinue, disabled = false }: {
  request: ConnectorConnectionRequest;
  onContinue?: (accountId?: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const authenticated = useAuthStore((store) => store.isAuthenticated);
  const token = authenticated ? api().getToken() : null;
  // Session keys never contain credentials and change on account/token switches.
  const session = useMemo(() => token ? crypto.randomUUID() : "signed-out", [token]);
  const queryKey = useMemo(() => ["connector-request", session, request.request_id], [session, request.request_id]);
  const client = useQueryClient();
  const [authorizationSession, setAuthorizationSession] = useState<string | null>(null);
  const authorizing = authorizationSession === session;
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getConnectorRequest(request.request_id, token!, signal),
    enabled: !!token && !!request.request_id,
    staleTime: 0,
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: () => cancelConnectorRequest(request.request_id, token!),
    onSuccess: (result) => client.setQueryData(queryKey, result),
    onError: () => setError("chat.connection.check_failed"),
  });

  useEffect(() => {
    if (!authorizing || !token) return;
    const abort = new AbortController();
    controller.current = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let attempt = 0;
    const check = async () => {
      if (running || abort.signal.aborted) return;
      if (timer) clearTimeout(timer);
      running = true;
      try {
        const result = await resumeConnectorRequest(request.request_id, token, abort.signal);
        // A focus-triggered GET may still carry an older waiting snapshot.
        await client.cancelQueries({ queryKey, exact: true });
        if (abort.signal.aborted) return;
        client.setQueryData<ConnectorRequestResult>(queryKey, (previous) => ({ ...previous, ...result }));
        if (["waiting_auth", "ready", "resuming"].includes(result.status)) {
          timer = setTimeout(() => void check(), Math.min(4_000 * 2 ** attempt++, 20_000));
        } else {
          if (["rate_limited", "unavailable", "identity_required"].includes(result.status)) {
            setError(`chat.connection.${result.status}`);
          }
          setAuthorizationSession(null);
        }
      } catch {
        if (!abort.signal.aborted) {
          setError("chat.connection.check_failed");
          setAuthorizationSession(null);
        }
      } finally { running = false; }
    };
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [authorizing, token, request.request_id, client, queryKey]);

  const status = query.data?.status ?? request.status;
  const expiry = query.data?.auth_expires_at ?? request.expires_at;
  const expired = status === "expired" || (!!expiry && Date.parse(expiry) <= Date.now());
  const done = query.data?.status === "done";
  const terminal = expired || ["cancelled", "error", "reauthorization_required", "permission_denied", "invalid_input"].includes(status);
  const readStatus = query.data?.read_status ?? query.data?.status_detail ?? status;
  const failureKey = readStatus === "permission_denied" ? "permission_denied"
    : readStatus === "reauthorization_required" ? "reauthorization_required" : "failed";
  const unavailable = !token || (!!request.request_id && (query.isPending || query.isError));
  const authorize = async () => {
    if (unavailable || terminal || !request.action_url) return;
    setError(null);
    try {
      const url = normalizeConnectionRequest(request)?.action_url;
      if (!url) throw new Error("Invalid authorization entry");
      const desktop = (window as Window & { desktopAPI?: { openExternal?: (url: string) => Promise<void> } }).desktopAPI;
      if (desktop?.openExternal) await desktop.openExternal(url);
      else window.open(url, "_blank", "noopener,noreferrer");
      if (api().getToken() === token) setAuthorizationSession(session);
    } catch { setError("chat.connection.open_failed"); }
  };
  const identity = query.data?.result?.account;
  const accounts = query.data?.accounts
    ? normalizeConnectionRequest({ ...request, status, accounts: query.data.accounts })?.accounts
    : request.accounts;
  const Icon = request.provider.includes("calendar") ? Calendar : FileText;

  return <section aria-label={request.provider_display_name} className="w-full max-w-xs rounded-2xl border border-border bg-card p-3 text-sm shadow-sm">
    <div className="flex items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
        <Icon className="size-5 text-foreground" />
      </div>
      <div className="min-w-0">
        <p className="font-medium">{request.provider_display_name}</p>
        <p className="text-xs text-muted-foreground">{t("chat.connection.connector")}</p>
      </div>
      {done && <Check className="ml-auto size-4 text-success" />}
    </div>
    {request.reason && <p className="mt-2 text-xs leading-5 text-muted-foreground">{request.reason}</p>}
    {done ? <>
      <p className="mt-2 text-xs text-success">{t("connections.connected")}{identity?.display_name || identity?.email ? ` · ${identity.display_name || identity.email}` : ""}</p>
      {onContinue && <Button className="mt-3 w-full rounded-full" variant="secondary" size="sm" disabled={disabled} onClick={() => onContinue()}>{t("chat.connection.continue")}</Button>}
    </> : status === "account_selection_required" ? <div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">{t("chat.connection.choose_account")}</p>
      {accounts?.map((account) => <Button key={account.id} className="w-full justify-start" variant="secondary" size="sm" disabled={disabled || !token} onClick={() => onContinue?.(account.id)}>{account.display_name || account.email || account.id}</Button>)}
    </div> : terminal ? <p className="mt-3 text-xs text-muted-foreground">{t(`chat.connection.${expired ? "expired" : status === "cancelled" ? "cancelled" : failureKey}`)}</p> : <>
      <Button className="mt-3 w-full rounded-full" variant="secondary" size="sm" disabled={!token || query.isPending || cancel.isPending || !request.action_url} onClick={() => {
        if (query.isError) void query.refetch();
        else if (error && error !== "chat.connection.open_failed") {
          setError(null);
          setAuthorizationSession(session);
        } else void authorize();
      }}>
        {authorizing && <Loader2 className="size-3.5 animate-spin" />}
        {t(authorizing ? "chat.connection.waiting" : error || query.isError ? "connections.retry" : "connections.connect")}
      </Button>
      {authorizing && <Button className="mt-1 w-full" size="sm" variant="ghost" onClick={() => {
        controller.current?.abort();
        setAuthorizationSession(null);
        cancel.mutate();
      }}>{t("chat.connection.cancel")}</Button>}
    </>}
    {(error || query.isError) && <p role="alert" className="mt-2 text-xs text-destructive">{t(error || "chat.connection.check_failed")}</p>}
  </section>;
}
