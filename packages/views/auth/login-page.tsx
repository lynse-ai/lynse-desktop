"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useAuthStore } from "@lynse/core/auth";
import {
  sendSmsCode,
  type SmsCodeResult,
} from "@lynse/core/auth/session";
import { ApiError } from "@lynse/core/api/client";
import { pollWechatSession } from "@lynse/core/auth/wechat";
import { useNavigation } from "../navigation";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";
import { getDesktopAppApi, openExternalUrl } from "../app-update";
import { hasPasswordlessAuth } from "../feature-flags";
import { WechatIcon } from "./wechat-icon";

// Mainland China mobile numbers: 11 digits starting with 1.
const PHONE_PATTERN = /^1\d{10}$/;
const SMS_COUNTDOWN_SECONDS = 60;

/**
 * Backend error codes (the `msg` of the `{ code, msg }` envelope) mapped to
 * i18n keys, per the auth API contract. Unknown codes are shown verbatim.
 */
const AUTH_ERROR_KEYS: Record<string, string> = {
  "error.phone.format.invalid": "auth.error_phone_invalid",
  "error.email.format.invalid": "auth.error_email_invalid",
  "error.sms.send.failed": "auth.error_send_failed",
  "error.email.send.failed": "auth.error_email_send_failed",
  "error.sms.service.not.configured": "auth.error_sms_unavailable",
  "error.email.service.not.configured": "auth.error_email_unavailable",
  "error.operation.too.frequent": "auth.error_send_too_frequent",
  "error.captcha.expired": "auth.error_captcha_expired",
  "error.captcha.incorrect": "auth.error_captcha_incorrect",
  "error.captcha.incorrect.input": "auth.error_captcha_incorrect",
  "error.captcha.too.many.attempts": "auth.error_captcha_too_many_attempts",
};

