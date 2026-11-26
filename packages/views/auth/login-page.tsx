"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useAuthStore } from "@lynse/core/auth";
import { api } from "@lynse/core/api";
import {
  getEffectiveEdition,
  setEdition,
  defaultApiUrlForEdition,
  agentUrlForApiUrl,
  AGENT_API_URL_STORAGE_KEY,
  type LynseEdition,
} from "@lynse/core/config";
import {
  emailSessionFromLogin,
  isValidEmail,
  loginByEmailCode,
  sendEmailCaptcha,
} from "@lynse/core/auth/email";
import {
  buildGoogleRelayUrl,
  completeGoogleLogin,
  completeGoogleRedirect,
  googleRelayLandingFromUrl,
  isGoogleBindRequired,
  isGoogleConfigured,
  loginByGoogleIdentityToken,
  newGoogleRelayNonce,
  signInWithGoogle,
  webOriginForApi,
} from "@lynse/core/auth/google";
import {
  getGoogleNativeLoginConfig,
  googleNativeCallbackFromUrl,
  startGoogleNativeLogin,
} from "@lynse/core/auth/google-native";
import {
  appleLandingFromUrl,
  appleWebLandingOrigin,
  isAppleAuthorizeUrlConfigured,
  renderAppleLoginUrl,
  sessionFromAppleFragment,
  startAppleLogin,
} from "@lynse/core/auth/apple";
import { wechatWebFlowReady } from "@lynse/core/auth/wechat";
import {
  beginWebSsoLogin,
  completeSsoLogin,
  getLynseSsoConfig,
  startSsoLogin,
} from "@lynse/core/auth/lynse-sso";
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
import { ArrowRight, Check, ChevronDown, ChevronRight, KeyRound, Loader2, QrCode } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import { getDesktopAppApi, openExternalUrl } from "../app-update";
import { isWebPlatform } from "../platform";
import {
  hasDevApiAuth,
  isTestMode,
  setTestMode,
} from "../feature-flags";
import { WindowControls, showWindowControls } from "../layout/window-controls";
import { cn } from "@lynse/ui/lib/utils";
import { AgreementCheckbox } from "./agreement-checkbox";
import { WechatIcon } from "./wechat-icon";
import { AppleIcon } from "./apple-icon";
import { GoogleIcon } from "./google-icon";
import { WechatBindForm } from "./wechat-bind-form";
import { appleErrorMessage } from "./apple-bind-landing";
import { authErrorText } from "./auth-errors";
import { ApiAuthPanel } from "./api-auth-panel";
import { LYNSE_LOGO_SRC } from "./lynse-logo";
import { LOGIN_ARTWORK_SRC } from "./login-artwork";
import { LOGIN_CAROUSEL_SLIDES_WEB } from "./login-carousel-artwork";
import { LoginCarousel } from "./login-carousel";

/** Login QR panel phases. "expired"/"error" offer a manual refresh. */
type QrPhase = "creating" | "ready" | "scanned" | "expired" | "error";

/** Sign-in views: phone + SMS form, the email + code form (intl default),
 *  the "more ways" screen (WeChat / QR / dev API entry), the app-scanned QR
 *  code, or the API form. */
type LoginView = "phone" | "email" | "more" | "qr" | "api";

const providerButtonClass = "flex h-9 w-full items-center justify-center gap-2.5 rounded-full border border-border/50 bg-muted/40 px-3.5 text-sm transition-colors hover:bg-muted/80 disabled:opacity-50";

/**
 * Startup login page, shown by the AuthGate before any session exists, in
 * the compact welcome window (690×450 — the window shape is AuthGate's
 * job). Qoder-welcome layout: a left column with the wordmark, a welcome
 * heading and the active sign-in form, and a rounded artwork card on the
 * right (desktop: LOGIN_ARTWORK_SRC full-height; web: the
 * LOGIN_CAROUSEL_SLIDES_WEB storyboard carousel — illustration card +
 * caption + dots — both user-provided).
 *
 * Every build uses the same phone, WeChat and app-scanned QR sign-in flow.
 * The API form (server selection + API key, the same UI as /api-config)
 * is hidden by default in EVERY build; five taps on the logo unlock it.
 *
 * Server / API-key configuration lives inside the API form itself (and the
 * standalone /api-config route); the page keeps no extra link to it.
 */
