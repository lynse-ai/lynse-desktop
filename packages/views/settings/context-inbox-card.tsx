"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";
import { api, getContextIdentity } from "@lynse/core/api";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { BetaBadge } from "../beta-badge";
import { useChatStore } from "../workspace/hooks/use-chat-store";
import { useNotificationStore } from "../notifications/use-notification-store";
import { setContextInboxEnabled, useContextInboxEnabled } from "../notifications/context-inbox-preferences";

export function ContextInboxCard({ onOpenChat }: { onOpenChat: () => void }) {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id || null);
  const enabled = useContextInboxEnabled(authenticated ? userId : null);
  const unavailable = useNotificationStore((s) => s.contextUnavailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function update(checked: boolean) {
    const token = api().getToken();
    if (!authenticated || !token || busy) return;
    setBusy(true);
    setError(false);
    try {
      // Restored/API-key sessions can lack a profile. Resolve only on the
      // explicit opt-in, never by polling a disabled inbox to obtain identity.
      const resolved = userId ?? (await getContextIdentity(token)).user_id;
      const auth = getAuthStore()?.getState();
      if (api().getToken() !== token || !auth?.isAuthenticated
        || (auth.user?.id && auth.user.id !== resolved)) return;
      setContextInboxEnabled(resolved, checked);
      if (!auth.user?.id) auth.setUser({ id: resolved, name: "", email: "" });
    } catch {
      if (api().getToken() === token) setError(true);
    } finally { setBusy(false); }
  }

  function configureReview() {
    if (!userId || !enabled) return;
    const chat = useChatStore.getState();
    chat.setUserId(userId);
    chat.hydrate();
    chat.setActiveAssistant("lynse");
    chat.clearMessages();
    onOpenChat();
    push("/chat");
    chat.sendMessage(t("settings.context_inbox_setup_prompt"), undefined, false, undefined, { assistant: "lynse" });
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
          <Switch id="context-inbox-enable" checked={enabled} disabled={!authenticated || busy}
            aria-describedby="context-inbox-hint" onCheckedChange={(checked) => void update(checked)} />
        </div>
        <p id="context-inbox-hint" className="text-2xs leading-relaxed text-muted-foreground">{t("settings.context_inbox_hint")}</p>
        {!authenticated && <p className="text-2xs text-muted-foreground">{t("settings.context_inbox_sign_in")}</p>}
        {enabled && (
          <div className="space-y-2">
            <p className="text-2xs leading-relaxed text-muted-foreground">{t("settings.context_inbox_setup_hint")}</p>
            <Button size="sm" variant="outline" onClick={configureReview}>{t("settings.context_inbox_setup")}</Button>
            {unavailable && <p role="status" className="text-2xs text-muted-foreground">{t("notifications.context_sync_unavailable")}</p>}
          </div>
        )}
        {error && <p role="alert" className="text-2xs text-destructive">{t("settings.context_inbox_save_failed")}</p>}
      </CardContent>
    </Card>
  );
}