/**
 * Startup login page, shown by the AuthGate before any session exists.
 *
 * The layout is identical on both build channels; the card content differs:
 *  - "testflight": phone + SMS verification code, divider, WeChat QR sign-in.
 *  - "github": API-key connect form only.
 *
 * A small bottom-left link opens the API configuration page on both channels.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const passwordless = hasPasswordlessAuth();
  const isDesktop = !!getDesktopAppApi();

  // API-key channel (github build)
  const login = useAuthStore((s) => s.login);
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);

  // Phone + SMS channel (testflight build)
  const loginWithSms = useAuthStore((s) => s.loginWithSms);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  // WeChat channel (testflight build). On desktop the QR page opens in the
  // system browser and we poll the backend for the session it publishes.
  const startWechatLogin = useAuthStore((s) => s.startWechatLogin);
  const completeLogin = useAuthStore((s) => s.completeLogin);
  const [wechatWaiting, setWechatWaiting] = useState(false);
  const wechatCancelledRef = useRef(false);

  const [error, setError] = useState<string | null>(null);
  const phoneValid = PHONE_PATTERN.test(phone.trim());

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(
      () => setCountdown((n) => Math.max(0, n - 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, [countdown]);

  /**
   * Map a failed auth request to a user-facing message: known backend error
   * codes resolve to their localized text; anything else (network errors,
   * unmapped codes) is shown as-is or via the handler's fallback.
   */
  function describeAuthError(e: unknown, fallbackKey: string): string {
    const msg = e instanceof Error ? e.message : "";
    const key = AUTH_ERROR_KEYS[msg];
    if (key) return t(key);
    return msg || t(fallbackKey);
  }

  async function handleApiKeyLogin() {
    if (!apiKey.trim()) return;
    setError(null);
    setConnecting(true);
    try {
      await login(apiKey.trim());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("auth.api_key_connect_failed"));
    } finally {
      setConnecting(false);
    }
  }

  async function handleSendCode() {
    if (!phoneValid || sendingCode || countdown > 0) return;
    setError(null);
    setSendingCode(true);
    try {
      const res = await sendSmsCode({ phone: phone.trim(), actionType: "LOGIN" });
      if (res.success) {
        setCountdown(res.cooldown > 0 ? res.cooldown : SMS_COUNTDOWN_SECONDS);
      } else {
        // 200 but the SMS gateway did not accept the message.
        setError(t("auth.error_send_failed"));
      }
    } catch (e: unknown) {
      // A rate-limited send answers error.operation.too.frequent with the
      // remaining seconds in the envelope data — mirror it in the countdown.
      const cooldown =
        e instanceof ApiError && e.data && typeof e.data === "object"
          ? Number((e.data as Partial<SmsCodeResult>).cooldown) || 0
          : 0;
      if (cooldown > 0) setCountdown(cooldown);
      setError(describeAuthError(e, "auth.sms_send_failed"));
    } finally {
      setSendingCode(false);
    }
  }

  async function handleSmsLogin() {
    if (!phoneValid || !code.trim() || signingIn) return;
    setError(null);
    setSigningIn(true);
    try {
      await loginWithSms(phone.trim(), code.trim());
    } catch (e: unknown) {
      setError(describeAuthError(e, "auth.login_failed"));
    } finally {
      setSigningIn(false);
    }
  }

  async function handleWechatLogin() {
    setError(null);
    const { authorizeUrl, state } = startWechatLogin();
    if (isDesktop) {
      // WeChat only redirects back to the registered web domain, so the QR
      // page opens in the system browser; the web callback publishes the
      // session under the same `state` for us to poll.
      wechatCancelledRef.current = false;
      setWechatWaiting(true);
      openExternalUrl(authorizeUrl);
      try {
        const result = await pollWechatSession(state, {
          isCancelled: () => wechatCancelledRef.current,
        });
        completeLogin(result);
      } catch (e: unknown) {
        if (!wechatCancelledRef.current) {
          setError(e instanceof Error && e.message ? e.message : t("auth.login_failed"));
        }
      } finally {
        setWechatWaiting(false);
      }
    } else {
      // Web: leave for the WeChat QR page; it redirects back to /auth/wechat.
      window.location.assign(authorizeUrl);
    }
  }

  function handleCancelWechatLogin() {
    wechatCancelledRef.current = true;
    setWechatWaiting(false);
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-lg font-semibold text-primary">
            L
          </div>
          <h1 className="text-lg font-semibold tracking-tight">
            {t("auth.login_title")}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("auth.login_subtitle")}
          </p>
        </div>

        <Card>
          <CardContent className="space-y-3 p-5">
            {passwordless ? (
              <>
                {/* ── Phone + SMS verification code ────────── */}
                <div className="space-y-1.5">
                  <Label htmlFor="login-phone" className="text-xs">
                    {t("auth.phone")}
                  </Label>
                  <Input
                    id="login-phone"
                    inputMode="numeric"
                    maxLength={11}
                    placeholder={t("auth.phone_placeholder")}
                    value={phone}
                    onChange={(e) =>
                      setPhone(e.target.value.replace(/\D/g, ""))
                    }
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="login-code" className="text-xs">
                    {t("auth.sms_code")}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="login-code"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder={t("auth.code_placeholder")}
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, ""))
                      }
                      className="h-9 min-w-0 flex-1 text-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0 text-xs"
                      onClick={handleSendCode}
                      disabled={!phoneValid || sendingCode || countdown > 0}
                    >
                      {countdown > 0
                        ? t("auth.resend_in", { n: countdown })
                        : sendingCode
                          ? t("auth.sending_code")
                          : t("auth.send_code")}
                    </Button>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="h-9 w-full text-xs"
                  onClick={handleSmsLogin}
                  disabled={!phoneValid || !code.trim() || signingIn}
                >
                  {signingIn ? t("auth.logging_in") : t("auth.login_button")}
                </Button>

                <div className="flex items-center gap-2 py-0.5">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-2xs text-muted-foreground">
                    {t("auth.wechat_login_or")}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>

                {/* ── WeChat QR sign-in ────────────────────── */}
                {wechatWaiting ? (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      {t("auth.wechat_waiting_scan")}
                    </p>
                    <p className="text-2xs leading-relaxed text-muted-foreground">
                      {t("auth.wechat_waiting_hint")}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={handleCancelWechatLogin}
                    >
                      {t("auth.wechat_cancel")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 w-full gap-1.5 text-xs"
                    onClick={handleWechatLogin}
                  >
                    <WechatIcon className="size-4" />
                    {t("auth.wechat_login")}
                  </Button>
                )}
              </>
            ) : (
              <>
                {/* ── API-key channel (github build) ───────── */}
                <div className="space-y-1.5">
                  <Label htmlFor="login-api-key" className="text-xs">
                    {t("auth.api_config_key")}
                  </Label>
                  <Input
                    id="login-api-key"
                    type="password"
                    placeholder="dk-..."
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="h-9 text-sm"
                  />
                </div>
                <Button
                  size="sm"
                  className="h-9 w-full text-xs"
                  onClick={handleApiKeyLogin}
                  disabled={!apiKey.trim() || connecting}
                >
                  {connecting ? t("auth.api_key_connecting") : t("auth.api_key_connect")}
                </Button>
              </>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </CardContent>
        </Card>
      </div>

      <button
        type="button"
        onClick={() => push("/api-config")}
        className="absolute bottom-4 left-4 text-2xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {t("auth.api_config_link")}
      </button>
    </main>
  );
}
