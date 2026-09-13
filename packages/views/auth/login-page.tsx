"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
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
import { useNavigation } from "../navigation";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2, QrCode } from "../icons";
import { getDesktopAppApi, openExternalUrl } from "../app-update";
import { hasPasswordlessAuth } from "../feature-flags";
import { PRIVACY_URL, TERMS_URL } from "../about/links";
import { WechatIcon } from "./wechat-icon";
import { authErrorText } from "./auth-errors";
import { LYNSE_LOGO_SRC } from "./lynse-logo";

/** Login QR panel phases. "expired"/"error" offer a manual refresh. */
type QrPhase = "creating" | "ready" | "scanned" | "expired" | "error";

/** Sign-in views: phone + SMS form, or the app-scanned QR code. */
type LoginView = "phone" | "qr";

// A 4-digit code waits this long before auto-submitting, in case the user is
// still typing towards a 6-digit one; 6 digits submit without waiting.
const CODE_AUTO_SUBMIT_DELAY_MS = 600;

/**
 * Startup login page, shown by the AuthGate before any session exists.
 *
 * The layout mirrors the Lynse mobile app: the wordmark on a bare background,
 * pill-shaped inputs, a full-width pill sign-in button, an agreement row, and
 * circular third-party sign-in entries at the bottom. No card, no panels.
 *
 * Form content differs by build channel:
 *  - "testflight": phone + SMS code form, plus QR-code and WeChat entries.
 *  - "github": API-key connect form only.
 *
 * A small bottom-left link opens the API configuration page on both channels.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const passwordless = hasPasswordlessAuth();
  const isDesktop = !!getDesktopAppApi();

  // Active sign-in view. Phone is the default: unlike the QR flow it needs no
  // Lynse mobile app, and it also covers registration.
  const [view, setView] = useState<LoginView>("phone");

  // API-key channel (github build)
  const login = useAuthStore((s) => s.login);
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);

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

  async function handleApiKeyLogin() {
    if (!apiKey.trim()) return;
    setError(null);
    setConnecting(true);
    try {
      await login(apiKey.trim());
    } catch (e: unknown) {
      setError(authErrorText(e, t));
    } finally {
      setConnecting(false);
    }
  }

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
    <main className="relative flex min-h-screen flex-col items-center bg-background px-6">
      <img
        src={LYNSE_LOGO_SRC}
        alt="Lynse"
        className="mt-[15vh] h-10 w-auto dark:invert"
      />

      <div className="mt-10 w-full max-w-xs">
        {passwordless ? (
          view === "phone" ? (
            <>
              {/* ── Phone number pill ──────────────────────── */}
              <div className="flex h-12 items-center gap-3 rounded-full bg-muted px-5">
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
              <div className="relative mt-3">
                <Input
                  inputMode="numeric"
                  maxLength={SMS_CODE_MAX_LENGTH}
                  placeholder={t("auth.sms_code_placeholder")}
                  value={smsCode}
                  onChange={(e) => handleSmsCodeChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSmsLogin();
                  }}
                  className="h-12 rounded-full border-0 bg-muted pl-5 pr-32 text-sm shadow-none focus-visible:ring-0 focus-visible:shadow-none"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="absolute right-4 top-1/2 h-8 -translate-y-1/2 px-0 text-sm font-medium hover:bg-transparent"
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
                className="mt-10 h-12 w-full rounded-full text-sm font-medium"
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
              </Button>
              {smsError && (
                <p className="mt-3 text-center text-xs text-destructive">{smsError}</p>
              )}
              <div className="mt-4 flex items-start justify-center gap-2">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={agreed}
                  onClick={() => setAgreed(!agreed)}
                  className={`mt-0.5 size-3.5 shrink-0 rounded-full border transition-colors ${
                    agreed ? "border-primary bg-primary" : "border-muted-foreground/60"
                  }`}
                />
                <p className="text-2xs leading-relaxed text-muted-foreground text-pretty">
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
          /* ── API-key channel (github build) ────────────── */
          <div className="space-y-3">
            <Input
              type="password"
              placeholder="dk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleApiKeyLogin();
              }}
              className="h-12 rounded-full border-0 bg-muted px-5 text-sm shadow-none focus-visible:ring-0 focus-visible:shadow-none"
            />
            <Button
              size="sm"
              className="h-12 w-full rounded-full text-sm font-medium"
              onClick={handleApiKeyLogin}
              disabled={!apiKey.trim() || connecting}
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("auth.api_key_connecting")}
                </>
              ) : (
                t("auth.api_key_connect")
              )}
            </Button>
          </div>
        )}

        {error && <p className="mt-3 text-center text-xs text-destructive">{error}</p>}
      </div>

      {/* ── Third-party sign-in entries ──────────────────── */}
      {passwordless && (
        <div className="mt-auto w-full max-w-xs pb-10 pt-12">
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
            <>
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-2xs text-muted-foreground">
                  {t("auth.other_login")}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="mt-5 flex items-start justify-center gap-10">
                <div className="flex flex-col items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleWechatLogin}
                    className="flex size-11 items-center justify-center rounded-full bg-muted transition-colors hover:bg-muted/70"
                  >
                    <WechatIcon className="size-5" />
                  </button>
                  <span className="text-2xs text-muted-foreground">
                    {t("auth.wechat")}
                  </span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setView("qr")}
                    className={`flex size-11 items-center justify-center rounded-full bg-muted transition-colors hover:bg-muted/70 ${
                      view === "qr" ? "ring-1 ring-ring" : ""
                    }`}
                  >
                    <QrCode className="size-5" />
                  </button>
                  <span className="text-2xs text-muted-foreground">
                    {t("auth.qr_login")}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

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
