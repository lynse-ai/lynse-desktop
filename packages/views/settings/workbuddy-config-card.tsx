"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import {
  getWorkBuddyProfile,
  getWorkBuddyToken,
  isWorkBuddyNotBoundError,
  pollWorkBuddyAuthorization,
  startWorkBuddyAuthorization,
  WORKBUDDY_ERROR,
  WorkBuddyPollTimeoutError,
  type WorkBuddyProfile,
  type WorkBuddyTokenInfo,
} from "@lynse/core/auth/workbuddy";
import { Briefcase, Loader2, RefreshCw } from "../icons";
import { getDesktopAppApi, openExternalUrl } from "../app-update";

/**
 * Structured error copy rendered with the real `t` so interpolation params
 * survive (the Feishu card's registerError uses the same shape). Known dotted
 * server keys map to dedicated lines; everything else interpolates the raw
 * message into the fallback, which carries an {{error}} slot.
 */
type WorkBuddyErrorCopy = { key: string; params?: Record<string, unknown> };

function workbuddyErrorCopy(error: unknown, fallbackKey: string): WorkBuddyErrorCopy {
  if (error instanceof WorkBuddyPollTimeoutError) return { key: "workbuddy.err_timeout" };
  const raw = error instanceof Error && error.message ? error.message.trim() : "";
  switch (raw) {
    case WORKBUDDY_ERROR.CONFIG_INVALID:
      return { key: "workbuddy.err_config_invalid" };
    case WORKBUDDY_ERROR.EXCHANGE_FAILED:
      return { key: "workbuddy.err_exchange_failed" };
    case WORKBUDDY_ERROR.STATE_INVALID:
      return { key: "workbuddy.err_state_invalid" };
    case WORKBUDDY_ERROR.NOT_BOUND:
      return { key: "workbuddy.err_not_bound" };
    case WORKBUDDY_ERROR.TOKEN_EXPIRED:
      return { key: "workbuddy.err_token_expired" };
    case WORKBUDDY_ERROR.CALLBACK_FAILED:
      return { key: "workbuddy.err_callback_failed" };
    case "system.error.busy":
      return { key: "workbuddy.err_server_busy" };
    default:
      return { key: fallbackKey, params: { error: raw } };
  }
}

/** WorkBuddy authorization status and (re-)authorization entry. The flow runs
 *  in the system browser; this card polls the backend until the ticket shows
 *  up, then keeps the ticket details for display. */
export function WorkBuddyConfigCard() {
  const { t } = useTranslation();
  const isDesktop = !!getDesktopAppApi();
  const [info, setInfo] = useState<WorkBuddyTokenInfo | null>(null);
  /** WorkBuddy user profile (nickname/avatar), loaded when bound. */
  const [profile, setProfile] = useState<WorkBuddyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<WorkBuddyErrorCopy | null>(null);
  /** Non-null while the browser authorization is in flight and being polled. */
  const [authorizing, setAuthorizing] = useState(false);
  const cancelPollRef = useRef(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInfo(await getWorkBuddyToken());
    } catch (e: unknown) {
      // Unbound is the normal first-run state, not an error.
      if (isWorkBuddyNotBoundError(e)) {
        setInfo({ authorized: false });
      } else {
        setError(workbuddyErrorCopy(e, "workbuddy.status_refresh_failed"));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Profile rides on the same ticket; refetch whenever the binding changes
  // (first load, re-authorize, disconnect). Failure just hides the row.
  useEffect(() => {
    if (!info?.authorized) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    getWorkBuddyProfile()
      .then((profile) => {
        if (!cancelled) setProfile(profile);
      })
      .catch((error: unknown) => {
        console.warn("[workbuddy] profile fetch failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [info?.authorized, info?.accessToken]);

  // Leaving the settings page cancels a running poll.
  useEffect(
    () => () => {
      cancelPollRef.current = true;
    },
    [],
  );

  async function handleAuthorize() {
    if (authorizing || loading) return;
    setError(null);
    try {
      const { authorizeUrl } = await startWorkBuddyAuthorization();
      if (isDesktop) {
        // The authorize page must open outside the app shell.
        openExternalUrl(authorizeUrl);
      } else {
        window.open(authorizeUrl, "_blank", "noopener");
      }
      setAuthorizing(true);
      cancelPollRef.current = false;
      try {
        const result = await pollWorkBuddyAuthorization({
          isCancelled: () => cancelPollRef.current,
        });
        setInfo(result);
        toast.success(t("workbuddy.authorize_success"));
      } catch (e: unknown) {
        if (!cancelPollRef.current) {
          setError(workbuddyErrorCopy(e, "workbuddy.err_failed"));
        }
      } finally {
        setAuthorizing(false);
      }
    } catch (e: unknown) {
      setError(workbuddyErrorCopy(e, "workbuddy.err_failed"));
    }
  }

  function handleCancelAuthorize() {
    cancelPollRef.current = true;
    setAuthorizing(false);
  }

  const bound = !!info?.authorized;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <Briefcase className="size-3.5" />
          {t("workbuddy.title")}
          <span
            className={
              bound
                ? "ms-auto rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary"
                : "ms-auto rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground"
            }
          >
            {bound ? t("workbuddy.status_bound") : t("workbuddy.status_unbound")}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xs leading-relaxed text-muted-foreground">{t("workbuddy.hint")}</p>

        {error && (
          <p className="text-2xs leading-relaxed text-destructive">
            {t(error.key, error.params)}
          </p>
        )}

        {authorizing && (
          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {t("workbuddy.authorize_waiting")}
          </p>
        )}

        {bound && info && (
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
            {(profile?.nickname || profile?.avatar) && (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {t("workbuddy.nickname_label")}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-2xs">
                  {profile?.avatar && (
                    <img
                      src={profile.avatar}
                      alt=""
                      className="size-4 shrink-0 rounded-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <span className="truncate">{profile?.nickname || "—"}</span>
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-2xs text-muted-foreground">
                {t("workbuddy.account_label")}
              </span>
              <span className="truncate text-2xs">{info.openId || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-2xs text-muted-foreground">
                {t("workbuddy.scope_label")}
              </span>
              <span className="truncate text-2xs">{info.scope || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-2xs text-muted-foreground">
                {t("workbuddy.expires_label")}
              </span>
              <span className="truncate text-2xs">{info.expiresAt || "—"}</span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          {authorizing ? (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleCancelAuthorize}>
              {t("workbuddy.authorize_cancel")}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={handleAuthorize}
              disabled={loading}
            >
              {bound ? t("workbuddy.reauthorize") : t("workbuddy.authorize")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => void loadStatus()}
            disabled={loading || authorizing}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t("workbuddy.refresh")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
