"use client";

import { useEffect, useState } from "react";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import { LYNSE_EDITION } from "@lynse/core/config";
import { isValidEmail, sendEmailCaptcha } from "@lynse/core/auth/email";
import { api, ApiError } from "@lynse/core/api";
import {
  SMS_CODE_LENGTH,
  SMS_RESEND_DEFAULT_SECONDS,
  cooldownSecondsFromError,
  isCompleteSmsCode,
  isValidChinaPhone,
  sendSmsCaptcha,
} from "@lynse/core/auth/sms";
import {
  bindThirdPartyPhone,
  isWechatBindRequired,
  type WechatLoginVo,
} from "@lynse/core/auth/wechat";
import { authErrorText } from "./auth-errors";
import { Loader2 } from "../icons";

/**
 * Binding form for a first-time third-party sign-in (Google/Apple/WeChat).
 * The backend responds with `isNeedBind` when the identity has no account
 * linked yet; this form collects the binding credential and completes the
 * login through `GET /api/auth/bind`. The credential depends on the edition:
 * intl (www.lynse.ai) binds an email + email code, cn (www.lynse.cn) binds a
 * China phone + SMS code. Shared by the login page and OAuth callback pages.
 */
export function WechatBindForm({
  thirdPartyId,
  authType = "WECHAT_SCAN",
  channel = LYNSE_EDITION === "intl" ? "email" : "phone",
  agreed,
  onBound,
}: {
  /** `thirdPartyId` from the bind-required login response. */
  thirdPartyId: string;
  /** Identity provider — GOOGLE / APPLE / WECHAT_SCAN (backend selects the
   *  identity by authType, not EMAIL_CODE). */
  authType?: string;
  /** intl binds an email, cn binds a China phone; defaults to the edition. */
  channel?: "email" | "phone";
  /** Agreement gate owned by the host page. */
  agreed: boolean;
  /** Called with the session-carrying response after a successful bind. */
  onBound: (vo: WechatLoginVo) => void;
}) {
  const { t } = useTranslation();
  const intl = channel === "email";
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [captchaCode, setCaptchaCode] = useState("");
  const [codeSending, setCodeSending] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const target = intl ? email.trim() : phone.trim();
    const valid = intl ? isValidEmail(target) : isValidChinaPhone(target);
    if (!valid || codeSending || resendIn > 0) return;
    setError(null);
    setCodeSending(true);
    try {
      const res = intl
        ? await sendEmailCaptcha(target, { actionType: "BIND" })
        : await sendSmsCaptcha(target, { actionType: "BIND" });
      if (res.success) {
        setResendIn(res.cooldown > 0 ? res.cooldown : SMS_RESEND_DEFAULT_SECONDS);
      } else {
        if (res.cooldown > 0) setResendIn(res.cooldown);
        setError(t("auth.sms_send_failed"));
      }
    } catch (e: unknown) {
      const wait = cooldownSecondsFromError(e);
      if (wait) setResendIn(wait);
      setError(authErrorText(e, t, "auth.sms_send_failed"));
    } finally {
      setCodeSending(false);
    }
  }

  async function handleSubmit() {
    const target = intl ? email.trim() : phone.trim();
    const valid = intl ? isValidEmail(target) : isValidChinaPhone(target);
    if (!agreed || !valid || !isCompleteSmsCode(captchaCode) || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const vo = await bindThirdPartyPhone({
        authType,
        thirdPartyId,
        phone: target,
        captchaCode,
      });
      if (!vo.token || isWechatBindRequired(vo)) {
        console.warn("[wechat-bind] missing session", {
          server: api().getBaseUrl(),
          hasToken: !!vo.token,
          needsBind: isWechatBindRequired(vo),
        });
        setError(t("auth.wechat_bind_failed"));
        return;
      }
      onBound(vo);
    } catch (e: unknown) {
      // Log only public server/error metadata, never the phone, SMS code or identity.
      console.warn("[wechat-bind] request failed", {
        server: api().getBaseUrl(),
        status: e instanceof ApiError ? e.status : null,
        code: e instanceof Error && /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(e.message)
          ? e.message : "unavailable",
      });
      setError(authErrorText(e, t, "auth.wechat_bind_failed"));
    } finally {
      setSubmitting(false);
    }
  }

  const target = intl ? email.trim() : phone.trim();
  const targetValid = intl ? isValidEmail(target) : isValidChinaPhone(target);
  const sendCodeDisabled = !targetValid || codeSending || resendIn > 0;
  const submitDisabled =
    !agreed || !targetValid || !isCompleteSmsCode(captchaCode) || submitting;

  return (
    <div className="w-full space-y-3">
      <div className="space-y-1 text-center">
        <h2 className="text-sm font-medium">
          {t(intl ? "auth.bind_email_title" : "auth.wechat_bind_title")}
        </h2>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t(intl ? "auth.bind_email_hint" : "auth.wechat_bind_hint")}
        </p>
      </div>

      {/* Intl binds an email address; cn keeps the +86 phone pill. */}
      {intl ? (
        <Input
          inputMode="email"
          autoComplete="email"
          placeholder={t("auth.email_placeholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
          }}
          className="border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 focus-visible:shadow-none rounded-none"
        />
      ) : (
        <div className="flex h-9 items-center gap-3 rounded-full bg-muted px-3.5">
          <span className="text-sm text-foreground">+86</span>
          <span className="h-4 w-px shrink-0 bg-border" />
          <Input
            inputMode="numeric"
            autoComplete="tel"
            placeholder={t("auth.sms_phone_placeholder")}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
            className="flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 focus-visible:shadow-none rounded-none"
          />
        </div>
      )}

      <div className="relative">
        <Input
          inputMode="numeric"
          maxLength={SMS_CODE_LENGTH}
          placeholder={t("auth.sms_code_placeholder")}
          value={captchaCode}
          onChange={(e) =>
            setCaptchaCode(e.target.value.replace(/\D/g, "").slice(0, SMS_CODE_LENGTH))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
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

      <Button
        size="sm"
        className="h-9 w-full rounded-full text-sm font-medium"
        disabled={submitDisabled}
        onClick={handleSubmit}
      >
        {submitting && <Loader2 className="size-4 animate-spin" />}
        {t("auth.wechat_bind_submit")}
      </Button>
      {error && <p className="text-center text-xs text-destructive">{error}</p>}
    </div>
  );
}
