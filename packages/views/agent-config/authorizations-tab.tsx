"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { Copy, Link } from "../icons";
import { McpAuthorizationsPanel } from "../mcp-authorizations";
import { mcpEndpointUrl } from "./shared";

/** 我的授权 tab: MCP connector address + the shared authorization console. */
export function AuthorizationsTab() {
  const { t } = useTranslation();

  function copyMcpUrl() {
    void navigator.clipboard.writeText(mcpEndpointUrl())
      .then(() => toast.success(t("agentConfig.copied")))
      .catch(() => toast.error(t("agentConfig.copy_failed")));
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <Link className="size-3.5" />
            {t("agentConfig.connector_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("agentConfig.connector_hint")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/30 px-2 py-1.5 text-xs">{mcpEndpointUrl()}</code>
            <Button size="sm" variant="outline" onClick={copyMcpUrl}>
              <Copy className="size-3.5" />
              {t("agentConfig.copy")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("agentConfig.records_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <McpAuthorizationsPanel dense />
        </CardContent>
      </Card>
    </div>
  );
}
