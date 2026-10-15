"use client";

import { useEffect, useState } from "react";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  SMS_CODE_LENGTH,
  SMS_RESEND_DEFAULT_SECONDS,
  cooldownSecondsFromError,
  isCompleteSmsCode,
  isValidChinaPhone,
  sendSmsCaptcha,
} from "@lynse/core/auth/sms";
import {
  bindWechatPhone,
  isWechatBindRequired,
  type WechatLoginVo,
} from "@lynse/core/auth/wechat";
import { authErrorText } from "./auth-errors";
import { Loader2 } from "../icons";

/**
 * Phone + SMS binding form for a first-time WeChat sign-in. The backend's
 * WECHAT_JUMP login responds with a bind-required marker instead of a token
 * when the scanned WeChat identity has no phone linked yet; this form collects
 * the phone number, texts a code (`actionType: "BIND"`), and completes the
 * login through `GET /api/auth/bind`. Shared by the desktop login page and
 * the web WeChat callback page.
 */
export function WechatBindForm({
  thirdPartyId,
  agreed,
  onBound,
}: {
  /** `thirdPartyId` from the bind-required login response. */
  thirdPartyId: string;
  /** Agreement gate owned by the host page (the login page shares its
   *  checkbox; the callback page is always agreed). */
  agreed: boolean;
  /** Called with the session-carrying response after a successful bind. */
  onBound: (vo: WechatLoginVo) => void;
}) {
  const { t } = useTranslation();
  const [phone, setPhone] = useState("");
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
    if (!isValidChinaPhone(phone) || codeSending || resendIn > 0) return;
    setError(null);
    setCodeSending(true);
    try {
      const res = await sendSmsCaptcha(phone.trim(), { actionType: "BIND" });
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
    if (
      !agreed ||
      !isValidChinaPhone(phone) ||
      !isCompleteSmsCode(captchaCode) ||
      submitting
    )
      return;
    setError(null);
    setSubmitting(true);
    try {
      const vo = await bindWechatPhone({
        thirdPartyId,
        phone: phone.trim(),
        captchaCode,
      });
      if (!vo.token || isWechatBindRequired(vo)) {
        setError(t("auth.wechat_bind_failed"));
        return;
      }
      onBound(vo);
    } catch (e: unknown) {
      setError(authErrorText(e, t, "auth.wechat_bind_failed"));
    } finally {
      setSubmitting(false);
    }
  }

  const sendCodeDisabled = !isValidChinaPhone(phone) || codeSending || resendIn > 0;
  const submitDisabled =
    !agreed || !isValidChinaPhone(phone) || !isCompleteSmsCode(captchaCode) || submitting;

  return (
    <div className="w-full space-y-3">
      <div className="space-y-1 text-center">
        <h2 className="text-sm font-medium">{t("auth.wechat_bind_title")}</h2>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t("auth.wechat_bind_hint")}
        </p>
      </div>

      {/* Same pill-input treatment as the phone sign-in form. */}
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
