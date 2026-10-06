"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";
import { openExternalUrl } from "../app-update";
import { beginConnectFromUrl } from "./use-connect-flow";
import { pollFeishuAppSetup, reuseFeishuAppSetup, startFeishuAppSetup } from "@lynse/core/integrations";
import { errorCopy } from "./provider-row";
import type { IntegrationsProvider } from "@lynse/core/integrations";

/**
 * Guided first-time bind for the Feishu providers (Model B).
 *
 * Step 1 — creation is automatic: the backend mints a Feishu confirmation URL
 * (device-code registration); the user confirms and the created app's
 * credentials flow server-side into the user-token authorization.
 *
 * Step 2 — the one manual step Feishu forces on every new app: the OAuth
 * redirect URL has no OpenAPI ([docs]) and must be pasted once in the app
 * console's security settings. This step shows the URL with a copy button and
 * deep-links the console, then hands off to the authorize page.
 */
interface FeishuSetupDialogProps {
  provider: IntegrationsProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ReadyHandoff {
  oauthState: string;
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  grantUrl: string | null;
}

export function FeishuSetupDialog({ provider, open, onOpenChange }: FeishuSetupDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"starting" | "waiting" | "configure_redirect" | "error">("starting");
  const [error, setError] = useState<unknown>(null);
  const [handoff, setHandoff] = useState<ReadyHandoff | null>(null);
  const setupStateRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const start = useCallback(async () => {
    setPhase("starting");
    setError(null);
    setHandoff(null);
    stopPolling();
    // An org app may already exist from an earlier half-finished bind — skip
    // straight to its (re-minted) authorization instead of creating another.
    try {
      const reuse = await reuseFeishuAppSetup();
      if (reuse.authorization_url && reuse.oauth_state) {
        if (reuse.redirect_configured) {
          onOpenChange(false);
          beginConnectFromUrl(provider, reuse.oauth_state, reuse.authorization_url);
          return;
        }
        setHandoff({
          oauthState: reuse.oauth_state,
          authorizationUrl: reuse.authorization_url,
          clientId: reuse.client_id ?? "",
          redirectUri: reuse.redirect_uri ?? "https://www.lynse.ai/oc/oauth/callback",
          grantUrl: reuse.permission_grant_url ?? null,
        });
        setPhase("configure_redirect");
        return;
      }
    } catch {
      // No saved app (409) or transient failure — fall through to creation.
    }
    try {
      const setup = await startFeishuAppSetup();
      setupStateRef.current = setup.state;
      setPhase("waiting");
      openExternalUrl(setup.url);
      timerRef.current = setInterval(() => {
        void (async () => {
          const state = setupStateRef.current;
          if (!state) return;
          try {
            const poll = await pollFeishuAppSetup(state);
            if (poll.status === "ready" && poll.authorization_url && poll.oauth_state) {
              stopPolling();
              if (poll.redirect_configured) {
                // Callback registered automatically — nothing left to paste.
                onOpenChange(false);
                beginConnectFromUrl(provider, poll.oauth_state, poll.authorization_url);
                return;
              }
              setHandoff({
                oauthState: poll.oauth_state,
                authorizationUrl: poll.authorization_url,
                clientId: poll.client_id ?? "",
                redirectUri: poll.redirect_uri ?? "https://www.lynse.ai/oc/oauth/callback",
                grantUrl: poll.permission_grant_url ?? null,
              });
              setPhase("configure_redirect");
            } else if (poll.status === "error") {
              stopPolling();
              setPhase("error");
              setError(new Error(poll.error ?? "error.integrations.auth_failed"));
            }
          } catch {
            // Transient poll failure — keep waiting until expiry.
          }
        })();
      }, 4000);
    } catch (e) {
      setPhase("error");
      setError(e);
    }
  }, [provider]);

  useEffect(() => {
    if (open) void start();
    return stopPolling;
  }, [open, start]);

  // After the admin grants the app-identity scope, re-run the reuse round:
  // the backend re-attempts the callback PATCH (now permitted) and mints a
  // FRESH authorize URL. Continuing on the pre-grant URL would bounce with
  // 20029, since its redirect was never configured.
  const continueAuthorize = useCallback(async () => {
    if (!handoff) return;
    setPhase("starting");
    try {
      const reuse = await reuseFeishuAppSetup();
      if (reuse.authorization_url && reuse.oauth_state) {
        if (reuse.redirect_configured) {
          onOpenChange(false);
          beginConnectFromUrl(provider, reuse.oauth_state, reuse.authorization_url);
          return;
        }
        setHandoff({
          oauthState: reuse.oauth_state,
          authorizationUrl: reuse.authorization_url,
          clientId: reuse.client_id ?? "",
          redirectUri: reuse.redirect_uri ?? "https://www.lynse.ai/oc/oauth/callback",
          grantUrl: reuse.permission_grant_url ?? null,
        });
        setPhase("configure_redirect");
        return;
      }
    } catch {
      // fall through to the stale-URL attempt below rather than dead-ending
    }
    onOpenChange(false);
    beginConnectFromUrl(provider, handoff.oauthState, handoff.authorizationUrl);
  }, [handoff, onOpenChange, provider]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("connections.feishu_setup.title")}</DialogTitle>
          <DialogDescription className="text-2xs">
            {phase === "configure_redirect"
              ? t("connections.feishu_setup.grant_body")
              : t("connections.feishu_setup.body")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {(phase === "starting" || phase === "waiting") && (
            <p className="flex items-center gap-2 text-2xs text-muted-foreground">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              {t("connections.feishu_setup.waiting")}
            </p>
          )}

          {phase === "configure_redirect" && handoff && (
            <>
              {handoff.grantUrl && (
                <Button
                  type="button"
                  size="sm"
                  className="h-7 w-full text-2xs"
                  onClick={() => openExternalUrl(handoff.grantUrl!)}
                >
                  {t("connections.feishu_setup.grant_open")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-full text-2xs"
                onClick={() => void continueAuthorize()}
              >
                {t("connections.feishu_setup.grant_done")}
              </Button>
            </>
          )}

          {phase === "error" && (
            <>
              <p className="text-2xs text-destructive">{errorCopy(error, t)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-full text-2xs"
                onClick={() => void start()}
              >
                {t("connections.feishu_setup.reopen")}
              </Button>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-2xs"
            onClick={() => onOpenChange(false)}
          >
            {t("connections.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
