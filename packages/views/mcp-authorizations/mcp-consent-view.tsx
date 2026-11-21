"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button, buttonVariants } from "@lynse/ui/components/ui/button";
import { cn } from "@lynse/ui/lib/utils";
import { AppleFragmentBootstrap, LoginPage, PostLoginRedirectMarker } from "../auth";
import { Check } from "../icons";
import { AuthorizationAccount, AuthorizationCard, AuthorizationFrame } from "./authorization-layout";
import { completeMcpConsent, fetchMcpConsent, fetchMcpConsentAccount } from "./mcp-bridge";

export function McpConsentView({ ticket, logoSrc }: { ticket: string | null; logoSrc: string }) {
  const { t } = useTranslation();
  const context = useQuery({
    queryKey: ["mcp-consent", ticket],
    queryFn: ticket ? () => fetchMcpConsent(ticket) : undefined,
    enabled: !!ticket,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });

  return (
    <>
      <AppleFragmentBootstrap />
      {ticket && context.data ? (
        <McpConsent key={ticket} ticket={ticket} context={context.data} logoSrc={logoSrc} />
      ) : (
        <AuthorizationFrame logoSrc={logoSrc}>
          <AuthorizationCard title={t("mcpAuthorizations.consent_title")}>
            {!ticket || context.isError ? (
              <p role="alert" className="text-center text-sm text-destructive">
                {context.error?.message ?? t("mcpAuthorizations.consent_invalid")}
              </p>
            ) : (
              <p role="status" className="text-center text-sm text-muted-foreground">
                {t("mcpAuthorizations.device_loading_account")}
              </p>
            )}
          </AuthorizationCard>
        </AuthorizationFrame>
      )}
    </>
  );
}

function McpConsent({ ticket, context, logoSrc }: {
  ticket: string;
  context: Awaited<ReturnType<typeof fetchMcpConsent>>;
  logoSrc: string;
}) {
  const { t } = useTranslation();
  const isLoading = useAuthStore((state) => state.isLoading);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const logout = useAuthStore((state) => state.logout);
  const userId = useAuthStore((state) => state.user?.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ callback: string; decision: "allow" | "deny" } | null>(null);
  const handoffStarted = useRef(false);
  const { csrf, clientName, scopes } = context;
  const account = useQuery({
    queryKey: ["mcp-consent-account", ticket, userId],
    enabled: isAuthenticated,
    queryFn: () => {
      const token = api().getToken();
      if (!token) throw new Error(t("mcpAuthorizations.not_logged_in"));
      return fetchMcpConsentAccount(ticket, csrf, token);
    },
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!handoff) return;
    const timer = window.setTimeout(() => {
      if (handoffStarted.current) return;
      handoffStarted.current = true;
      window.location.assign(handoff.callback);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [handoff]);

  async function decide(decision: "allow" | "deny") {
    setPending(true);
    setError(null);
    try {
      if (decision === "deny") {
        setHandoff({ decision, callback: await completeMcpConsent(ticket, csrf, { decision }) });
        return;
      }
      const token = api().getToken();
      if (!token || !account.data) throw new Error(t("mcpAuthorizations.not_logged_in"));
      const callback = await completeMcpConsent(ticket, csrf, { decision, token, subject: account.data.subject });
      setHandoff({ callback, decision });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t("mcpAuthorizations.load_failed"));
    } finally {
      setPending(false);
    }
  }

  function switchAccount() {
    setError(null);
    logout();
  }

  const errorMessage = error && <p role="alert" className="text-sm text-destructive">{error}</p>;

  if (handoff) {
    return (
      <AuthorizationFrame logoSrc={logoSrc}>
        <AuthorizationCard title={t(handoff.decision === "allow"
          ? "mcpAuthorizations.consent_success" : "mcpAuthorizations.device_denied_title")}>
          <a
            className={cn(buttonVariants(), "h-auto min-h-9 w-full whitespace-normal py-2 text-center")}
            href={handoff.callback}
            onClick={(event) => {
              if (handoffStarted.current) event.preventDefault();
              else handoffStarted.current = true;
            }}
          >
            {t("mcpAuthorizations.consent_return", { name: clientName })}
          </a>
        </AuthorizationCard>
      </AuthorizationFrame>
    );
  }

  if (!isLoading && !isAuthenticated) {
    return (
      <>
        <PostLoginRedirectMarker />
        <LoginPage subtitle={t("mcpAuthorizations.consent_login_subtitle", { name: clientName })} footer={
          <>
            {errorMessage}
            <Button variant="ghost" disabled={pending} onClick={() => void decide("deny")}>
              {t("mcpAuthorizations.cancel")}
            </Button>
          </>
        } />
      </>
    );
  }

  return (
    <AuthorizationFrame logoSrc={logoSrc}>
      <AuthorizationCard title={t("mcpAuthorizations.device_consent_title", { name: clientName })}>
        {account.data ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border bg-muted/25 p-3">
            <AuthorizationAccount account={account.data} />
            <Button variant="ghost" size="sm" disabled={pending} onClick={switchAccount}>
              {t("mcpAuthorizations.device_switch_account")}
            </Button>
          </div>
        ) : account.isError ? (
          <>
            <p role="alert" className="text-sm text-destructive">{account.error.message}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={switchAccount}>{t("mcpAuthorizations.device_switch_account")}</Button>
              <Button onClick={() => void account.refetch()}>{t("mcpAuthorizations.device_retry")}</Button>
            </div>
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">{t("mcpAuthorizations.device_loading_account")}</p>
        )}
        <section className="rounded-2xl border p-4">
          <h2 className="text-sm font-medium">{t("mcpAuthorizations.device_permissions")}</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {scopes.map((scope) => (
              <li key={scope} className="flex items-center gap-2">
                <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
                {t(scope === "lynse:read" ? "mcpAuthorizations.device_scope_read" : "mcpAuthorizations.device_scope_write")}
              </li>
            ))}
          </ul>
        </section>
        {errorMessage}
        <div className="grid grid-cols-2 gap-2" aria-busy={pending}>
          <Button variant="outline" disabled={pending} onClick={() => void decide("deny")}>
            {t("mcpAuthorizations.cancel")}
          </Button>
          <Button disabled={pending || account.isFetching || !account.data} onClick={() => void decide("allow")}>
            {t("mcpAuthorizations.device_allow")}
          </Button>
        </div>
      </AuthorizationCard>
    </AuthorizationFrame>
  );
}
