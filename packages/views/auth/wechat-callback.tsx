"use client";

import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@lynse/core/auth";
import { exchangeWechatCode } from "@lynse/core/auth/wechat";
import { useNavigation } from "../navigation";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Loader2 } from "../icons";

type CallbackStatus = "exchanging" | "success" | "denied" | "invalid_state" | "failed";

// sessionStorage key written by the auth store before redirecting to WeChat.
const STATE_STORAGE_KEY = "lynse_wechat_state";

/**
 * Landing page for the WeChat OAuth redirect (`<web>/auth/wechat?code=…&state=…`).
 *
 * Exchanges the one-time `code` for a Lynse session and completes the login on
 * this client. The `state` is forwarded so the backend can also publish the
 * session to a desktop app that is polling with the same value. Web shells
 * mount this from a thin route page; it deliberately avoids framework router
 * APIs so it stays a shared view.
 */
export function WechatCallback() {
  const { replace } = useNavigation();
  const { t } = useTranslation();
  const completeLogin = useAuthStore((s) => s.completeLogin);
  const [status, setStatus] = useState<CallbackStatus>("exchanging");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Mount replays (StrictMode) must not fire the exchange twice — a WeChat
  // code is single-use and the second attempt would fail.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state") ?? undefined;

    if (params.get("error")) {
      setStatus("denied");
      return;
    }

    // Forged-redirect guard: the `state` must match what we generated before
    // navigating away. A missing stored value means the scan was opened from
    // another client (the desktop app); the backend validates those via its
    // own state binding.
    const expectedState = window.sessionStorage.getItem(STATE_STORAGE_KEY);
    if (expectedState && expectedState !== state) {
      setStatus("invalid_state");
      return;
    }

    if (!code) {
      setStatus("denied");
      return;
    }

    let cancelled = false;
    exchangeWechatCode(code, state)
      .then((result) => {
        if (cancelled) return;
        window.sessionStorage.removeItem(STATE_STORAGE_KEY);
        completeLogin(result);
        setStatus("success");
        // Let the success state paint before leaving; replace() keeps the
        // one-time code out of the URL history.
        setTimeout(() => replace("/"), 800);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
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
                : status === "invalid_state"
                  ? t("wechat.callback_invalid_state")
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
