"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { getDesktopFeishuAuthApi, type FeishuAuthState } from "./feishu-auth";

export function FeishuAuthCard() {
  const api = getDesktopFeishuAuthApi();
  const { t, i18n } = useTranslation();
  const [auth, setAuth] = useState<FeishuAuthState | null>(null);
  const [busy, setBusy] = useState<"authorize" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .getState()
      .then((state) => {
        if (!cancelled) setAuth(state);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!api) return null;

  async function authorize() {
    if (!api) return;
    setBusy("authorize");
    setError(null);
    try {
      setAuth(await api.authorize());
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!api) return;
    setBusy("disconnect");
    setError(null);
    try {
      setAuth(await api.disconnect());
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  const account = auth?.account;
  const accountEmail = account?.enterpriseEmail || account?.email;
  const expiresAt = auth?.accessTokenExpiresAt
    ? new Date(auth.accessTokenExpiresAt).toLocaleString(i18n.language)
    : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("settings.feishu_auth")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.feishu_auth_hint")}
        </p>

        {account ? (
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
            {account.avatarUrl ? (
              <img
                src={account.avatarUrl}
                alt={account.name}
                className="size-10 shrink-0 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                {account.name.slice(0, 2)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">{account.name}</p>
                <span
                  className={
                    auth?.authorized
                      ? "text-[10px] text-primary"
                      : "text-[10px] text-destructive"
                  }
                >
                  {auth?.authorized
                    ? t("settings.feishu_authorized")
                    : t("settings.feishu_expired")}
                </span>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                {accountEmail || account.openId}
              </p>
              {expiresAt && (
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
                  {t("settings.feishu_expires_at")}: {expiresAt}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/30 p-3 text-[11px] text-muted-foreground">
            {auth?.configured
              ? t("settings.feishu_ready")
              : t("settings.feishu_not_configured")}
          </div>
        )}

        {auth?.redirectUri && (
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground">
              {t("settings.feishu_redirect_uri")}
            </p>
            <code className="block select-all overflow-x-auto rounded bg-muted px-2 py-1.5 text-[10px] text-muted-foreground">
              {auth.redirectUri}
            </code>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={authorize}
            disabled={!auth?.configured || busy !== null}
          >
            {busy === "authorize"
              ? t("settings.feishu_authorizing")
              : account
                ? t("settings.feishu_reauthorize")
                : t("settings.feishu_authorize")}
          </Button>
          {account && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={disconnect}
              disabled={busy !== null}
            >
              {t("settings.feishu_disconnect")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
