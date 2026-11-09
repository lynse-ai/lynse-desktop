"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import { api } from "@lynse/core/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { Copy } from "../icons";
import type { AgentConfigTab } from "./agent-config-view";
import { mcpEndpointUrl } from "./shared";

/** Static release notes shown on the overview tab (zh-primary content;
 *  structural labels are localized, entries are product changelog data). */
const CHANGELOG: { version: string; date: string; items: string[] }[] = [
  {
    version: "v0.2.0",
    date: "2026-11-09",
    items: [
      "长期授权：授权 90 天绝对期 + Refresh Token 30 天滑动轮换，重放自动吊销",
      "应用授权管理：网页控制台可查看、撤销、删除已授权的 MCP 应用",
      "网页版上线：www.lynse.ai/app 同源承载会议、笔记与授权管理",
    ],
  },
  {
    version: "v0.1.0",
    date: "2026-11-01",
    items: [
      "MCP Apps 界面：会议、待办与确认卡片内嵌展示",
      "网页授权测试台：授权码兑换、初始化与工具发现自检",
    ],
  },
];

export function OverviewTab({ onNavigate }: { onNavigate: (tab: AgentConfigTab) => void }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const backend = api().getBaseUrl();

  function copyMcpUrl() {
    void navigator.clipboard.writeText(mcpEndpointUrl())
      .then(() => toast.success(t("agentConfig.copied")))
      .catch(() => toast.error(t("agentConfig.copy_failed")));
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("agentConfig.developer_info")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-xs sm:grid-cols-2">
          <p className="text-muted-foreground">{t("agentConfig.developer_name")}: <span className="text-foreground">{user?.name ?? "-"}</span></p>
          <p className="text-muted-foreground">{t("agentConfig.developer_id")}: <span className="text-foreground">{user?.id ?? "-"}</span></p>
          <p className="text-muted-foreground">{t("agentConfig.developer_type")}: <span className="text-foreground">{t("agentConfig.developer_personal")}</span></p>
          <p className="truncate text-muted-foreground">{t("agentConfig.developer_backend")}: <span className="text-foreground">{backend}</span></p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("agentConfig.quick_mcp")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/30 px-2 py-1.5 text-xs">{mcpEndpointUrl()}</code>
            <Button size="sm" variant="outline" onClick={copyMcpUrl}>
              <Copy className="size-3.5" />
              {t("agentConfig.copy")}
            </Button>
          </div>
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("agentConfig.quick_mcp_hint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onNavigate("authorizations")}>
              {t("agentConfig.goto_authorizations")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onNavigate("docs")}>
              {t("agentConfig.goto_docs")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("agentConfig.changelog")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="space-y-1.5">
              <p className="text-xs font-medium">
                {entry.version} <span className="ml-1 text-2xs text-muted-foreground">{entry.date}</span>
              </p>
              <ul className="list-disc space-y-1 pl-4 text-2xs leading-relaxed text-muted-foreground">
                {entry.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
