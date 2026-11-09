"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { ShieldCheck } from "../icons";
import { isWebPlatform } from "../platform";
import { useNavigation } from "../navigation";

/** Settings entry card for the web MCP authorization console; the console
 *  itself lives on the /authorizations page (same-origin bridge requirement). */
export function McpConsoleCard() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  if (!isWebPlatform()) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <ShieldCheck className="size-3.5" />
          {t("mcpAuthorizations.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xs leading-relaxed text-muted-foreground">{t("mcpAuthorizations.settings_hint")}</p>
        <Button size="sm" variant="outline" onClick={() => navigation.push("/authorizations")}>
          {t("mcpAuthorizations.manage")}
        </Button>
      </CardContent>
    </Card>
  );
}
