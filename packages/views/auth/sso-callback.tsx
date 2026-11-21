"use client";

import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { completeWebSsoLogin } from "@lynse/core/auth/lynse-sso";
import { useNavigation } from "../navigation";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { consumePostLoginRedirect } from "./post-login-redirect";
import { Loader2 } from "../icons";

type CallbackStatus = "exchanging" | "success" | "denied" | "failed";

/**
 * Landing page for the account-center SSO redirect (`<web>/auth/sso?code=…&state=…`).
 *
 * `beginWebSsoLogin` parked the PKCE verifier + state in sessionStorage before
 * the redirect; completeWebSsoLogin verifies the state, exchanges the code at
 * the account center's /oauth/token and hands back the session (the business
 * token rides along as `upstream_token`). Shared view — the web app mounts it
 * from a thin route page. (Desktop completes inside the embedded window and
 * never navigates here.)
 */
export function SsoCallback() {
  const { replace } = useNavigation();
  const { t } = useTranslation();
  const completeLogin = useAuthStore((s) => s.completeLogin);
  const [status, setStatus] = useState<CallbackStatus>("exchanging");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Mount replays (StrictMode) must not fire the exchange twice — an OAuth
  // code is single-use (idempotent replay only within its 120s lifetime).
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    if (params.get("error")) {
      setStatus("denied");
      return;
    }

    let cancelled = false;
    completeWebSsoLogin(params.get("code"), params.get("state"))
      .then((session) => {
        if (cancelled) return;
        completeLogin(session);
        setStatus("success");
        const redirect = consumePostLoginRedirect();
        // Let the success state paint before leaving; replace() keeps the
        // one-time code out of the URL history.
        setTimeout(() => replace(redirect ?? "/"), 800);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof Error && /denied/i.test(err.message)) {
          setStatus("denied");
          return;
        }
        setErrorDetail(err instanceof Error ? err.message : null);
        setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-8 text-center shadow-sm">
        <div className="flex justify-center">
          {status === "success" ? (
            <span className="flex size-10 items-center justify-center rounded-full bg-success/10 text-lg text-success">
              ✓
            </span>
          ) : status === "exchanging" ? (
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          ) : (
            <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-lg text-destructive">
              !
            </span>
          )}
        </div>

        <div className="space-y-1">
          <h1 className="text-sm font-medium">
            {status === "success"
              ? t("wechat.callback_success")
              : status === "denied"
                ? t("wechat.callback_denied")
                : status === "failed"
                  ? t("wechat.callback_failed")
                  : t("wechat.callback_exchanging")}
          </h1>
          {errorDetail && (
            <p className="break-all text-2xs text-muted-foreground">{errorDetail}</p>
          )}
        </div>

        {status !== "exchanging" && status !== "success" && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => replace("/")}
          >
            {t("wechat.callback_back")}
          </Button>
        )}
      </div>
    </main>
  );
}
