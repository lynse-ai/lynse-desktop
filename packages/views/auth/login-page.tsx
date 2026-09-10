"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Card, CardContent } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
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
import { useNavigation } from "../navigation";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";
import { getDesktopAppApi, openExternalUrl } from "../app-update";
import { hasPasswordlessAuth } from "../feature-flags";
import { WechatIcon } from "./wechat-icon";
import { authErrorText } from "./auth-errors";

/** Login QR panel phases. "expired"/"error" offer a manual refresh. */
type QrPhase = "creating" | "ready" | "scanned" | "expired" | "error";

/**
 * Startup login page, shown by the AuthGate before any session exists.
 *
 * The layout is identical on both build channels; the card content differs:
 *  - "testflight": app-scanned QR code sign-in, divider, WeChat QR sign-in.
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

  // QR channel (testflight build): create a challenge, show its QR, then
  // poll until the Lynse mobile app scans + confirms it.
  const completeLogin = useAuthStore((s) => s.completeLogin);
  const [qrPhase, setQrPhase] = useState<QrPhase>("creating");
  const [qrPayload, setQrPayload] = useState("");
  const qrCancelledRef = useRef(false);

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
        setError(e instanceof Error && e.message ? e.message : null);
      }
    }
  }, [completeLogin]);

  useEffect(() => {
    if (!passwordless) return;
    startQrLogin();
    return () => {
      qrCancelledRef.current = true;
    };
  }, [passwordless, startQrLogin]);

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

  const qrHint =
    qrPhase === "scanned"
      ? t("auth.qr_scanned")
      : qrPhase === "expired"
        ? t("auth.qr_expired")
        : qrPhase === "error"
          ? t("auth.qr_failed")
          : t("auth.qr_login_hint");
  const qrDimmed = qrPhase === "expired" || qrPhase === "error";

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
                {/* ── App-scanned QR code sign-in ──────────── */}
                <p className="text-center text-xs font-medium">
                  {t("auth.qr_login")}
                </p>
                <div className="relative mx-auto flex size-[184px] items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/30">
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
                        {qrPhase === "expired"
                          ? t("auth.qr_refresh")
                          : t("auth.qr_retry")}
                      </Button>
                    </div>
                  )}
                  {qrPhase === "creating" && (
                    <p className="absolute bottom-2 text-2xs text-muted-foreground">
                      {t("auth.qr_creating")}
                    </p>
                  )}
                </div>
                <p className="text-center text-2xs leading-relaxed text-muted-foreground">
                  {qrHint}
                </p>

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
