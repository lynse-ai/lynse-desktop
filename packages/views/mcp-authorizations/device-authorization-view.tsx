"use client";

import { useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useAuthStore } from "@lynse/core/auth";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent } from "@lynse/ui/components/ui/card";
import { Checkbox } from "@lynse/ui/components/ui/checkbox";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@lynse/ui/components/ui/input-otp";
import { AppleFragmentBootstrap, LoginPage, PostLoginRedirectMarker } from "../auth";
import { ArrowRight, Check, ShieldCheck, Terminal } from "../icons";
import { AuthorizationAccount, AuthorizationCard, AuthorizationFrame } from "./authorization-layout";
import { completeDeviceRequest, fetchConsoleState, fetchDeviceAccount, reviewDeviceRequest } from "./mcp-bridge";

type CodeLength = 6 | 8;
type DeviceAccount = Awaited<ReturnType<typeof fetchDeviceAccount>>;
type DeviceRequest = Awaited<ReturnType<typeof reviewDeviceRequest>>;
type DeviceStep =
  | { kind: "account" }
  | { kind: "code" }
  | { kind: "review"; request: DeviceRequest }
  | { kind: "allowed" }
  | { kind: "denied" };

export function DeviceAuthorizationView({ codeLength, logoSrc }: { codeLength: CodeLength; logoSrc: string }) {
  const { t } = useTranslation();
  const loading = useAuthStore((state) => state.isLoading);
  const signedIn = useAuthStore((state) => state.isAuthenticated);

  return (
    <>
      <AppleFragmentBootstrap />
      {loading ? (
        <AuthorizationFrame logoSrc={logoSrc}>
          <p role="status" className="text-center text-sm text-muted-foreground">{t("mcpAuthorizations.device_loading_account")}</p>
        </AuthorizationFrame>
      ) : signedIn ? (
        <AuthorizationFrame logoSrc={logoSrc}>
          <SignedInDeviceAuthorization codeLength={codeLength} />
        </AuthorizationFrame>
      ) : (
        <>
          <PostLoginRedirectMarker />
          <LoginPage subtitle={t("mcpAuthorizations.device_login_subtitle")} />
        </>
      )}
    </>
  );
}

