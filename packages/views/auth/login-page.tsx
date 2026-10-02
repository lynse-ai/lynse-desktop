"use client";

import { useCallback, useEffect, useRef, useState } from "react";import { QRCodeSVG } from "qrcode.react";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useAuthStore } from "@lynse/core/auth";
import {
  buildQrLoginPayload,
  createQrLogin,
  pollQrLogin,
  QrLoginExpiredError,
} from "@lynse/core/auth/qrcode";
import { pollWechatSession } from "@lynse/core/auth/wechat";
import {
  SMS_CODE_LENGTHS,
  SMS_CODE_MAX_LENGTH,
  SMS_RESEND_DEFAULT_SECONDS,
  cooldownSecondsFromError,
  isCompleteSmsCode,
  isValidChinaPhone,
  loginByPhoneCode,
  sendSmsCaptcha,
  smsSessionFromLogin,
} from "@lynse/core/auth/sms";
import { useTranslation } from "@lynse/core/i18n/react";
import { ArrowRight, ChevronRight, KeyRound, Loader2, QrCode } from "../icons";
import { getDesktopAppApi, openExternalUrl } from "../app-update";
import { hasDevApiAuth, hasPasswordlessAuth } from "../feature-flags";
import { PRIVACY_URL, TERMS_URL } from "../about/links";
import { WechatIcon } from "./wechat-icon";
import { authErrorText } from "./auth-errors";
import { ApiAuthPanel } from "./api-auth-panel";
import { LYNSE_LOGO_SRC } from "./lynse-logo";
import { LOGIN_ARTWORK_SRC } from "./login-artwork";

/** Login QR panel phases. "expired"/"error" offer a manual refresh. */
type QrPhase = "creating" | "ready" | "scanned" | "expired" | "error";

/** Sign-in views: phone + SMS form, the "more ways" screen (WeChat / QR /
 *  dev API entry), the app-scanned QR code, or the API form. */
type LoginView = "phone" | "more" | "qr" | "api";

// A 4-digit code waits this long before auto-submitting, in case the user is
// still typing towards a 6-digit one; 6 digits submit without waiting.
const CODE_AUTO_SUBMIT_DELAY_MS = 600;

