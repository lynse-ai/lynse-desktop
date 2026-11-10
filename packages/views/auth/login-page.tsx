"use client";

import { useCallback, useEffect, useRef, useState } from "react";import { QRCodeSVG } from "qrcode.react";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useAuthStore } from "@lynse/core/auth";
import { api } from "@lynse/core/api";
import { LYNSE_EDITION } from "@lynse/core/config";
import {
  emailSessionFromLogin,
  isValidEmail,
  loginByEmailCode,
  sendEmailCaptcha,
} from "@lynse/core/auth/email";
import { completeGoogleRedirect, isGoogleConfigured, startGoogleRedirect } from "@lynse/core/auth/google";
import {
  isAppleAuthorizeUrlConfigured,
  renderAppleLoginUrl,
  startAppleLogin,
} from "@lynse/core/auth/apple";
import { renderWechatLoginUrl } from "@lynse/core/auth/wechat";
import { toast } from "sonner";
import {
  buildQrLoginPayload,
  createQrLogin,
  pollQrLogin,
  QrLoginExpiredError,
} from "@lynse/core/auth/qrcode";
import {
  isWechatBindRequired,
  loginByWechat,
  wechatCallbackParams,
  wechatSessionFromVo,
  type WechatLoginVo,
} from "@lynse/core/auth/wechat";
import {
  SMS_CODE_LENGTH,
  SMS_RESEND_DEFAULT_SECONDS,
  cooldownSecondsFromError,
  isCompleteSmsCode,
  isValidChinaPhone,
  loginByPhoneCode,
  sendSmsCaptcha,
  smsSessionFromLogin,
} from "@lynse/core/auth/sms";
import { useTranslation } from "@lynse/core/i18n/react";
import { ArrowRight, Check, ChevronRight, KeyRound, Loader2, QrCode } from "../icons";
import { getDesktopAppApi, openExternalUrl } from "../app-update";
import { isWebPlatform } from "../platform";
import {
  hasDevApiAuth,
  isTestMode,
  setTestMode,
} from "../feature-flags";
import { privacyUrl, termsUrl } from "../about/links";
import { WindowControls, showWindowControls } from "../layout/app-title-bar";
import { cn } from "@lynse/ui/lib/utils";
import { WechatIcon } from "./wechat-icon";
import { WechatBindForm } from "./wechat-bind-form";
import { authErrorText } from "./auth-errors";
import { ApiAuthPanel } from "./api-auth-panel";
import { LYNSE_LOGO_SRC } from "./lynse-logo";
import { LOGIN_ARTWORK_SRC } from "./login-artwork";

/** Login QR panel phases. "expired"/"error" offer a manual refresh. */
type QrPhase = "creating" | "ready" | "scanned" | "expired" | "error";

/** Sign-in views: phone + SMS form, the email + code form (intl default),
 *  the "more ways" screen (WeChat / QR / dev API entry), the app-scanned QR
 *  code, or the API form. */
type LoginView = "phone" | "email" | "more" | "qr" | "api";

/** The user-agreement round check + inline terms/privacy links, shared by
 *  the phone sign-in form and the WeChat bind form. */
