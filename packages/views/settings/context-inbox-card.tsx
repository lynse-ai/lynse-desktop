"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";
import {
  ApiError, GLOBAL_CONTEXT_SCOPE, api, deviceTimeZone, getContextIdentity, getContextPreferences, setContextPreferences,
} from "@lynse/core/api";
import type { ContextPreferences, ContextPreferencesChange } from "@lynse/core/api";
import { useTranslation } from "@lynse/core/i18n/react";
import { BetaBadge } from "../beta-badge";
import { useNotificationStore } from "../notifications/use-notification-store";
import {
  getContextInboxEnabled, setContextInboxEnabled, useContextInboxEnabled,
} from "../notifications/context-inbox-preferences";

function sessionStillCurrent(token: string, userId: string): boolean {
  const auth = getAuthStore()?.getState();
  return api().getToken() === token && !!auth?.isAuthenticated && (!auth.user?.id || auth.user.id === userId);
}

/**
 * The switch is the consent: it writes the cloud grant (scope `global`, device
 * timezone) or stops it, and mirrors the server state into the per-device flag
 * that gates the inbox poller. No chat confirmation card is involved.
 */
export function ContextInboxCard() {
  const { t } = useTranslation();
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id || null);
  const enabled = useContextInboxEnabled(authenticated ? userId : null);
  const syncUnavailable = useNotificationStore((s) => s.contextUnavailable);
  const [grantVersion, setGrantVersion] = useState<number | null>(null);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // Account whose grant this card has already read or written; a toggle that
  // resolved a profile-less session must not trigger a second read.
  const reconciled = useRef<string | null>(null);

  // The server grant is the source of truth across devices; the local flag
  // only decides whether this device polls. Reconcile when the card opens.
  useEffect(() => {
    const token = api().getToken();
    if (!authenticated || !userId || !token || reconciled.current === userId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const prefs = await getContextPreferences(token, controller.signal);
        if (controller.signal.aborted || !sessionStillCurrent(token, userId)) return;
        reconciled.current = userId;
        setGrantVersion(prefs.grant_version);
        setServiceUnavailable(false);
        if (getContextInboxEnabled(userId) !== prefs.enabled) setContextInboxEnabled(userId, prefs.enabled);
      } catch (cause) {
        if (controller.signal.aborted || api().getToken() !== token) return;
        if (cause instanceof ApiError && cause.status === 503) setServiceUnavailable(true);
      }
    })();
    return () => controller.abort();
  }, [authenticated, userId]);

  async function writeGrant(checked: boolean, token: string): Promise<ContextPreferences> {
    const change: ContextPreferencesChange = checked
      ? { action: "set", enabled: true, scopes: [GLOBAL_CONTEXT_SCOPE], timezone: deviceTimeZone() }
      : { action: "stop" };
    const base = grantVersion ?? (await getContextPreferences(token)).grant_version;
    try {
      return await setContextPreferences(change, base, token, crypto.randomUUID());
    } catch (cause) {
      // Another device changed the grant in between: re-read once and retry.
      if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
      const current = await getContextPreferences(token);
      return await setContextPreferences(change, current.grant_version, token, crypto.randomUUID());
    }
  }

  async function update(checked: boolean) {
    const token = api().getToken();
    if (!authenticated || !token || busy) return;
    setBusy(true);
    setError(false);
    try {
      // Restored/API-key sessions can lack a profile. Resolve only on the
      // explicit toggle, never by polling a disabled inbox to obtain identity.
      const resolved = userId ?? (await getContextIdentity(token)).user_id;
      if (!sessionStillCurrent(token, resolved)) return;
      const saved = await writeGrant(checked, token);
      if (!sessionStillCurrent(token, resolved)) return;
      reconciled.current = resolved;
      setGrantVersion(saved.grant_version);
      setServiceUnavailable(false);
      setContextInboxEnabled(resolved, saved.enabled);
      const auth = getAuthStore()?.getState();
      if (auth && !auth.user?.id) auth.setUser({ id: resolved, name: "", email: "" });
    } catch (cause) {
      if (api().getToken() !== token) return;
      if (cause instanceof ApiError && cause.status === 503) setServiceUnavailable(true);
      else setError(true);
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          {t("settings.context_inbox_title")}
          <BetaBadge />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="context-inbox-enable" className="text-xs">{t("settings.context_inbox_enable")}</Label>
          <Switch id="context-inbox-enable" checked={enabled} disabled={!authenticated || busy || serviceUnavailable}
            aria-describedby="context-inbox-hint" onCheckedChange={(checked) => void update(checked)} />
        </div>
        <p id="context-inbox-hint" className="text-2xs leading-relaxed text-muted-foreground">{t("settings.context_inbox_hint")}</p>
        {!authenticated && <p className="text-2xs text-muted-foreground">{t("settings.context_inbox_sign_in")}</p>}
        {serviceUnavailable && <p role="status" className="text-2xs text-muted-foreground">{t("settings.context_inbox_service_unavailable")}</p>}
        {enabled && syncUnavailable && <p role="status" className="text-2xs text-muted-foreground">{t("notifications.context_sync_unavailable")}</p>}
        {error && <p role="alert" className="text-2xs text-destructive">{t("settings.context_inbox_save_failed")}</p>}
      </CardContent>
    </Card>
  );
}