function SignedInDeviceAuthorization({ codeLength }: { codeLength: CodeLength }) {
  const { t } = useTranslation();
  const currentAccount = useAuthStore((state) => state.user?.id ?? "");
  const switchAccount = useAuthStore((state) => state.logout);
  const profile = useQuery({
    queryKey: ["mcp", "device-account", currentAccount],
    queryFn: async () => {
      const { csrf, supportsDeviceAuthorization } = await fetchConsoleState();
      const token = api().getToken();
      if (!token) throw new Error(t("mcpAuthorizations.not_logged_in"));
      if (!supportsDeviceAuthorization) throw new Error(t("mcpAuthorizations.load_failed"));
      return { csrf, account: await fetchDeviceAccount(csrf, token) };
    },
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (profile.data) {
    const { csrf, account } = profile.data;
    return <DeviceSteps key={account.subject} account={account} csrf={csrf}
      codeLength={codeLength} switchAccount={switchAccount} />;
  }

  return (
    <AuthorizationCard title={t("mcpAuthorizations.device_activation_title")}>
      {profile.isError ? (
        <>
          <p role="alert" className="text-sm text-destructive">{profile.error.message}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={switchAccount}>{t("mcpAuthorizations.device_switch_account")}</Button>
            <Button onClick={() => void profile.refetch()}>{t("mcpAuthorizations.device_retry")}</Button>
          </div>
        </>
      ) : (
        <p role="status" className="text-center text-sm text-muted-foreground">{t("mcpAuthorizations.device_loading_account")}</p>
      )}
    </AuthorizationCard>
  );
}

function normalizeCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function CodeSlots({ code, codeLength, setCode, inputId, busy }: {
  code: string;
  codeLength: CodeLength;
  setCode: (code: string) => void;
  inputId: string;
  busy: boolean;
}) {
  const middle = codeLength / 2;
  return (
    <InputOTP id={inputId} autoFocus autoComplete="off" autoCapitalize="characters" inputMode="text"
      maxLength={codeLength} pattern="[A-Za-z0-9]*" value={code}
      onChange={(value) => setCode(normalizeCode(value))} pasteTransformer={normalizeCode}
      disabled={busy} containerClassName="mx-auto w-full justify-center gap-1 sm:gap-2">
      <InputOTPGroup className="min-w-0 flex-1 justify-center gap-1 sm:gap-2">
        {Array.from({ length: middle }, (_, index) => <CodeSlot key={index} index={index} />)}
      </InputOTPGroup>
      <InputOTPSeparator aria-hidden="true" className="shrink-0 text-muted-foreground" />
      <InputOTPGroup className="min-w-0 flex-1 justify-center gap-1 sm:gap-2">
        {Array.from({ length: middle }, (_, index) => <CodeSlot key={index} index={middle + index} />)}
      </InputOTPGroup>
    </InputOTP>
  );
}

function CodeSlot({ index }: { index: number }) {
  return <InputOTPSlot index={index}
    className="h-12 min-w-0 flex-1 rounded-xl border bg-muted/25 font-mono text-lg font-semibold sm:h-14" />;
}

function DeviceSteps({ account, csrf, codeLength, switchAccount }: {
  account: DeviceAccount;
  csrf: string;
  codeLength: CodeLength;
  switchAccount: () => void;
}) {
  const { t, i18n } = useTranslation();
  const inputId = useId();
  const writeLabelId = useId();
  const [step, setStep] = useState<DeviceStep>({ kind: "account" });
  const [code, setCode] = useState("");
  const [allowWrite, setAllowWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || code.length !== codeLength) return;
    setBusy(true);
    setError(null);
    try {
      const token = api().getToken();
      if (!token) throw new Error(t("mcpAuthorizations.not_logged_in"));
      const request = await reviewDeviceRequest({ csrf, code, token, subject: account.subject });
      setAllowWrite(false);
      setStep({ kind: "review", request });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t("mcpAuthorizations.load_failed"));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "allow" | "deny") {
    if (step.kind !== "review" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = api().getToken();
      if (!token) throw new Error(t("mcpAuthorizations.not_logged_in"));
      await completeDeviceRequest({
        csrf, ticket: step.request.ticket, token, decision,
        allowWrite: decision === "allow" && step.request.writeOptional && allowWrite,
      });
      setCode("");
      setStep({ kind: decision === "allow" ? "allowed" : "denied" });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t("mcpAuthorizations.load_failed"));
    } finally {
      setBusy(false);
    }
  }

  const errorMessage = error && <p role="alert" className="text-sm text-destructive">{error}</p>;

  if (step.kind === "account") {
    return (
      <AuthorizationCard title={t("mcpAuthorizations.device_activation_title")}>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/15 bg-primary/5 p-3 sm:p-4">
          <AuthorizationAccount account={account} />
          <Button className="ml-auto shrink-0 rounded-xl" onClick={() => setStep({ kind: "code" })}>
            {t("mcpAuthorizations.device_continue")}<ArrowRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <Button variant="outline" className="h-10 w-full rounded-xl" onClick={switchAccount}>
          {t("mcpAuthorizations.device_switch_account")}
        </Button>
      </AuthorizationCard>
    );
  }

  if (step.kind === "code") {
    return (
      <AuthorizationCard title={t("mcpAuthorizations.device_code_title")}
        description={t("mcpAuthorizations.device_hint", { length: codeLength })}>
        <div className="flex justify-center"><AuthorizationAccount account={account} /></div>
        <form onSubmit={review} className="space-y-3" aria-busy={busy}>
          <label htmlFor={inputId} className="block text-sm font-medium">{t("mcpAuthorizations.device_code")}</label>
          <CodeSlots code={code} setCode={setCode} codeLength={codeLength} inputId={inputId} busy={busy} />
          {errorMessage}
          <Button type="submit" disabled={busy || code.length !== codeLength} className="h-11 w-full rounded-xl">
            {t("mcpAuthorizations.device_continue")}
          </Button>
        </form>
        <p className="text-center text-xs leading-relaxed text-muted-foreground">{t("mcpAuthorizations.device_lifetime")}</p>
        <div className="text-center">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
            setCode("");
            setError(null);
            setStep({ kind: "account" });
          }}>{t("mcpAuthorizations.device_back_to_account")}</Button>
        </div>
      </AuthorizationCard>
    );
  }

  if (step.kind === "review") {
    const { request } = step;
    const requestedAt = new Date(request.requestedAt * 1000);
    const displayTime = requestedAt.toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" });
    return (
      <AuthorizationCard title={t("mcpAuthorizations.device_consent_title", { name: request.clientName })}>
        <div className="flex items-start gap-3 rounded-2xl border border-primary/15 bg-primary/5 p-3 text-sm">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="min-w-0 space-y-1.5">
            <p>{t("mcpAuthorizations.device_trust")}</p>
            <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{t("mcpAuthorizations.device_requested")} <time dateTime={requestedAt.toISOString()}>{displayTime}</time></span>
              {request.requestIp && <span>IP <bdi className="font-medium">{request.requestIp}</bdi></span>}
            </p>
          </div>
        </div>
        <section className="overflow-hidden rounded-2xl border">
          <div className="flex items-center gap-3 border-b p-4">
            <div className="grid size-10 shrink-0 place-content-center rounded-xl bg-muted text-muted-foreground">
              <Terminal aria-hidden="true" className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold">{request.clientName}</p>
              <p className="break-words text-xs text-muted-foreground">{t("mcpAuthorizations.device_access_account", { name: account.name })}</p>
            </div>
          </div>
          <div className="space-y-3 p-4">
            <h2 className="text-sm font-medium">{t("mcpAuthorizations.device_permissions")}</h2>
            <ul className="space-y-2">
              {request.scopes.map((scope) => {
                if (scope === "lynse:write" && request.writeOptional) {
                  return (
                    <li key={scope}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-xl border bg-muted/30 px-3 py-2.5 text-sm">
                        <Checkbox aria-labelledby={writeLabelId} checked={allowWrite} disabled={busy}
                          onCheckedChange={(checked) => setAllowWrite(checked === true)} />
                        <span id={writeLabelId}>{t("mcpAuthorizations.device_scope_write_optional")}</span>
                      </label>
                    </li>
                  );
                }
                return (
                  <li key={scope} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
                    {scope === "lynse:read" ? t("mcpAuthorizations.device_scope_read")
                      : scope === "lynse:write" ? t("mcpAuthorizations.device_scope_write") : scope}
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
        {errorMessage}
        <div className="grid grid-cols-2 gap-2" aria-busy={busy}>
          <Button className="h-11 rounded-xl" variant="outline" disabled={busy} onClick={() => void decide("deny")}>
            {t("mcpAuthorizations.cancel")}
          </Button>
          <Button className="h-11 rounded-xl" disabled={busy} onClick={() => void decide("allow")}>
            {t("mcpAuthorizations.device_allow")}
          </Button>
        </div>
        {error && <Button variant="ghost" disabled={busy} onClick={() => {
          setCode("");
          setError(null);
          setStep({ kind: "code" });
        }}>{t("mcpAuthorizations.device_start_over")}</Button>}
      </AuthorizationCard>
    );
  }

  const allowed = step.kind === "allowed";
  return (
    <Card className="rounded-3xl py-9 text-center shadow-sm">
      <CardContent role="status" className="space-y-3">
        {allowed && (
          <div className="mx-auto mb-5 grid size-14 place-content-center rounded-2xl bg-primary/10 text-primary">
            <Check aria-hidden="true" className="size-7" />
          </div>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">
          {t(allowed ? "mcpAuthorizations.device_success_title" : "mcpAuthorizations.device_denied_title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(allowed ? "mcpAuthorizations.device_allowed" : "mcpAuthorizations.device_denied")}
        </p>
      </CardContent>
    </Card>
  );
}