function AgreementCheckbox({
  agreed,
  onToggle,
  onLink,
}: {
  agreed: boolean;
  onToggle: () => void;
  onLink: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="mt-4 flex items-start gap-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={agreed}
        onClick={onToggle}
        className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
          agreed ? "border-primary bg-primary" : "border-muted-foreground/60"
        }`}
      >
        {agreed && (
          <Check className="size-2.5 text-primary-foreground" strokeWidth={3.5} />
        )}
      </button>
      <p className="text-left text-2xs leading-relaxed text-muted-foreground text-pretty">
        {t("auth.agree_prefix")}
        <button
          type="button"
          onClick={() => onLink(termsUrl(i18n.language))}
          className="underline decoration-from-font underline-offset-2 transition-colors hover:text-foreground"
        >
          {t("auth.agree_terms")}
        </button>
        {t("auth.agree_join")}
        <button
          type="button"
          onClick={() => onLink(privacyUrl(i18n.language))}
          className="underline decoration-from-font underline-offset-2 transition-colors hover:text-foreground"
        >
          {t("auth.agree_privacy")}
        </button>
        {t("auth.agree_autocreate")}
      </p>
    </div>
  );
}

/**
 * Startup login page, shown by the AuthGate before any session exists, in
 * the compact welcome window (690×450 — the window shape is AuthGate's
 * job). Qoder-welcome layout: a left column with the wordmark, a welcome
 * heading and the active sign-in form, and a full-height rounded artwork
 * card on the right (LOGIN_ARTWORK_SRC, user-provided).
 *
 * Every build uses the same phone, WeChat and app-scanned QR sign-in flow.
 * The API form (server selection + API key, the same UI as /api-config)
 * is hidden by default in EVERY build; five taps on the logo unlock it.
 *
 * Server / API-key configuration lives inside the API form itself (and the
 * standalone /api-config route); the page keeps no extra link to it.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const devApiAuth = hasDevApiAuth();
  // The web build (www.lynse.ai/app) fills a real browser viewport instead of
  // the desktop welcome window, so it gets a full-page split layout: centered
  // form column on the left, brand panel on the right (see the aside below).
  const web = isWebPlatform();
  // intl builds lead with Google / Apple / email sign-in; cn leads with the
  // phone + SMS form and WeChat (see the view branches below).
  const intl = LYNSE_EDITION === "intl";
  const googleReady = isGoogleConfigured();

  // Active sign-in view. Phone is the CN default; intl leads with email.
  const [view, setView] = useState<LoginView>(intl ? "email" : "phone");

  // Create a challenge, show its QR, then
  // poll until the Lynse mobile app scans + confirms it.
  const completeLogin = useAuthStore((s) => s.completeLogin);
  const [qrPhase, setQrPhase] = useState<QrPhase>("creating");
  const [qrPayload, setQrPayload] = useState("");
  const qrCancelledRef = useRef(false);

  // Phone + SMS sign-in (CN default). The intl email form shares the same
  // code/resend/agreement state — the handlers branch on the active view.
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [codeSending, setCodeSending] = useState(false);
  const [smsSubmitting, setSmsSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  // Apple entry renders only while the backend serves a configured
  // (non-placeholder) authorize URL.
  const [appleUrl, setAppleUrl] = useState<string | null>(null);
  // Which identity provider the active phone-bind form completes.
  const [bindAuthType, setBindAuthType] = useState<"WECHAT_SCAN" | "GOOGLE">("WECHAT_SCAN");

  // WeChat sign-in. The authorize URL comes from the
  // backend's /api/auth/render; on desktop the page opens in an embedded
  // window whose code+state redirect is relayed back as an event, on web the
  // same window leaves for it and /auth/wechat receives the redirect.
  const startWechatLogin = useAuthStore((s) => s.startWechatLogin);
  const [wechatWaiting, setWechatWaiting] = useState(false);
  const wechatCancelledRef = useRef(false);
  const wechatAttemptRef = useRef(0);
  const wechatActiveRef = useRef(false);
  const wechatExchangingRef = useRef(false);
  const wechatUnlistenRef = useRef<(() => void) | null>(null);
  const wechatStateRef = useRef("");
  const wechatApiUrlRef = useRef("");
  // Bind-required login response — shows the phone + SMS form instead of
  // the sign-in views until the bind completes.
  const [wechatBindVo, setWechatBindVo] = useState<WechatLoginVo | null>(null);

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
    if (view !== "qr" || qrStartedRef.current) return;
    qrStartedRef.current = true;
    startQrLogin();
  }, [view, startQrLogin]);

  useEffect(() => {
    // Stop the QR poll and the WeChat auth-window listener when the login
    // page unmounts (e.g. after sign-in).
    return () => {
      qrCancelledRef.current = true;
      wechatCancelledRef.current = true;
      wechatAttemptRef.current += 1;
      wechatUnlistenRef.current?.();
      wechatUnlistenRef.current = null;
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
    if (codeSending || resendIn > 0) return;
    if (view === "email" && !isValidEmail(email)) return;
    if (view !== "email" && !isValidChinaPhone(phone)) return;
    setSmsError(null);
    setCodeSending(true);
    try {
      const res =
        view === "email"
          ? await sendEmailCaptcha(email.trim())
          : await sendSmsCaptcha(phone.trim());
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
    const emailView = view === "email";
    const targetValid = emailView ? isValidEmail(email) : isValidChinaPhone(phone);
    if (!agreed || !targetValid || !isCompleteSmsCode(code) || smsSubmitting) return;
    setSmsError(null);
    setSmsSubmitting(true);
    try {
      const vo = emailView
        ? await loginByEmailCode(email.trim(), code)
        : await loginByPhoneCode(phone.trim(), code);
      completeLogin(emailView ? emailSessionFromLogin(vo) : smsSessionFromLogin(vo));
    } catch (e: unknown) {
      setSmsError(authErrorText(e, t, "auth.sms_login_failed"));
    } finally {
      setSmsSubmitting(false);
    }
  }

  function handleSmsCodeChange(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, SMS_CODE_LENGTH);
    setSmsCode(digits);
    // All six digits in — submit right away.
    if (digits.length === SMS_CODE_LENGTH) void handleSmsLogin(digits);
  }

  // Apple entry availability: the backend's Apple config may still carry
  // placeholder values — check once per mount (intl builds only).
  useEffect(() => {
    if (!intl) return;
    let active = true;
    void renderAppleLoginUrl()
      .then((url) => {
        if (active && isAppleAuthorizeUrlConfigured(url)) setAppleUrl(url);
      })
      .catch(() => {
        // Apple stays hidden when the backend cannot render an authorize URL.
      });
    return () => {
      active = false;
    };
  }, [intl]);

  /** Google sign-in runs through a full-page redirect; the result is
   *  completed by the redirect effect below after the browser returns. */
  async function handleGoogleLogin() {
    if (googleBusy) return;
    setError(null);
    setGoogleBusy(true);
    try {
      await startGoogleRedirect();
      // The page navigates away; reaching here means the redirect failed to
      // start (e.g. popup/network) — drop the busy state so retry is possible.
      setGoogleBusy(false);
    } catch (e: unknown) {
      setGoogleBusy(false);
      setError(authErrorText(e, t, "auth.login_failed"));
    }
  }

  // Complete a Google redirect sign-in when the browser lands back here.
  const [googleRedirectBusy, setGoogleRedirectBusy] = useState(false);
  useEffect(() => {
    if (!intl || !isGoogleConfigured() || googleRedirectBusy) return;
    let active = true;
    setGoogleRedirectBusy(true);
    void completeGoogleRedirect()
      .then((result) => {
        if (!active || !result) return;
        if (result.status === "need_bind") {
          setBindAuthType("GOOGLE");
          setWechatBindVo({ thirdPartyId: result.thirdPartyId });
        } else {
          completeLogin(result.session);
        }
      })
      .catch((e: unknown) => setError(authErrorText(e, t, "auth.login_failed")))
      .finally(() => {
        if (active) setGoogleRedirectBusy(false);
      });
    return () => {
      active = false;
    };
    // completeLogin is a stable store action; intl gates the web-only flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * CN WeChat scan: the backend renders the qrconnect URL. The web app can
   * only complete the flow when the authorize redirect points back at this
   * origin — otherwise the backend callback page ends the journey and the
   * entry explains it is still being configured.
   */
  async function handleWechatQrLogin() {
    setError(null);
    try {
      const url = await renderWechatLoginUrl();
      const sameOrigin =
        !web || (typeof window !== "undefined" && new URL(url).origin === window.location.origin);
      if (!sameOrigin) {
        toast(t("auth.wechat_qr_pending"));
        return;
      }
      window.location.href = url;
    } catch (e: unknown) {
      setError(authErrorText(e, t, "auth.login_failed"));
    }
  }

  function handleAgreeLink(url: string) {
    if (url) openExternalUrl(url);
  }

  // Hidden maintenance entry: five taps on the logo (each within two
  // seconds of the previous) unlock the test mode — the API sign-in panel —
  // in every build, dev shells included. The unlock persists in
  // localStorage until it is exited from the "more ways" screen.
  const logoTapsRef = useRef({ count: 0, at: 0 });

  function handleLogoTap() {
    const now = Date.now();
    const streak =
      now - logoTapsRef.current.at < 2000 ? logoTapsRef.current.count + 1 : 1;
    logoTapsRef.current = { count: streak, at: now };
    if (streak < 5) return;
    logoTapsRef.current = { count: 0, at: 0 };
    setTestMode(true);
    setView("api");
  }

  function stopWechatListener() {
    wechatUnlistenRef.current?.();
    wechatUnlistenRef.current = null;
  }

  /** Shared tail for the desktop callback and the bind form: exchange or
   *  bind resolved into a session — persist it. */
  function completeWechatSession(vo: WechatLoginVo) {
    const session = wechatSessionFromVo(vo);
    if (!session) {
      setError(t("auth.login_failed"));
      return;
    }
    completeLogin(session);
  }

  /** Desktop auth-window redirect landed: relay URL carried code+state. */
  async function finishWechatLogin(code: string | null, state: string | null, attempt: number) {
    if (wechatCancelledRef.current || attempt !== wechatAttemptRef.current || wechatExchangingRef.current) return;
    wechatExchangingRef.current = true;
    stopWechatListener();
    try {
      if (!wechatStateRef.current || state !== wechatStateRef.current) {
        setError(t("wechat.callback_invalid_state"));
        return;
      }
      if (!code) {
        setError(t("wechat.callback_denied"));
        return;
      }
      if (api().getBaseUrl() !== wechatApiUrlRef.current) {
        throw new Error(t("auth.login_failed"));
      }
      const vo = await loginByWechat(code, state ?? undefined);
      if (wechatCancelledRef.current || attempt !== wechatAttemptRef.current) return;
      if (api().getBaseUrl() !== wechatApiUrlRef.current) {
        throw new Error(t("auth.login_failed"));
      }
      if (isWechatBindRequired(vo)) {
        if (!vo.thirdPartyId) throw new Error(t("auth.wechat_bind_failed"));
        setBindAuthType("WECHAT_SCAN");
        setWechatBindVo(vo);
        return;
      }
      completeWechatSession(vo);
    } catch (e: unknown) {
      if (!wechatCancelledRef.current && attempt === wechatAttemptRef.current) {
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    } finally {
      if (attempt === wechatAttemptRef.current) {
        wechatActiveRef.current = false;
        setWechatWaiting(false);
        stopWechatListener();
        void getDesktopAppApi()?.wechat?.closeAuthWindow();
      }
    }
  }

  async function handleWechatLogin() {
    if (wechatActiveRef.current) return;
    const attempt = ++wechatAttemptRef.current;
    wechatActiveRef.current = true;
    wechatExchangingRef.current = false;
    wechatCancelledRef.current = false;
    setWechatWaiting(true);
    setError(null);
    const desktopApi = getDesktopAppApi();
    try {
      const started = await startWechatLogin({ desktopQr: !!desktopApi?.wechat });
      if (attempt !== wechatAttemptRef.current) return;
      wechatStateRef.current = started.state;
      wechatApiUrlRef.current = started.apiUrl;
      if (desktopApi?.wechat) {
        // Listen before opening: the native window intercepts the redirect.
        const unlisten = await desktopApi.wechat.onAuthCallback((callbackUrl) => {
          const { code, state } = wechatCallbackParams(callbackUrl);
          void finishWechatLogin(code, state, attempt);
        });
        if (attempt !== wechatAttemptRef.current) {
          unlisten();
          return;
        }
        wechatUnlistenRef.current = unlisten;
        await desktopApi.wechat.openAuthWindow(started.authorizeUrl);
      } else {
        window.location.assign(started.authorizeUrl);
      }
    } catch (e: unknown) {
      if (attempt === wechatAttemptRef.current) {
        wechatActiveRef.current = false;
        stopWechatListener();
        setWechatWaiting(false);
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    }
  }

  function handleCancelWechatLogin() {
    wechatCancelledRef.current = true;
    wechatAttemptRef.current += 1;
    wechatActiveRef.current = false;
    setWechatWaiting(false);
    stopWechatListener();
    void getDesktopAppApi()?.wechat?.closeAuthWindow();
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

  const targetValid = view === "email" ? isValidEmail(email) : isValidChinaPhone(phone);
  const sendCodeDisabled = !targetValid || codeSending || resendIn > 0;
  const loginDisabled =
    !agreed || !targetValid || !isCompleteSmsCode(smsCode) || smsSubmitting;

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
      {showWindowControls ? (
        /* Frameless Windows/Linux: a dedicated caption band above the content
           so the window buttons own a title-bar strip instead of floating
           over the artwork card. The artwork and the form column both start
           below it. */
        <div
          data-tauri-drag-region
          className="absolute inset-x-0 top-0 z-30 flex h-10 items-stretch justify-end"
        >
          {/* Welcome window keeps its normal caption look; maximize is inert
              here on every platform (macOS mirrors this via the disabled
              zoom button in set_traffic_lights). */}
          <WindowControls allowMaximize={false} />
        </div>
      ) : (
        /* The login face replaces the whole dashboard, so it carries its own
          drag strip — the unified title bar is not mounted here (macOS keeps
          its native traffic lights, the web build has neither). */
        <div aria-hidden data-tauri-drag-region className="absolute inset-x-0 top-0 z-20 h-10" />
      )}

      {/* Left column: brand block + the active sign-in form. Desktop hugs the
          compact welcome window (actions pinned to the bottom edge); web
          centers a narrow form column, Plaud-welcome style. */}
      <div
        className={cn(
          "relative z-10 flex min-w-0 flex-col px-7 pb-5 pt-14",
          web ? "w-full items-center justify-center lg:w-1/2" : "w-1/2",
        )}
      >
        <button
          type="button"
          aria-label="Lynse"
          onClick={handleLogoTap}
          className={cn("cursor-default", web ? "absolute left-7 top-8" : "self-start")}
        >
          <img src={LYNSE_LOGO_SRC} alt="" className="h-4 w-auto dark:invert" />
        </button>
        <h1
          className={cn(
            "font-semibold tracking-tight",
            web ? "mt-8 text-center text-2xl" : "mt-5 text-lg",
          )}
        >
          {t("auth.welcome_title")}
        </h1>
        <p
          className={cn(
            "mt-2.5 text-[13px] leading-relaxed text-muted-foreground",
            web && "text-center",
          )}
        >
          {t("auth.login_subtitle")}
        </p>

        <div
          className={cn(
            "mt-7 overflow-y-auto",
            web ? "w-full max-w-[300px]" : "w-full max-w-[260px] flex-1",
          )}
        >
        {wechatBindVo ? (
          /* ── First third-party sign-in: intl binds email, cn binds phone ── */
          <div className="space-y-4">
            <WechatBindForm
              thirdPartyId={wechatBindVo.thirdPartyId ?? ""}
              authType={bindAuthType}
              agreed={agreed}
              onBound={completeWechatSession}
            />
            <AgreementCheckbox
              agreed={agreed}
              onToggle={() => setAgreed(!agreed)}
              onLink={handleAgreeLink}
            />
            <div className="text-center">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => {
                  setWechatBindVo(null);
                  setError(null);
                  setView("phone");
                }}
              >
                {t("auth.back_to_phone")}
              </Button>
            </div>
          </div>
        ) : view === "more" ? (
          /* ── More ways to sign in ─────────────────────── */
          <div className="space-y-4">
            <p className="text-center text-sm font-medium">
              {t("auth.more_login")}
            </p>
            <div className="space-y-2">
              {intl && (
                <button
                  type="button"
                  onClick={() => setView("phone")}
                  className="flex h-9 w-full items-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
                >
                  <KeyRound className="size-4" />
                  <span className="text-sm">{t("auth.phone_code_login")}</span>
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                </button>
              )}
              {!intl && web && (
                <button
                  type="button"
                  onClick={() => void handleWechatQrLogin()}
                  className="flex h-9 w-full items-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
                >
                  <WechatIcon className="size-4" />
                  <span className="text-sm">{t("auth.wechat_qr_login")}</span>
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                </button>
              )}
              <button
                type="button"
                onClick={handleWechatLogin}
                disabled={wechatWaiting}
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
              {isTestMode() && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => {
                    setTestMode(false);
                    setView("phone");
                  }}
                >
                  {t("auth.test_mode_exit")}
                </Button>
              )}
            </div>
          </div>
        ) : view !== "api" ? (
          view === "email" ? (
            /* ── Email + code sign-in (intl default), Google/Apple above ── */
            <>
              {/* Google/Apple stay visible on intl: clicking without the
                  Firebase/OAuth backend config explains the pending state
                  instead of dying silently, and the flows activate the
                  moment the environment variables land. */}
              <button
                type="button"
                onClick={() => {
                  if (!googleReady) { toast(t("auth.google_pending")); return; }
                  void handleGoogleLogin();
                }}
                data-testid="google-login"
                disabled={googleBusy}
                className="flex h-9 w-full items-center justify-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
              >
                <span className="text-sm">{t("auth.google_login")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!appleUrl) { toast(t("auth.apple_pending")); return; }
                  startAppleLogin(appleUrl);
                }}
                className="mt-2 flex h-9 w-full items-center justify-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
              >
                <span className="text-sm">{t("auth.apple_login")}</span>
              </button>
              <div className="my-4 flex items-center gap-3 text-2xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                {t("auth.or_divider")}
                <span className="h-px flex-1 bg-border" />
              </div>

              {/* ── Email pill ─────────────────────────────── */}
              <Input
                inputMode="email"
                autoComplete="email"
                placeholder={t("auth.email_placeholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSmsLogin();
                }}
                className={pillInputClass}
              />

              {/* ── Code pill (send button inside) ─────────── */}
              <div className="relative mt-3.5">
                <Input
                  inputMode="numeric"
                  maxLength={SMS_CODE_LENGTH}
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
                className="relative mt-6 h-9 w-full rounded-full bg-gradient-to-r from-[color-mix(in_oklab,var(--primary)_55%,white)] to-primary text-sm font-medium text-primary-foreground hover:opacity-90"
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
              <AgreementCheckbox
                agreed={agreed}
                onToggle={() => setAgreed(!agreed)}
                onLink={handleAgreeLink}
              />
            </>
          ) : view === "phone" ? (
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
              <div className="relative mt-3.5">
                <Input
                  inputMode="numeric"
                  maxLength={SMS_CODE_LENGTH}
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
                className="relative mt-6 h-9 w-full rounded-full bg-gradient-to-r from-[color-mix(in_oklab,var(--primary)_55%,white)] to-primary text-sm font-medium text-primary-foreground hover:opacity-90"
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
              <AgreementCheckbox
                agreed={agreed}
                onToggle={() => setAgreed(!agreed)}
                onLink={handleAgreeLink}
              />
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
          /* ── API sign-in: server selection + API key in one form; the
             same UI the /api-config page renders. Locked behind the logo
             5-tap (test mode) in every build. ─────── */
          <>
            <ApiAuthPanel />
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
          </>
        )}

        {error && <p className="mt-3 text-center text-xs text-destructive">{error}</p>}
        </div>

        {/* ── More ways to sign in (phone view) / WeChat wait state.
            Desktop pins it to the window's bottom edge; web keeps it right
            under the centered form. ── */}
        {(view === "phone" || wechatWaiting) && (
          <div className={cn(web ? "mt-5" : "mt-auto pt-3")}>
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
                className="flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("auth.more_login")}
                <ChevronRight className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Right column. Desktop: full-height rounded artwork card, inset on
          all sides like the reference window. Web (lg+): a soft brand panel
          with the headline and the same artwork; below lg the column hides
          and the form takes the full width. ── */}
      {web ? (
        <aside
          aria-hidden
          className="hidden w-1/2 shrink-0 flex-col items-center justify-center bg-gradient-to-b from-primary/10 via-background to-secondary/30 px-10 lg:flex"
        >
          <img
            src={LOGIN_ARTWORK_SRC}
            alt=""
            className="w-full max-w-md select-none rounded-2xl object-cover shadow-sm"
          />
          <p className="mt-8 text-center text-lg font-semibold tracking-tight">
            {t("auth.brand_title")}
          </p>
          <p className="mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
            {t("auth.brand_subtitle")}
          </p>
        </aside>
      ) : (
        <aside
          aria-hidden
          className={cn(
            "w-1/2 shrink-0 pb-3 pr-3",
            showWindowControls ? "pt-[52px]" : "pt-3",
          )}
        >
          <img
            src={LOGIN_ARTWORK_SRC}
            alt=""
            className="h-full w-full select-none rounded-xl object-cover"
          />
        </aside>
      )}

    </main>
  );
}