export function LoginPage({ subtitle, footer, hideMoreLogin = false }: {
  subtitle?: string;
  footer?: ReactNode;
  hideMoreLogin?: boolean;
} = {}) {
  const { t } = useTranslation();
  const devApiAuth = hasDevApiAuth();
  // The web build (www.lynse.cn/app) fills a real browser viewport instead of
  // the desktop welcome window, so it gets a full-page split layout: centered
  // form column on the left, storyboard carousel on the right (see the aside
  // below).
  const web = isWebPlatform();
  // Active edition state: defaults to effective edition (saved pick -> smart timezone/locale detection).
  const [edition, setEditionState] = useState<LynseEdition>(getEffectiveEdition);
  // intl leads with Google / Apple / email sign-in; cn leads with the
  // phone + SMS form and WeChat (see the view branches below).
  const intl = edition === "intl";
  const googleReady = isGoogleConfigured();

  // Active sign-in view. Phone is the CN default; intl leads with email.
  const [view, setView] = useState<LoginView>(intl ? "email" : "phone");
  // Overseas (intl) edition only supports Email, Google, and Apple sign-in.
  // All other login methods (phone SMS, WeChat, QR) are strictly excluded.
  const activeView: LoginView = intl ? (view === "api" ? "api" : "email") : view;

  const handleSelectEdition = (newEdition: LynseEdition) => {
    if (newEdition === edition) return;
    setEdition(newEdition);
    setEditionState(newEdition);

    // Switch default API gateway & agent URL
    const newApiUrl = defaultApiUrlForEdition(newEdition);
    api().setBaseUrl(newApiUrl);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("lynse_api_url", newApiUrl);
        const agentUrl = agentUrlForApiUrl(newApiUrl);
        api().setAgentBaseUrl(agentUrl);
        if (agentUrl) localStorage.setItem(AGENT_API_URL_STORAGE_KEY, agentUrl);
        else localStorage.removeItem(AGENT_API_URL_STORAGE_KEY);
      } catch {}
    }

    // Switch active view according to edition
    setView(newEdition === "intl" ? "email" : "phone");

    // Reset error & transient states
    setError(null);
    setSmsError(null);
    setAccount("");
    setSmsCode("");
    setStep("account");
    setCodeTarget(null);
    setResendIn(0);
    setQrPhase("creating");
    qrCancelledRef.current = true;
    wechatCancelledRef.current = true;
    wechatAttemptRef.current += 1;
    wechatActiveRef.current = false;
    setWechatWaiting(false);
    stopWechatListener();
    ssoCancelledRef.current = true;
    ssoAttemptRef.current += 1;
    ssoActiveRef.current = false;
    setSsoWaiting(false);
    stopSsoListener();
    appleCancelledRef.current = true;
    appleAttemptRef.current += 1;
    appleActiveRef.current = false;
    setAppleWaiting(false);
    stopAppleListener();
    googleCancelledRef.current = true;
    googleAttemptRef.current += 1;
    googleActiveRef.current = false;
    setGoogleWaiting(false);
    stopGoogleListener();
  };

  // Create a challenge, show its QR, then
  // poll until the Lynse mobile app scans + confirms it.
  const completeLogin = useAuthStore((s) => s.completeLogin);
  const [qrPhase, setQrPhase] = useState<QrPhase>("creating");
  const [qrPayload, setQrPayload] = useState("");
  const qrCancelledRef = useRef(false);

  // Progressive single-input sign-in (Muse style): Step 1 collects account (phone or email),
  // Step 2 collects verification code in-place.
  const [account, setAccount] = useState("");
  const [step, setStep] = useState<"account" | "code">("account");
  const [smsCode, setSmsCode] = useState("");
  const [codeTarget, setCodeTarget] = useState<string | null>(null);
  const [codeSending, setCodeSending] = useState(false);
  const [smsSubmitting, setSmsSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  // Which identity provider the active bind form completes.
  const [bindAuthType, setBindAuthType] = useState<"WECHAT_SCAN" | "GOOGLE" | "APPLE">("WECHAT_SCAN");

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
  // Account-center SSO (Lynse 账号) — same shape as the WeChat flow: embedded
  // authorize window, intercepted callback, state-bound completion.
  const ssoCancelledRef = useRef(false);
  const ssoAttemptRef = useRef(0);
  const ssoActiveRef = useRef(false);
  const ssoUnlistenRef = useRef<(() => void) | null>(null);
  const ssoStateRef = useRef("");
  const ssoVerifierRef = useRef("");
  const [ssoWaiting, setSsoWaiting] = useState(false);
  // Apple sign-in (desktop) — same shape as the WeChat/SSO flows: embedded
  // authorize window, intercepted backend landing, attempt-bound completion.
  const appleCancelledRef = useRef(false);
  const appleAttemptRef = useRef(0);
  const appleActiveRef = useRef(false);
  const appleUnlistenRef = useRef<(() => void) | null>(null);
  const [appleWaiting, setAppleWaiting] = useState(false);
  // Google sign-in (desktop intl) — standalone auth window running the web
  // app's Firebase-redirect relay page; the done-marker navigation carries
  // the identity token back. Same attempt-bound completion shape.
  const googleCancelledRef = useRef(false);
  const googleAttemptRef = useRef(0);
  const googleActiveRef = useRef(false);
  const googleUnlistenRef = useRef<(() => void) | null>(null);
  const googleNonceRef = useRef("");
  const [googleWaiting, setGoogleWaiting] = useState(false);
  // Native loopback flow (RFC 8252): the system browser posts the code to a
  // one-shot 127.0.0.1 listener; per-attempt PKCE/config ride this ref.
  const googleNativeFlowRef = useRef<{
    state: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    apiKey: string;
  } | null>(null);
  // Bind-required login response — shows the phone + SMS form instead of
  // the sign-in views until the bind completes.
  // `?bind_preview=1` renders the dedicated binding screen directly (QA
  // entry for reviewing that screen without completing a third-party login).
  const bindPreview = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("bind_preview") === "1";
  const [wechatBindVo, setWechatBindVo] = useState<WechatLoginVo | null>(
    bindPreview ? { thirdPartyId: "bind-preview-identity", isNeedBind: true } : null,
  );

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
    // Stop the QR poll and the auth-window listeners when the login
    // page unmounts (e.g. after sign-in).
    return () => {
      qrCancelledRef.current = true;
      wechatCancelledRef.current = true;
      wechatAttemptRef.current += 1;
      wechatUnlistenRef.current?.();
      wechatUnlistenRef.current = null;
      ssoCancelledRef.current = true;
      ssoAttemptRef.current += 1;
      ssoUnlistenRef.current?.();
      ssoUnlistenRef.current = null;
      appleCancelledRef.current = true;
      appleAttemptRef.current += 1;
      appleUnlistenRef.current?.();
      appleUnlistenRef.current = null;
      googleCancelledRef.current = true;
      googleAttemptRef.current += 1;
      googleUnlistenRef.current?.();
      googleUnlistenRef.current = null;
      void getDesktopAppApi()?.googleNative?.stopListener();
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

  const currentAccount = account.trim();
  const isEmail = isValidEmail(currentAccount);
  const phone = currentAccount.replace(/^\+86/, "").replace(/[\s()-]/g, "");
  const target = isEmail ? currentAccount : !intl && isValidChinaPhone(phone) ? phone : null;
  const showDialCode = !intl && (currentAccount === "" || /^1\d*$/.test(currentAccount));

  function maskAccount(val: string): string {
    const trimmed = val.trim();
    if (trimmed.includes("@")) {
      const [user, domain] = trimmed.split("@");
      if (!user || !domain) return trimmed;
      if (user.length <= 2) return `${user[0]}***@${domain}`;
      return `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
    }
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length === 11) {
      return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
    }
    if (digits.length > 7) {
      return `${digits.slice(0, 3)}****${digits.slice(-2)}`;
    }
    return trimmed;
  }

  async function handleSendCode() {
    if (!target || codeSending || smsSubmitting) return;
    if (!agreed) {
      setSmsError(t("auth.agree_prefix") + t("auth.agree_terms") + t("auth.agree_privacy"));
      return;
    }
    setSmsError(null);
    if (target === codeTarget && resendIn > 0) {
      setStep("code");
      return;
    }
    setCodeSending(true);
    try {
      const res = isEmail
        ? await sendEmailCaptcha(target)
        : await sendSmsCaptcha(target);
      if (res.success || res.cooldown > 0) {
        setCodeTarget(target);
        setResendIn(res.cooldown > 0 ? res.cooldown : SMS_RESEND_DEFAULT_SECONDS);
        setStep("code");
      }
      if (!res.success) setSmsError(t("auth.sms_send_failed"));
    } catch (e: unknown) {
      // Rate limiting arrives with the remaining wait inside `data.cooldown`.
      const wait = cooldownSecondsFromError(e);
      if (wait) {
        setCodeTarget(target);
        setResendIn(wait);
        setStep("code");
      }
      setSmsError(authErrorText(e, t, "auth.sms_send_failed"));
    } finally {
      setCodeSending(false);
    }
  }

  async function handleSmsLogin(codeOverride?: string) {
    const code = codeOverride ?? smsCode;
    if (!agreed || !target || target !== codeTarget || !isCompleteSmsCode(code) || smsSubmitting) return;
    setSmsError(null);
    setSmsSubmitting(true);
    try {
      const vo = isEmail
        ? await loginByEmailCode(target, code)
        : await loginByPhoneCode(target, code);
      completeLogin(isEmail ? emailSessionFromLogin(vo) : smsSessionFromLogin(vo));
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

  /** Google popup flow; first-time identities continue into the dedicated
   *  binding screen (intl binds an email, cn binds a phone). */
  async function handleGoogleLogin() {
    if (googleBusy) return;
    setError(null);
    setGoogleBusy(true);
    try {
      const result = await signInWithGoogle();
      if (result.status === "need_bind") {
        setBindAuthType("GOOGLE");
        setWechatBindVo({ thirdPartyId: result.thirdPartyId });
        setGoogleBusy(false);
      } else if (result.status === "redirecting") {
        // Full-page redirect in progress; the return completes via
        // completeGoogleRedirect on the landing page mount.
        return;
      } else if (result.status === "signed_in" && result.session) {
        completeLogin(result.session);
        setGoogleBusy(false);
      } else {
        setGoogleBusy(false);
      }
    } catch (e: unknown) {
      setError(authErrorText(e, t, "auth.login_failed"));
      setGoogleBusy(false);
    }
  }

  // Complete a Google redirect sign-in when the browser lands back here.
  // A ref (not state) guards StrictMode's double effect: getRedirectResult
  // consumes the pending redirect exactly once.
  const googleRedirectStartedRef = useRef(false);
  useEffect(() => {
    if (!intl || !isGoogleConfigured() || googleRedirectStartedRef.current) return;
    googleRedirectStartedRef.current = true;
    void completeGoogleRedirect()
      .then((result) => {
        if (!result || result.status === "redirecting") return;
        if (result.status === "need_bind") {
          setBindAuthType("GOOGLE");
          setWechatBindVo({ thirdPartyId: result.thirdPartyId });
        } else if (result.session) {
          completeLogin(result.session);
        }
      })
      .catch((e: unknown) => setError(authErrorText(e, t, "auth.login_failed")));
  }, []);


  /**
   * Apple web login (all editions): the backend renders the authorize URL
   * (Services ID com.lynse.web) and completes the exchange server-side, then
   * 302s back to the web landing pages (#token fragment or bind landing).
   * Placeholder configs surface as the pending toast instead of a broken
   * redirect to Apple.
   */
  async function handleAppleWebLogin() {
    if (appleBusy) return;
    setError(null);
    setAppleBusy(true);
    try {
      const url = await renderAppleLoginUrl();
      if (!isAppleAuthorizeUrlConfigured(url)) {
        toast(t("auth.apple_pending"));
        return;
      }
      startAppleLogin(url);
    } catch (e: unknown) {
      setError(authErrorText(e, t, "auth.login_failed"));
    } finally {
      setAppleBusy(false);
    }
  }

  /**
   * CN WeChat scan: the backend renders the qrconnect URL. Its `redirect_uri`
   * is fixed to the backend's `/auth/login` by WeChat's callback-domain rule;
   * production now 302s that callback to this web app's `/auth/wechat` route,
   * where the one-time code is exchanged through POST /api/auth/login (the
   * same exchange the desktop shell performs in its embedded auth window).
   * `startWechatLogin` stores the backend-issued `state` so the callback page
   * can reject a forged redirect. The entry only leaves for WeChat when the
   * redirect can be completed by a client; otherwise it explains it is still
   * being configured.
   */
  async function handleWechatQrLogin() {
    setError(null);
    try {
      const started = await startWechatLogin();
      const finishable =
        !web ||
        wechatWebFlowReady(
          started.authorizeUrl,
          new URL(started.apiUrl).origin,
          window.location.origin,
        );
      if (!finishable) {
        toast(t("auth.wechat_qr_pending"));
        return;
      }
      window.location.href = started.authorizeUrl;
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
    setSmsError(null);
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

  function stopSsoListener() {
    ssoUnlistenRef.current?.();
    ssoUnlistenRef.current = null;
  }

  /** Account-center callback landed: relay URL carried code+state. */
  async function finishSsoLogin(code: string | null, state: string | null, attempt: number) {
    if (ssoCancelledRef.current || attempt !== ssoAttemptRef.current) return;
    stopSsoListener();
    try {
      const session = await completeSsoLogin(ssoVerifierRef.current, code, state, ssoStateRef.current);
      if (ssoCancelledRef.current || attempt !== ssoAttemptRef.current) return;
      completeLogin(session);
    } catch (e: unknown) {
      if (!ssoCancelledRef.current && attempt === ssoAttemptRef.current) {
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    } finally {
      if (attempt === ssoAttemptRef.current) {
        ssoActiveRef.current = false;
        setSsoWaiting(false);
        stopSsoListener();
        void getDesktopAppApi()?.oauth?.closeAuthWindow();
      }
    }
  }

  async function handleSsoLogin() {
    if (ssoActiveRef.current || !getLynseSsoConfig()) return;
    const desktopApi = getDesktopAppApi();
    if (!desktopApi?.oauth) {
      // Web: full-page redirect; the /auth/sso route completes the flow.
      try {
        window.location.assign(await beginWebSsoLogin());
      } catch (e: unknown) {
        setError(authErrorText(e, t, "auth.login_failed"));
      }
      return;
    }
    const attempt = ++ssoAttemptRef.current;
    ssoActiveRef.current = true;
    ssoCancelledRef.current = false;
    setSsoWaiting(true);
    setError(null);
    setSmsError(null);
    try {
      const started = await startSsoLogin();
      if (attempt !== ssoAttemptRef.current) return;
      ssoVerifierRef.current = started.verifier;
      ssoStateRef.current = started.state;
      // Listen before opening: the native window intercepts the redirect.
      const unlisten = await desktopApi.oauth.onAuthCallback((callbackUrl) => {
        const params = new URL(callbackUrl).searchParams;
        void finishSsoLogin(params.get("code"), params.get("state"), attempt);
      });
      if (attempt !== ssoAttemptRef.current) {
        unlisten();
        return;
      }
      ssoUnlistenRef.current = unlisten;
      await desktopApi.oauth.openAuthWindow(
        started.authorizeUrl,
        getLynseSsoConfig()!.redirectUri,
        started.state,
      );
    } catch (e: unknown) {
      if (attempt === ssoAttemptRef.current) {
        ssoActiveRef.current = false;
        stopSsoListener();
        setSsoWaiting(false);
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    }
  }

  function handleCancelSsoLogin() {
    ssoCancelledRef.current = true;
    ssoAttemptRef.current += 1;
    ssoActiveRef.current = false;
    setSsoWaiting(false);
    stopSsoListener();
    void getDesktopAppApi()?.oauth?.closeAuthWindow();
  }

  function stopAppleListener() {
    appleUnlistenRef.current?.();
    appleUnlistenRef.current = null;
  }

  /** Desktop auth-window landing relayed: the backend's APPLE 302 target
   *  carried the session fragment, a bind identity or an error key. */
  function finishAppleLogin(landingUrl: string, attempt: number) {
    if (appleCancelledRef.current || attempt !== appleAttemptRef.current) return;
    const landing = appleLandingFromUrl(landingUrl);
    if (landing?.kind === "session") {
      completeLogin(sessionFromAppleFragment(landing.token));
    } else if (landing?.kind === "bind") {
      setBindAuthType("APPLE");
      setWechatBindVo({ thirdPartyId: landing.thirdPartyId });
    } else {
      setError(
        landing?.kind === "error"
          ? appleErrorMessage(landing.key, t)
          : t("auth.login_failed"),
      );
    }
    appleActiveRef.current = false;
    setAppleWaiting(false);
    stopAppleListener();
    void getDesktopAppApi()?.apple?.closeAuthWindow();
  }

  /**
   * CN/desktop Apple scan-in: the authorize page opens in the embedded auth
   * window (the web flow's whole-page redirect would navigate the app shell
   * away) and the backend's landing 302 — session fragment, bind identity or
   * error key — is intercepted and relayed back. The web origin the backend
   * lands on is derived from the API host (core/auth/apple.ts).
   */
  async function handleAppleDesktopLogin() {
    if (appleActiveRef.current) return;
    const attempt = ++appleAttemptRef.current;
    appleActiveRef.current = true;
    appleCancelledRef.current = false;
    setAppleWaiting(true);
    setError(null);
    setSmsError(null);
    const appleBridge = getDesktopAppApi()?.apple;
    if (!appleBridge) {
      appleActiveRef.current = false;
      setAppleWaiting(false);
      return;
    }
    try {
      const url = await renderAppleLoginUrl();
      if (attempt !== appleAttemptRef.current) return;
      // Placeholder configs surface as the pending toast instead of a
      // broken redirect to Apple.
      if (!isAppleAuthorizeUrlConfigured(url)) {
        toast(t("auth.apple_pending"));
        appleActiveRef.current = false;
        setAppleWaiting(false);
        return;
      }
      // Listen before opening: the native window intercepts the landing.
      const unlisten = await appleBridge.onAuthCallback((landingUrl) => {
        finishAppleLogin(landingUrl, attempt);
      });
      if (attempt !== appleAttemptRef.current) {
        unlisten();
        return;
      }
      appleUnlistenRef.current = unlisten;
      await appleBridge.openAuthWindow(url, appleWebLandingOrigin(api().getBaseUrl()));
    } catch (e: unknown) {
      if (attempt === appleAttemptRef.current) {
        appleActiveRef.current = false;
        stopAppleListener();
        setAppleWaiting(false);
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    }
  }

  function handleCancelAppleLogin() {
    appleCancelledRef.current = true;
    appleAttemptRef.current += 1;
    appleActiveRef.current = false;
    setAppleWaiting(false);
    stopAppleListener();
    void getDesktopAppApi()?.apple?.closeAuthWindow();
  }

  function stopGoogleListener() {
    googleUnlistenRef.current?.();
    googleUnlistenRef.current = null;
  }

  /** Shared tail of both desktop Google flows: exchange the Firebase ID
   *  token for a session (or hand the identity to the bind form). */
  async function completeGoogleIdentity(identityToken: string, attempt: number) {
    const vo = await loginByGoogleIdentityToken(identityToken);
    if (googleCancelledRef.current || attempt !== googleAttemptRef.current) return;
    if (isGoogleBindRequired(vo)) {
      setBindAuthType("GOOGLE");
      setWechatBindVo({ thirdPartyId: vo.thirdPartyId ?? "" });
      return;
    }
    completeLogin(await completeGoogleLogin(vo));
  }

  function resetGoogleFlow(attempt: number) {
    if (attempt !== googleAttemptRef.current) return;
    googleActiveRef.current = false;
    setGoogleWaiting(false);
    stopGoogleListener();
  }

  /** Desktop relay window landed on the done marker: the web app's relay
   *  page carried the Firebase ID token (fragment) or an error key. The
   *  identity exchange runs here — the browser never creates a session. */
  async function finishGoogleRelayLogin(landingUrl: string, attempt: number) {
    if (googleCancelledRef.current || attempt !== googleAttemptRef.current) return;
    stopGoogleListener();
    try {
      const landing = googleRelayLandingFromUrl(landingUrl, googleNonceRef.current);
      if (landing?.kind === "identity") {
        await completeGoogleIdentity(landing.identityToken, attempt);
      } else {
        setError(t("auth.login_failed"));
      }
    } catch (e: unknown) {
      console.error("[google-relay] sign-in failed:", e instanceof Error ? e.message : String(e));
      if (!googleCancelledRef.current && attempt === googleAttemptRef.current) {
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    } finally {
      resetGoogleFlow(attempt);
      void getDesktopAppApi()?.google?.closeAuthWindow();
    }
  }

  /**
   * Google sign-in on the desktop (intl): Google refuses OAuth inside
   * embedded WebViews, so the popup flow never runs here. Instead a
   * standalone auth window loads the web app's /auth/google-desktop relay
   * page (which runs the Firebase redirect round trip inside that window)
   * and the done-marker navigation — identity token bound to this attempt's
   * nonce — is intercepted and relayed back. The desktop bundle needs no
   * Firebase config; the relay page serves it.
   */
  async function handleGoogleRelayLogin() {
    if (googleActiveRef.current) return;
    const googleBridge = getDesktopAppApi()?.google;
    if (!googleBridge) return;
    const attempt = ++googleAttemptRef.current;
    googleActiveRef.current = true;
    googleCancelledRef.current = false;
    setGoogleWaiting(true);
    setError(null);
    setSmsError(null);
    const nonce = newGoogleRelayNonce();
    const origin = webOriginForApi(api().getBaseUrl());
    try {
      // Listen before opening: the window intercepts the done marker.
      const unlisten = await googleBridge.onAuthCallback((landingUrl) => {
        void finishGoogleRelayLogin(landingUrl, attempt);
      });
      if (attempt !== googleAttemptRef.current) {
        unlisten();
        return;
      }
      googleUnlistenRef.current = unlisten;
      googleNonceRef.current = nonce;
      await googleBridge.openAuthWindow(buildGoogleRelayUrl(origin, nonce), origin, nonce);
    } catch (e: unknown) {
      if (attempt === googleAttemptRef.current) {
        googleActiveRef.current = false;
        stopGoogleListener();
        setGoogleWaiting(false);
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    }
  }

  function handleCancelGoogleLogin() {
    googleCancelledRef.current = true;
    googleAttemptRef.current += 1;
    googleActiveRef.current = false;
    setGoogleWaiting(false);
    stopGoogleListener();
    void getDesktopAppApi()?.google?.closeAuthWindow();
    void getDesktopAppApi()?.googleNative?.stopListener();
    googleNativeFlowRef.current = null;
  }

  /**
   * Google sign-in on the desktop — native installed-app flow (RFC 8252),
   * the preferred path when the desktop OAuth client is configured: the
   * SYSTEM browser runs the consent page (Google never blocks real browsers)
   * and posts the authorization code back to a one-shot 127.0.0.1 listener.
   * Both token exchanges (Google code → ID token, Google → Firebase ID
   * token) run in the Rust layer; the identity lands in the same
   * /api/auth/login exchange as the web popup flow.
   */
  async function handleGoogleNativeLogin() {
    const bridge = getDesktopAppApi()?.googleNative;
    const config = getGoogleNativeLoginConfig();
    if (!bridge || !config || googleActiveRef.current) return;
    const attempt = ++googleAttemptRef.current;
    googleActiveRef.current = true;
    googleCancelledRef.current = false;
    setGoogleWaiting(true);
    setError(null);
    setSmsError(null);
    try {
      const port = await bridge.openListener();
      if (attempt !== googleAttemptRef.current) return;
      const { authorizeUrl, redirectUri, state, verifier } = await startGoogleNativeLogin(port);
      if (attempt !== googleAttemptRef.current) {
        void bridge.stopListener();
        return;
      }
      // Listen before opening: the browser's redirect must not race the
      // listener registration.
      const unlisten = await bridge.onCallback((callbackUrl) => {
        void finishGoogleNativeLogin(callbackUrl, attempt);
      });
      if (attempt !== googleAttemptRef.current) {
        unlisten();
        void bridge.stopListener();
        return;
      }
      googleUnlistenRef.current = unlisten;
      googleNativeFlowRef.current = {
        state,
        verifier,
        redirectUri,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        apiKey: config.firebaseApiKey,
      };
      openExternalUrl(authorizeUrl);
    } catch (e: unknown) {
      if (attempt === googleAttemptRef.current) {
        void bridge.stopListener();
        googleNativeFlowRef.current = null;
        googleActiveRef.current = false;
        stopGoogleListener();
        setGoogleWaiting(false);
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    }
  }

  /** Loopback redirect landed: Google posted the code (or an error) bound to
   *  this attempt's state; the rest happens in the Rust relays. */
  async function finishGoogleNativeLogin(callbackUrl: string, attempt: number) {
    const flow = googleNativeFlowRef.current;
    if (!flow || googleCancelledRef.current || attempt !== googleAttemptRef.current) return;
    const callback = googleNativeCallbackFromUrl(callbackUrl, flow.state);
    // Not this attempt's redirect (stale event, favicon noise) — keep waiting.
    if (!callback) return;
    stopGoogleListener();
    void getDesktopAppApi()?.googleNative?.stopListener();
    googleNativeFlowRef.current = null;
    try {
      if (callback.kind === "error") {
        setError(t("auth.login_failed"));
        return;
      }
      const bridge = getDesktopAppApi()?.googleNative;
      if (!bridge) throw new Error("Google desktop bridge missing");
      const google = await bridge.exchangeCode(
        callback.code,
        flow.verifier,
        flow.redirectUri,
        flow.clientId,
        flow.clientSecret,
      );
      if (googleCancelledRef.current || attempt !== googleAttemptRef.current) return;
      const firebase = await bridge.firebaseSignIn(google.id_token, flow.apiKey);
      if (googleCancelledRef.current || attempt !== googleAttemptRef.current) return;
      await completeGoogleIdentity(firebase.id_token, attempt);
    } catch (e: unknown) {
      console.error("[google-native] sign-in failed:", e instanceof Error ? e.message : String(e));
      if (!googleCancelledRef.current && attempt === googleAttemptRef.current) {
        setError(authErrorText(e, t, "auth.login_failed"));
      }
    } finally {
      resetGoogleFlow(attempt);
    }
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

  // First-time third-party sign-in: replace the whole login page with a
  // single, distraction-free binding card (no logo, tabs, brand panel,
  // agreement checkbox or other sign-in methods). Cancel returns to the
  // normal sign-in view and clears the pending third-party identity.
  if (wechatBindVo) {
    return (
      <main className="flex h-dvh items-center justify-center overflow-hidden bg-background px-4 text-foreground">
        <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
          <WechatBindForm
            thirdPartyId={wechatBindVo.thirdPartyId ?? ""}
            authType={bindAuthType}
            channel={intl ? "email" : "phone"}
            agreed={agreed}
            variant="standalone"
            onCancel={() => {
              setWechatBindVo(null);
              setError(null);
              setView("phone");
            }}
            onBound={completeWechatSession}
          />
          <div className="mt-4">
            <AgreementCheckbox
              agreed={agreed}
              onToggle={() => setAgreed(!agreed)}
              onLink={handleAgreeLink}
            />
          </div>
        </div>
      </main>
    );
  }

  const waitingState = wechatWaiting
    ? {
        title: t("auth.wechat_waiting_scan"),
        hint: t("auth.wechat_waiting_hint"),
        onCancel: handleCancelWechatLogin,
      }
    : ssoWaiting
      ? {
          title: t("auth.sso_waiting"),
          hint: t("auth.sso_waiting_hint"),
          onCancel: handleCancelSsoLogin,
        }
      : googleWaiting
        ? {
            title: t("auth.google_waiting"),
            hint: t("auth.sso_waiting_hint"),
            onCancel: handleCancelGoogleLogin,
          }
        : appleWaiting
          ? {
              title: t("auth.apple_waiting"),
              hint: t("auth.sso_waiting_hint"),
              onCancel: handleCancelAppleLogin,
            }
          : null;

  const waitingNotice = waitingState ? (
    <div className="space-y-1.5 text-center" data-testid="oauth-waiting">
      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span>{waitingState.title}</span>
      </p>
      <p className="text-2xs leading-relaxed text-muted-foreground text-pretty">
        {waitingState.hint}
      </p>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-xs"
        onClick={waitingState.onCancel}
      >
        {t("auth.wechat_cancel")}
      </Button>
    </div>
  ) : null;

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
          compact welcome window; web centers a narrow form column. */}
      <div
        className={cn(
          "relative z-10 flex min-w-0 flex-col",
          web
            ? "w-full items-center justify-center px-7 pb-5 pt-14 lg:w-1/2"
            : "w-1/2 min-h-0 overflow-y-auto px-8 pb-2.5 pt-[54px]",
        )}
      >
        {/* Top Logo */}
        <button
          type="button"
          aria-label="Lynse"
          onClick={handleLogoTap}
          className={cn("block cursor-default", web ? "mx-auto mb-5 mt-2" : "mb-5 self-start")}
        >
          <img src={LYNSE_LOGO_SRC} alt="" className="h-5 w-auto dark:invert" />
        </button>

        {/* Content block — naturally spaced down the column */}
        <div
          className={cn(
            "flex w-full flex-col",
            web ? "max-w-[300px] items-center" : "max-w-[280px]",
          )}
        >
          <h1
            className={cn(
              "font-semibold tracking-tight text-foreground",
              web ? "text-center text-2xl" : "text-xl",
            )}
          >
            {t("auth.welcome_title")}
          </h1>
          <p className={cn(
            "leading-relaxed text-muted-foreground",
            web ? "mt-2.5 break-words text-center text-[13px]" : "mt-1.5 text-xs",
          )}>
            {subtitle ?? t("auth.login_subtitle")}
          </p>

          <div className={cn("w-full", web ? "mt-7" : "mt-5")}>
          {activeView === "more" ? (
          /* ── More ways to sign in ─────────────────────── */
          !web && waitingNotice ? (
            <div className="py-4">{waitingNotice}</div>
          ) : (
          <div className="space-y-4">
            <p className="text-center text-sm font-medium">
              {t("auth.more_login")}
            </p>
            <div className="space-y-2">
              {getLynseSsoConfig() && (
                <button
                  type="button"
                  onClick={handleSsoLogin}
                  disabled={ssoWaiting}
                  className="flex h-9 w-full items-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
                >
                  <img src={LYNSE_LOGO_SRC} alt="" className="size-4 dark:invert" />
                  <span className="text-sm">{t("auth.sso_login")}</span>
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                </button>
              )}
              {!intl && (
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
              )}
              {/* App-scanned QR entry is web-only: on desktop it made way
                  for Apple sign-in (embedded auth window, same shape as the
                  WeChat/SSO flows). */}
              {web && !intl && (
                <button
                  type="button"
                  onClick={() => setView("qr")}
                  className="flex h-9 w-full items-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
                >
                  <QrCode className="size-4" />
                  <span className="text-sm">{t("auth.qr_login")}</span>
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                </button>
              )}
              {!web && !intl && (
                <button
                  type="button"
                  onClick={() => {
                    if (getDesktopAppApi()?.apple) {
                      void handleAppleDesktopLogin();
                    } else {
                      void handleAppleWebLogin();
                    }
                  }}
                  disabled={appleBusy || appleWaiting}
                  className="flex h-9 w-full items-center gap-3 rounded-full bg-muted px-3.5 text-left transition-colors hover:bg-muted/70"
                >
                  <AppleIcon className="size-4" />
                  <span className="text-sm">{t("auth.apple_login")}</span>
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                </button>
              )}
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
                onClick={() => setView(intl ? "email" : "phone")}
              >
                {t(intl ? "auth.back_to_login" : "auth.back_to_phone")}
              </Button>
              {isTestMode() && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => {
                    setTestMode(false);
                    setView(intl ? "email" : "phone");
                  }}
                >
                  {t("auth.test_mode_exit")}
                </Button>
              )}
            </div>
          </div>
          )
        ) : activeView !== "api" ? (
          activeView === "qr" ? (
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
          ) : (
            /* ── Unified Account / Verification Code (Muse progressive single-input) ── */
            <>
              {!web && intl && waitingNotice ? (
                <div className="mb-4 rounded-2xl border border-border/50 bg-muted/20 px-4 py-3.5">
                  {waitingNotice}
                </div>
              ) : (intl || web) && (
                <>
                  <div className="space-y-2">
                    {intl ? (
                      <>
                        {/* Google full-width pill — desktop prefers the native
                            loopback flow (system browser, RFC 8252) when the
                            desktop OAuth client is configured; otherwise the
                            standalone auth-window relay page, and Google
                            refuses popups inside embedded WebViews either way. */}
                        <button
                          type="button"
                          onClick={() => {
                            if (!web && getGoogleNativeLoginConfig() && getDesktopAppApi()?.googleNative) {
                              void handleGoogleNativeLogin();
                              return;
                            }
                            if (!web && getDesktopAppApi()?.google) {
                              void handleGoogleRelayLogin();
                              return;
                            }
                            if (!googleReady) { toast(t("auth.google_pending")); return; }
                            void handleGoogleLogin();
                          }}
                          data-testid="google-login"
                          disabled={googleBusy || googleWaiting}
                          className={providerButtonClass}
                        >
                          <GoogleIcon className="size-4 shrink-0" />
                          <span className="text-sm">{t("auth.google_login")}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (!web && getDesktopAppApi()?.apple) {
                              void handleAppleDesktopLogin();
                            } else {
                              void handleAppleWebLogin();
                            }
                          }}
                          disabled={appleBusy || appleWaiting}
                          className={providerButtonClass}
                        >
                          <AppleIcon className="size-4 shrink-0 text-foreground" />
                          <span className="text-sm">{t("auth.apple_login")}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleAppleWebLogin()}
                          disabled={appleBusy}
                          className={providerButtonClass}
                        >
                          <AppleIcon className="size-4" />
                          <span className="text-sm">{t("auth.apple_login")}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleWechatQrLogin()}
                          className={providerButtonClass}
                        >
                          <WechatIcon className="size-4" />
                          <span className="text-sm">{t("auth.wechat_qr_login")}</span>
                        </button>
                      </>
                    )}
                  </div>
                  <div className={cn("flex items-center gap-3 text-2xs text-muted-foreground/80", web ? "my-4" : "my-3")}>
                    <span className="h-px flex-1 bg-border/60" />
                    <span>{t("auth.or_divider")}</span>
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                </>
              )}

              {step === "account" ? (
                /* ── Step 1: Account Input (Single pill, Muse-style) ── */
                <>
                  <div className="relative flex h-10.5 items-center rounded-full border border-border/50 bg-muted/40 px-3.5 transition-all focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
                    {showDialCode && (
                      <div className="flex items-center">
                        <span className="text-sm font-medium text-foreground/80">+86</span>
                        <span className="mx-2 h-3.5 w-px bg-border/60" />
                      </div>
                    )}
                    <Input
                      type={intl ? "email" : "text"}
                      inputMode={intl ? "email" : "text"}
                      autoComplete={intl ? "email" : "username"}
                      autoCapitalize="none"
                      spellCheck={false}
                      disabled={codeSending}
                      placeholder={intl ? t("auth.email_placeholder") : t("auth.sms_phone_placeholder")}
                      value={account}
                      onChange={(e) => {
                        setAccount(e.target.value);
                        if (smsError) setSmsError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSendCode();
                      }}
                      className="h-full flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 focus-visible:shadow-none"
                    />
                    <button
                      type="button"
                      onClick={handleSendCode}
                      disabled={!target || codeSending}
                      title={t("auth.sms_send_code")}
                      aria-label={t("auth.sms_send_code")}
                      className="ml-2 flex size-7.5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:opacity-90 hover:scale-105 active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
                    >
                      {codeSending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <ArrowRight className="size-3.5" />
                      )}
                    </button>
                  </div>

                  {smsError && (
                    <p className="mt-2 text-center text-xs text-destructive">{smsError}</p>
                  )}

                  <div className={web ? "mt-4" : "mt-3"}>
                    <AgreementCheckbox
                      agreed={agreed}
                      onToggle={() => setAgreed(!agreed)}
                      onLink={handleAgreeLink}
                    />
                  </div>
                </>
              ) : (
                /* ── Step 2: Verification Code Input (Single pill, in-place transition) ── */
                <>
                  <div className="mb-2 flex items-center justify-between px-1 text-2xs text-muted-foreground">
                    <span className="truncate">
                      {t("auth.code_sent_to", { target: maskAccount(codeTarget ?? account) })}
                    </span>
                    <button
                      type="button"
                      disabled={codeSending || smsSubmitting}
                      onClick={() => {
                        setStep("account");
                        setSmsCode("");
                        setSmsError(null);
                      }}
                      className="ml-2 shrink-0 font-medium text-primary hover:underline"
                    >
                      {t("auth.edit_account")}
                    </button>
                  </div>

                  <div className="relative flex h-10.5 items-center rounded-full border border-border/50 bg-muted/40 px-3.5 transition-all focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
                    <Input
                      autoFocus
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      disabled={smsSubmitting}
                      maxLength={SMS_CODE_LENGTH}
                      placeholder={t("auth.sms_code_placeholder")}
                      value={smsCode}
                      onChange={(e) => handleSmsCodeChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSmsLogin();
                      }}
                      className="h-full flex-1 border-0 bg-transparent p-0 text-sm tracking-wider shadow-none focus-visible:ring-0 focus-visible:shadow-none"
                    />
                    <div className="ml-2 flex items-center gap-1.5 shrink-0">
                      {smsSubmitting ? (
                        <Loader2 className="size-4 animate-spin text-primary" />
                      ) : (
                        <button
                          type="button"
                          disabled={codeSending || resendIn > 0}
                          onClick={handleSendCode}
                          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                        >
                          {codeSending
                            ? t("auth.sms_sending")
                            : resendIn > 0
                              ? `${resendIn}s`
                              : t("auth.sms_send_code")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleSmsLogin()}
                        disabled={!isCompleteSmsCode(smsCode) || smsSubmitting}
                        aria-label={t("auth.sms_login_btn")}
                        className="ml-1 flex size-7.5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:opacity-90 hover:scale-105 active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
                      >
                        {smsSubmitting ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <ArrowRight className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {smsError && (
                    <p className="mt-2 text-center text-xs text-destructive">{smsError}</p>
                  )}

                  <div className={web ? "mt-4" : "mt-3"}>
                    <AgreementCheckbox
                      agreed={agreed}
                      onToggle={() => setAgreed(!agreed)}
                      onLink={handleAgreeLink}
                    />
                  </div>
                </>
              )}

              {!web && !intl && (
                waitingNotice ? (
                  <div className="mt-5">{waitingNotice}</div>
                ) : (
                <div className="mt-5">
                  <div className="flex items-center gap-3 text-2xs text-muted-foreground/80">
                    <span className="h-px flex-1 bg-border/60" />
                    <span>{t("auth.or_divider")}</span>
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                  <div className="mt-3.5 grid grid-cols-2 gap-2.5">
                    {/* WeChat Pill Button */}
                    <button
                      type="button"
                      onClick={handleWechatLogin}
                      disabled={wechatWaiting}
                      title={t("auth.wechat_login")}
                      aria-label={t("auth.wechat_login")}
                      className="flex h-9 items-center justify-center gap-2 rounded-full border border-border/50 bg-muted/40 px-3 text-xs font-medium transition-colors hover:bg-muted/80 disabled:opacity-50"
                    >
                      <WechatIcon className="size-4 shrink-0 text-[#07C160]" />
                      <span className="truncate">{t("auth.wechat")}</span>
                    </button>

                    {/* Apple Pill Button */}
                    <button
                      type="button"
                      onClick={() => {
                        if (getDesktopAppApi()?.apple) {
                          void handleAppleDesktopLogin();
                        } else {
                          void handleAppleWebLogin();
                        }
                      }}
                      disabled={appleBusy || appleWaiting}
                      title={t("auth.apple_login")}
                      aria-label={t("auth.apple_login")}
                      className="flex h-9 items-center justify-center gap-2 rounded-full border border-border/50 bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/80 disabled:opacity-50"
                    >
                      <AppleIcon className="size-4 shrink-0 text-foreground" />
                      <span className="truncate">Apple</span>
                    </button>
                  </div>
                </div>
                )
              )}
            </>
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
                  onClick={() => setView(intl ? "email" : "phone")}
                >
                  {t(intl ? "auth.back_to_login" : "auth.back_to_phone")}
                </Button>
            </div>
          </>
        )}

        {error && <p className="mt-3 text-center text-xs text-destructive">{error}</p>}
        {footer && <div className="mt-4 text-center">{footer}</div>}
          </div>
        </div>

        {/* Keep the extra Web sign-in options below the centered form. On
            desktop, waitingNotice already renders inside the compact form so it
            never overflows the 690×450 welcome window. */}
        {web && waitingNotice ? (
          <div className="mt-5">{waitingNotice}</div>
        ) : !hideMoreLogin && web && !intl && activeView === "phone" ? (
          <button
            type="button"
            onClick={() => setView("more")}
            className="mt-5 flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("auth.more_login")}
            <ChevronRight className="size-3" />
          </button>
        ) : !hideMoreLogin && !web && !waitingNotice ? (
          <button
            type="button"
            onClick={() => setView("more")}
            className="sr-only"
            aria-label={t("auth.more_login")}
          >
            {t("auth.more_login")}
          </button>
        ) : null}

        {/* ── Bottom site switcher: small subtle text at bottom ── */}
        {!web && <div className="mt-auto flex items-center justify-center pt-2 pb-1 text-2xs text-muted-foreground/60 select-none">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  disabled={codeSending || smsSubmitting}
                  className="inline-flex items-center gap-1 font-normal text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
                  aria-label={t("auth.server_region")}
                >
                  <span>{t("auth.server_region")}:</span>
                  <span className="font-mono underline underline-offset-2 text-foreground/80">
                    {edition === "cn" ? "lynse.cn" : "lynse.ai"}
                  </span>
                  <ChevronDown className="size-2.5 opacity-60" />
                </button>
              }
            />
            <DropdownMenuContent align="center" side="top" className="w-40 p-1">
              <DropdownMenuItem
                onClick={() => handleSelectEdition("cn")}
                className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs cursor-pointer"
              >
                <div className="flex flex-col">
                  <span className="font-mono font-medium text-foreground">lynse.cn</span>
                  <span className="text-3xs text-muted-foreground">{t("auth.region_cn")}</span>
                </div>
                {edition === "cn" && <Check className="size-3.5 text-primary" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleSelectEdition("intl")}
                className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs cursor-pointer"
              >
                <div className="flex flex-col">
                  <span className="font-mono font-medium text-foreground">lynse.ai</span>
                  <span className="text-3xs text-muted-foreground">{t("auth.region_intl")}</span>
                </div>
                {edition === "intl" && <Check className="size-3.5 text-primary" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>}
      </div>

      {/* ── Right column. Desktop: full-height rounded artwork card, inset on
          all sides like the reference window. Web (lg+): a Notta-login-style
          panel — muted backdrop with the three product storyboards as
          illustration cards (live-text captions + dot indicators, user
          request, 2026-11-18); below lg the column hides and the form takes
          the full width. ── */}
      {web ? (
        <aside
          aria-hidden
          className="relative hidden w-1/2 shrink-0 items-center justify-center overflow-hidden bg-muted/40 px-10 lg:flex"
        >
          <LoginCarousel slides={LOGIN_CAROUSEL_SLIDES_WEB} />
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
