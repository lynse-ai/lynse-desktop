"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { ShieldCheck } from "../icons";
import { isWebPlatform } from "../platform";
import { DeviceAuthorizationLink } from "./device-authorization-link";
import { McpAuthorizationsPanel } from "./mcp-authorizations-panel";

/** Standalone /authorizations page: chrome around the shared console panel. */
export function AuthorizationsView() {
  const { t } = useTranslation();
  if (!isWebPlatform()) return null;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4" />
            {t("mcpAuthorizations.title")}
          </CardTitle>
          <DeviceAuthorizationLink />
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{t("mcpAuthorizations.hint")}</p>
          <McpAuthorizationsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
