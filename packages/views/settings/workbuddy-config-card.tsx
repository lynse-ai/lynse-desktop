"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import {
  clearWorkBuddyTokenCache,
  getWorkBuddyProfile,
  getWorkBuddyToken,
  isWorkBuddyNotBoundError,
  runWorkBuddyAuthorization,
  workbuddyErrorCopy,
  type WorkBuddyProfile,
  type WorkBuddyTokenInfo,
} from "@lynse/core/auth/workbuddy";
import { hasWorkBuddyCloudScopes } from "@lynse/core/workbuddy";
import { Loader2, RefreshCw, WorkBuddy } from "../icons";
import { getDesktopAppApi, openExternalUrl } from "../app-update";

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
  const [error, setError] = useState<ReturnType<typeof workbuddyErrorCopy> | null>(null);
  /** Non-null while the browser authorization is in flight and being polled. */
  const [authorizing, setAuthorizing] = useState(false);
  const [stateReset, setStateReset] = useState(false);
  const authorizeAttemptRef = useRef(0);
  const statusReadRef = useRef(0);

  const loadStatus = useCallback(async () => {
    const read = ++statusReadRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await getWorkBuddyToken();
      if (statusReadRef.current !== read) return;
      setInfo(result);
      setStateReset(false);
    } catch (e: unknown) {
      if (statusReadRef.current !== read) return;
      // Unbound is the normal first-run state, not an error.
      if (isWorkBuddyNotBoundError(e)) {
        setInfo({ authorized: false });
      } else {
        setError(workbuddyErrorCopy(e, "workbuddy.status_refresh_failed"));
      }
    } finally {
      if (statusReadRef.current === read) setLoading(false);
    }
  }, []);

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
      authorizeAttemptRef.current += 1;
      statusReadRef.current += 1;
    },
    [],
  );

  async function handleAuthorize() {
    if (authorizing || loading) return;
    setError(null);
    setAuthorizing(true);
    const attempt = ++authorizeAttemptRef.current;
    try {
      // The shared runner snapshots the current binding first and the poll
      // only resolves once that fingerprint moves — a stale pre-existing
      // grant can no longer be mistaken for a completed re-consent.
      const result = await runWorkBuddyAuthorization({
        cloud: isDesktop,
        openUrl: (url) => {
          if (isDesktop) {
            // The authorize page must open outside the app shell.
            openExternalUrl(url);
          } else {
            window.open(url, "_blank", "noopener");
          }
        },
        isCancelled: () => authorizeAttemptRef.current !== attempt,
      });
      if (authorizeAttemptRef.current !== attempt) return;
      setInfo(result);
      setStateReset(false);
      if (isDesktop && !hasWorkBuddyCloudScopes(result.scope)) {
        toast.error(t("workbuddy.cloud_scope_required"));
      } else toast.success(t("workbuddy.authorize_success"));
    } catch (e: unknown) {
      if (authorizeAttemptRef.current === attempt) {
        setError(workbuddyErrorCopy(e, "workbuddy.err_failed"));
      }
    } finally {
      if (authorizeAttemptRef.current === attempt) setAuthorizing(false);
    }
  }

  function handleCancelAuthorize() {
    authorizeAttemptRef.current += 1;
    setAuthorizing(false);
  }

  function handleResetState() {
    authorizeAttemptRef.current += 1;
    statusReadRef.current += 1;
    clearWorkBuddyTokenCache();
    setAuthorizing(false);
    setLoading(false);
    setInfo(null);
    setProfile(null);
    setError(null);
    setStateReset(true);
  }

  const bound = !!info?.authorized;
  const needsCloudScope = isDesktop && bound && !hasWorkBuddyCloudScopes(info?.scope);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <WorkBuddy className="size-3.5" />
          {t("workbuddy.title")}
          <span
            className={
              bound
                ? "ms-auto rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary"
                : "ms-auto rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground"
            }
          >
            {stateReset ? t("workbuddy.status_reset") : needsCloudScope ? t("workbuddy.status_scope_required") : bound ? t("workbuddy.status_bound") : t("workbuddy.status_unbound")}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xs leading-relaxed text-muted-foreground">{t("workbuddy.hint")}</p>
        {stateReset && <p role="status" className="text-2xs leading-relaxed text-muted-foreground">{t("workbuddy.reset_hint")}</p>}
        {needsCloudScope && <p className="text-2xs leading-relaxed text-destructive">{t("workbuddy.cloud_scope_required")}</p>}

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
                  {profile?.avatar ? (
                    <img
                      src={profile.avatar}
                      alt=""
                      className="size-4 shrink-0 rounded-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    // No avatar on the WorkBuddy side (API returns "") — show
                    // the nickname initial so the slot stays visible.
                    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[8px] font-semibold leading-none text-primary">
                      {(profile?.nickname ?? "W").slice(0, 1).toUpperCase()}
                    </span>
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

        <div className="flex flex-wrap items-center gap-2">
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
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={handleResetState}>
            {t("workbuddy.reset_state")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
