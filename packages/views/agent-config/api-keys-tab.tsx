"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { KeyRound } from "../icons";

/**
 * The account backend does not expose key-management endpoints yet — the CLI
 * only knows how to exchange an existing key for a token
 * (`POST /api/auth/apikey/token`). The management contract below is ready to
 * wire once the backend ships it:
 *   GET    /api/agent/keys            -> AgentApiKey[]
 *   POST   /api/agent/keys { name }   -> { key } (full secret, shown once)
 *   DELETE /api/agent/keys/{id}
 * Until then the tab renders the biji-style notice and an honest empty state.
 */
const KEYS_API_READY = false;

export function ApiKeysTab() {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-xs">{t("agentConfig.keys_title")}</CardTitle>
        <Button size="sm" disabled={!KEYS_API_READY} title={KEYS_API_READY ? undefined : t("agentConfig.keys_pending")}>
          <KeyRound className="size-3.5" />
          {t("agentConfig.keys_create")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-2xs leading-relaxed text-foreground">
          {t("agentConfig.keys_notice")}
        </p>
        <p className="text-xs text-muted-foreground">
          {KEYS_API_READY ? t("agentConfig.keys_empty") : t("agentConfig.keys_pending_hint")}
        </p>
      </CardContent>
    </Card>
  );
}
