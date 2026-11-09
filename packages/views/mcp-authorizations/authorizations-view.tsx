"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { ShieldCheck } from "../icons";
import { isWebPlatform } from "../platform";
import { McpAuthorizationsPanel } from "./mcp-authorizations-panel";

/** Standalone /authorizations page: chrome around the shared console panel. */
export function AuthorizationsView() {
  const { t } = useTranslation();
  if (!isWebPlatform()) return null;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4" />
            {t("mcpAuthorizations.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{t("mcpAuthorizations.hint")}</p>
          <McpAuthorizationsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