/**
 * Startup login page, shown by the AuthGate before any session exists, in
 * the compact welcome window (690×450 — the window shape is AuthGate's
 * job). Qoder-welcome layout: a left column with the wordmark, a welcome
 * heading and the active sign-in form, and a full-height rounded artwork
 * card on the right (LOGIN_ARTWORK_SRC, user-provided).
 *
 * Form content differs by build channel:
 *  - "testflight": phone + SMS code form; a "more ways to sign in" screen
 *    holds WeChat, the app-scanned QR code and — in dev builds — the API
 *    form (server selection + API key, the same UI as /api-config).
 *  - "github": the API form as the main sign-in form.
 *
 * Server / API-key configuration lives inside the API form itself (and the
 * standalone /api-config route); the page keeps no extra link to it.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const passwordless = hasPasswordlessAuth();
  const devApiAuth = hasDevApiAuth();
  const isDesktop = !!getDesktopAppApi();

  // Active sign-in view. Phone is the default: unlike the QR flow it needs no
  // Lynse mobile app, and it also covers registration.
  const [view, setView] = useState<LoginView>("phone");

  // QR channel (testflight build): create a challenge, show its QR, then
  // poll until the Lynse mobile app scans + confirms it.
  const completeLogin = useAuthStore((s) => s.completeLogin);
  const [qrPhase, setQrPhase] = useState<QrPhase>("creating");
  const [qrPayload, setQrPayload] = useState("");
  const qrCancelledRef = useRef(false);

  // Phone + SMS channel (testflight build).
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [codeSending, setCodeSending] = useState(false);
  const [smsSubmitting, setSmsSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);

  // Deferred auto-submit for 4-digit codes (see handleSmsCodeChange).
  const codeSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearPendingCodeSubmit() {
    if (codeSubmitTimerRef.current) {
      clearTimeout(codeSubmitTimerRef.current);
      codeSubmitTimerRef.current = null;
    }
  }

  // WeChat channel (testflight build). On desktop the QR page opens in the
  // system browser and we poll the backend for the session it publishes.
  const startWechatLogin = useAuthStore((s) => s.startWechatLogin);
  const [wechatWaiting, setWechatWaiting] = useState(false);
  const wechatCancelledRef = useRef(false);

  const [error, setError] = useState<string | null>(null);

  const startQrLogin = useCallback(async () => {
    qrCancelledRef.current = false;
    setQrPayload("");
    setQrPhase("creating");
    setError(null);
    try {
      const challenge = await createQrLogin();
      if (qrCancelledRef.current) return;
      setQrPayload(buildQrLoginPayload(challenge));
      setQrPhase("ready");
      const session = await pollQrLogin(challenge.qrId, {
        expiresInSeconds: challenge.expireIn,
        onScanned: () => {
          if (!qrCancelledRef.current) setQrPhase("scanned");
        },
        isCancelled: () => qrCancelledRef.current,
      });
      if (qrCancelledRef.current) return;
      completeLogin(session);
    } catch (e: unknown) {
      if (qrCancelledRef.current) return;
      if (e instanceof QrLoginExpiredError) {
        setQrPhase("expired");
      } else {
        setQrPhase("error");
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    }
  }, [completeLogin]);

  // The QR challenge is created lazily, the first time the QR view is opened —
  // never on page mount, so app startup fires no auth requests (backends
  // without the QR channel stay silent until the user opts in).
  const qrStartedRef = useRef(false);
  useEffect(() => {
    if (!passwordless || view !== "qr" || qrStartedRef.current) return;
    qrStartedRef.current = true;
    startQrLogin();
  }, [passwordless, view, startQrLogin]);

  useEffect(() => {
    // Stop the QR poll and drop any pending code auto-submit when the login
    // page unmounts (e.g. after sign-in).
    clearPendingCodeSubmit();
    return () => {
      qrCancelledRef.current = true;
    };
  }, []);

  // One-second tick while a resend cooldown is running.
  const resending = resendIn > 0;
  useEffect(() => {
    if (!resending) return;
    const timer = setInterval(
      () => setResendIn((s) => Math.max(0, s - 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, [resending]);

  async function handleSendCode() {
    if (!isValidChinaPhone(phone) || codeSending || resendIn > 0) return;
    setSmsError(null);
    setCodeSending(true);
    try {
      const res = await sendSmsCaptcha(phone.trim());
      if (res.success) {
        setResendIn(res.cooldown > 0 ? res.cooldown : SMS_RESEND_DEFAULT_SECONDS);
      } else {
        if (res.cooldown > 0) setResendIn(res.cooldown);
        setSmsError(t("auth.sms_send_failed"));
      }
    } catch (e: unknown) {
      // Rate limiting arrives with the remaining wait inside `data.cooldown`.
      const wait = cooldownSecondsFromError(e);
      if (wait) setResendIn(wait);
      setSmsError(authErrorText(e, t, "auth.sms_send_failed"));
    } finally {
      setCodeSending(false);
    }
  }

  async function handleSmsLogin(codeOverride?: string) {
    const code = codeOverride ?? smsCode;
    if (
      !agreed ||
      !isValidChinaPhone(phone) ||
      !isCompleteSmsCode(code) ||
      smsSubmitting
    )
      return;
    clearPendingCodeSubmit();
    setSmsError(null);
    setSmsSubmitting(true);
    try {
      const vo = await loginByPhoneCode(phone.trim(), code);
      completeLogin(smsSessionFromLogin(vo));
    } catch (e: unknown) {
      setSmsError(authErrorText(e, t, "auth.sms_login_failed"));
    } finally {
      setSmsSubmitting(false);
    }
  }

  function handleSmsCodeChange(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, SMS_CODE_MAX_LENGTH);
    setSmsCode(digits);
    clearPendingCodeSubmit();
    // Six digits are unambiguously complete — submit immediately. A 4-digit
    // code auto-submits after a short pause, so a user still typing towards
    // six digits cancels it by simply keeping on typing.
    if (digits.length === SMS_CODE_MAX_LENGTH) {
      void handleSmsLogin(digits);
    } else if (digits.length === SMS_CODE_LENGTHS[0]) {
      codeSubmitTimerRef.current = setTimeout(() => {
        codeSubmitTimerRef.current = null;
        void handleSmsLogin(digits);
      }, CODE_AUTO_SUBMIT_DELAY_MS);
    }
  }

  function handleAgreeLink(url: string) {
    if (url) openExternalUrl(url);
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
          setError(authErrorText(e, t, "auth.login_failed"));
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

  const qrHint =
    qrPhase === "scanned"
      ? t("auth.qr_scanned")
      : qrPhase === "expired"
        ? t("auth.qr_expired")
        : qrPhase === "error"
          ? t("auth.qr_failed")
          : t("auth.qr_login_hint");
  const qrDimmed = qrPhase === "expired" || qrPhase === "error";

  const phoneValid = isValidChinaPhone(phone);
  const sendCodeDisabled = !phoneValid || codeSending || resendIn > 0;
  const loginDisabled =
    !agreed || !phoneValid || !isCompleteSmsCode(smsCode) || smsSubmitting;

  // Shared pill-input treatment (borderless muted fill, like the mobile app).
  const pillInputClass =
    "border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 focus-visible:shadow-none rounded-none";

  return (
    /* Locked to the viewport with no page scroll: the column is sized to fit
       the compact welcome window (690×450, see AuthGate). Theme-driven tokens
       (no forced dark anymore) — the user-provided artwork card carries the
       color, Qoder-welcome style: info + form on the left, the image on the
       right. text-foreground is re-declared because <Input> carries no color
       class of its own. */
    <main className="relative flex h-dvh overflow-hidden bg-background text-foreground">
      {/* The login face replaces the whole dashboard, so it carries its own
          drag strip — the unified title bar is not mounted here. */}
      <div aria-hidden data-tauri-drag-region className="absolute inset-x-0 top-0 z-20 h-10" />

      {/* Left column: brand block + the active sign-in form, actions hugging
          the bottom edge like the reference window. */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col px-7 pb-5 pt-9">
        <img src={LYNSE_LOGO_SRC} alt="Lynse" className="h-5 w-auto self-start dark:invert" />
        <h1 className="mt-4 text-lg font-semibold tracking-tight">
          {t("auth.welcome_title")}
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          {t("auth.login_subtitle")}
        </p>

        <div className="mt-5 w-full max-w-[320px] flex-1 overflow-y-auto">
        {view === "more" ? (
          /* ── More ways to sign in ─────────────────────── */
          <div className="space-y-4">
            <p className="text-center text-sm font-medium">
              {t("auth.more_login")}
            </p>
            <div className="space-y-2">
              <button
                type="button"
                onClick={handleWechatLogin}
                className="flex h-9 w-full items-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
              >
                <WechatIcon className="size-4" />
                <span className="text-sm">{t("auth.wechat_login")}</span>
                <ChevronRight className="ml-auto size-4 text-muted-foreground" />
              </button>
              <button
                type="button"
                onClick={() => setView("qr")}
                className="flex h-9 w-full items-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
              >
                <QrCode className="size-4" />
                <span className="text-sm">{t("auth.qr_login")}</span>
                <ChevronRight className="ml-auto size-4 text-muted-foreground" />
              </button>
              {devApiAuth && (
                <button
                  type="button"
                  onClick={() => setView("api")}
                  className="flex h-9 w-full items-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
                >
                  <KeyRound className="size-4" />
                  <span className="text-sm">{t("auth.api_login")}</span>
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                </button>
              )}
            </div>
            <div className="text-center">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => setView("phone")}
              >
                {t("auth.back_to_phone")}
              </Button>
            </div>
          </div>
        ) : passwordless && view !== "api" ? (
          view === "phone" ? (
            <>
              {/* ── Phone number pill ──────────────────────── */}
              <div className="flex h-9 items-center gap-3 rounded-full bg-muted px-3.5">
                <span className="text-sm text-foreground">+86</span>
                <span className="h-4 w-px shrink-0 bg-border" />
                <Input
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder={t("auth.sms_phone_placeholder")}
                  value={phone}
                  onChange={(e) =>
                    setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSmsLogin();
                  }}
                  className={`flex-1 ${pillInputClass}`}
                />
              </div>

              {/* ── SMS code pill (send button inside) ─────── */}
              <div className="relative mt-2">
                <Input
                  inputMode="numeric"
                  maxLength={SMS_CODE_MAX_LENGTH}
                  placeholder={t("auth.sms_code_placeholder")}
                  value={smsCode}
                  onChange={(e) => handleSmsCodeChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSmsLogin();
                  }}
                  className="h-9 rounded-full border-0 bg-muted pl-3.5 pr-24 text-sm shadow-none focus-visible:ring-0 focus-visible:shadow-none"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="absolute right-3 top-1/2 h-6 -translate-y-1/2 px-0 text-xs font-medium hover:bg-transparent"
                  disabled={sendCodeDisabled}
                  onClick={handleSendCode}
                >
                  {codeSending
                    ? t("auth.sms_sending")
                    : resendIn > 0
                      ? t("auth.sms_resend_in", { seconds: resendIn })
                      : t("auth.sms_send_code")}
                </Button>
              </div>

              {/* ── Sign-in + agreement ────────────────────── */}
              <Button
                size="sm"
                className="relative mt-4 h-9 w-full rounded-full bg-gradient-to-r from-[color-mix(in_oklab,var(--primary)_55%,white)] to-primary text-sm font-medium text-primary-foreground hover:opacity-90"
                disabled={loginDisabled}
                onClick={() => handleSmsLogin()}
              >
                {smsSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t("auth.sms_logging_in")}
                  </>
                ) : (
                  t("auth.sms_login_btn")
                )}
                {!smsSubmitting && (
                  <ArrowRight className="absolute right-4 top-1/2 size-4 -translate-y-1/2" />
                )}
              </Button>
              {smsError && (
                <p className="mt-3 text-left text-xs text-destructive">{smsError}</p>
              )}
              <div className="mt-4 flex items-start gap-2">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={agreed}
                  onClick={() => setAgreed(!agreed)}
                  className={`mt-0.5 size-3.5 shrink-0 rounded-full border transition-colors ${
                    agreed ? "border-primary bg-primary" : "border-muted-foreground/60"
                  }`}
                />
                <p className="text-left text-2xs leading-relaxed text-muted-foreground text-pretty">
                  {t("auth.agree_prefix")}
                  <button
                    type="button"
                    onClick={() => handleAgreeLink(TERMS_URL)}
                    className="underline decoration-from-font underline-offset-2 transition-colors hover:text-foreground"
                  >
                    {t("auth.agree_terms")}
                  </button>
                  {t("auth.agree_join")}
                  <button
                    type="button"
                    onClick={() => handleAgreeLink(PRIVACY_URL)}
                    className="underline decoration-from-font underline-offset-2 transition-colors hover:text-foreground"
                  >
                    {t("auth.agree_privacy")}
                  </button>
                  {t("auth.agree_autocreate")}
                </p>
              </div>
            </>
          ) : (
            /* ── App-scanned QR code sign-in ──────────────── */
            <div className="space-y-4 text-center">
              <div className="relative mx-auto flex size-[184px] items-center justify-center overflow-hidden rounded-2xl border border-border/60 bg-muted/30">
                {qrPayload && !qrDimmed ? (
                  <QRCodeSVG
                    value={qrPayload}
                    size={160}
                    marginSize={0}
                    className={
                      qrPhase === "scanned" ? "opacity-40 transition-opacity" : ""
                    }
                  />
                ) : qrPhase === "creating" ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : null}
                {qrDimmed && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80">
                    <p className="px-4 text-center text-2xs leading-relaxed text-muted-foreground">
                      {qrHint}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={startQrLogin}
                    >
                      {qrPhase === "expired" ? t("auth.qr_refresh") : t("auth.qr_retry")}
                    </Button>
                  </div>
                )}
                {qrPhase === "creating" && (
                  <p className="absolute bottom-2 text-2xs text-muted-foreground">
                    {t("auth.qr_creating")}
                  </p>
                )}
              </div>
              <p className="text-2xs leading-relaxed text-muted-foreground">{qrHint}</p>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => setView("phone")}
              >
                {t("auth.back_to_phone")}
              </Button>
            </div>
          )
        ) : (
          /* ── API sign-in: server selection + API key in one form. The main
             sign-in form on "github" builds, a "more ways" view on
             "testflight"; the same UI the /api-config page renders. ─────── */
          <>
            <div className="space-y-4">
              <p className="text-center text-sm font-medium">
                {t("auth.api_config_title")}
              </p>
              <ApiAuthPanel />
            </div>
            {passwordless && (
              <div className="mt-2 text-center">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => setView("phone")}
                >
                  {t("auth.back_to_phone")}
                </Button>
              </div>
            )}
          </>
        )}

        {error && <p className="mt-3 text-center text-xs text-destructive">{error}</p>}
        </div>

        {/* ── More ways to sign in (phone view) / WeChat wait state,
            pinned to the window's bottom edge ── */}
        {passwordless && (view === "phone" || wechatWaiting) && (
          <div className="mt-auto pt-3">
            {wechatWaiting ? (
              <div className="space-y-1.5 text-center">
                <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("auth.wechat_waiting_scan")}
                </p>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t("auth.wechat_waiting_hint")}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={handleCancelWechatLogin}
                >
                  {t("auth.wechat_cancel")}
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setView("more")}
                className="ml-auto flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("auth.more_login")}
                <ChevronRight className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Right column — full-height rounded artwork card, inset on all
          sides like the reference window. Decorative (aria-hidden). ── */}
      <aside aria-hidden className="shrink-0 py-3 pr-3">
        <img
          src={LOGIN_ARTWORK_SRC}
          alt=""
          className="h-full w-[280px] select-none rounded-xl object-cover"
        />
      </aside>

    </main>
  );
}
