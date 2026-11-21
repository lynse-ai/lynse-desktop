"use client";

import { useState } from "react";
import { LYNSE_EDITION } from "@lynse/core/config";
import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button, buttonVariants } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { cn } from "@lynse/ui/lib/utils";
import { Bot, Copy, Download } from "../icons";
import { DeviceAuthorizationLink } from "../mcp-authorizations";
import type { AgentConfigTab } from "./agent-config-view";
import {
  CLI_EXAMPLE_COMMAND,
  CLI_INSTALL_COMMAND,
  CLI_SIGN_IN_COMMAND,
  CLI_SKILL_URL,
  CLI_VERSION,
  CLI_WHEEL_URL,
  CLI_WORKBUDDY_SKILL_URL,
  MCP_CN_VERSION,
  MCP_WORKBUDDY_CN_URL,
  mcpEndpointUrl,
} from "./shared";

/** Copy-ready connector setup per AI tool. Snippets are re-computed at render
 *  time so the deployed origin (www.lynse.ai) is always the one shown. */
function setupSnippets(mcpUrl: string): { id: string; label: string; lang: string; code: string; descKey?: string }[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      lang: "bash",
      code: `claude mcp add --transport http lynse ${mcpUrl}`,
    },
    {
      id: "codex",
      label: "Codex",
      lang: "toml",
      code: `[mcp_servers.lynse]\nurl = "${mcpUrl}"`,
    },
    {
      id: "cursor",
      label: "Cursor",
      lang: "json",
      code: JSON.stringify({ mcpServers: { lynse: { url: mcpUrl } } }, null, 2),
    },
    {
      id: "workbuddy",
      label: "WorkBuddy",
      lang: "json",
      // Mirrors integrations/workbuddy/mcp.json in lynse-mcp (connector package format).
      code: JSON.stringify({ mcpServers: { lynse: { type: "streamableHttp", url: mcpUrl, timeout: 30000 } } }, null, 2),
      descKey: "agentConfig.agent_desc_workbuddy",
    },
    {
      id: "muse",
      label: "Muse",
      lang: "text",
      // muse.ai has no documented custom-URL JSON format; the connector takes the bare remote address.
      code: mcpUrl,
      descKey: "agentConfig.agent_desc_muse",
    },
    {
      id: "generic",
      label: "JSON",
      lang: "json",
      code: JSON.stringify({ mcpServers: { lynse: { type: "streamableHttp", url: mcpUrl } } }, null, 2),
    },
  ];
}

/** AI Agent tab: one-click-copy connector setup for AI tools, mirroring the
 *  biji.com "一句话安装" pattern adapted to Lynse's remote MCP model. */
export function AgentTab({ onNavigate }: { onNavigate: (tab: AgentConfigTab) => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);
  const snippets = setupSnippets(mcpEndpointUrl());
  const snippet = snippets[selected] ?? snippets[0]!;
  const isChinaEdition = LYNSE_EDITION === "cn";
  const cliSteps = [
    { label: t("agentConfig.cli_install"), command: CLI_INSTALL_COMMAND },
    { label: t("agentConfig.cli_sign_in"), command: CLI_SIGN_IN_COMMAND, hint: t("agentConfig.cli_device_hint") },
    { label: t("agentConfig.cli_example"), command: `lynse auth status --device\n${CLI_EXAMPLE_COMMAND}` },
  ];
  const cliDownloads = [
    { label: t("agentConfig.cli_download"), url: CLI_WHEEL_URL },
    { label: t("agentConfig.cli_skill_download"), url: CLI_SKILL_URL },
    { label: t("agentConfig.cli_workbuddy_download"), url: CLI_WORKBUDDY_SKILL_URL },
  ];

  function copy(text: string) {
    void navigator.clipboard.writeText(text)
      .then(() => toast.success(t("agentConfig.copied")))
      .catch(() => toast.error(t("agentConfig.copy_failed")));
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <Bot className="size-3.5" />
            {t("agentConfig.agent_title")}
            {isChinaEdition && <span className="font-normal text-muted-foreground">v{MCP_CN_VERSION}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("agentConfig.agent_hint")}</p>
          <div className="flex flex-wrap gap-1.5">
            {snippets.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={index === selected}
                onClick={() => setSelected(index)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  index === selected
                    ? "bg-foreground/5 text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          {snippet.descKey && (
            <p className="text-2xs leading-relaxed text-muted-foreground">{t(snippet.descKey)}</p>
          )}
          {isChinaEdition && snippet.id === "workbuddy" && (
            <a href={MCP_WORKBUDDY_CN_URL} className={buttonVariants({ size: "sm", variant: "outline" })}>
              <Download aria-hidden="true" className="size-3.5" />
              {t("agentConfig.mcp_workbuddy_download")}
            </a>
          )}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-2xs text-muted-foreground">{t("agentConfig.agent_snippet_hint", { label: snippet.label })}</p>
              <Button size="sm" variant="outline" onClick={() => copy(snippet.code)}>
                <Copy className="size-3.5" />
                {t("agentConfig.agent_copy_snippet", { label: snippet.label })}
              </Button>
            </div>
            <pre className="overflow-x-auto rounded-md border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed">{snippet.code}</pre>
          </div>
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("agentConfig.agent_first_connect")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            {t("agentConfig.cli_title")}
            <span className="font-normal text-muted-foreground">v{CLI_VERSION}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("agentConfig.cli_hint")}</p>
          <ol className="list-decimal space-y-4 pl-4 text-xs">
            {cliSteps.map(({ label, command, hint }) => (
              <li key={label} className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">{label}</h3>
                  <Button size="sm" variant="outline" aria-label={t("agentConfig.copy_command", { label })}
                    onClick={() => copy(command)}>
                    <Copy aria-hidden="true" className="size-3.5" />
                    {t("agentConfig.copy")}
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md border bg-muted/30 px-3 py-2.5 leading-relaxed"><code>{command}</code></pre>
                {hint && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-2xs leading-relaxed text-muted-foreground">{hint}</p>
                    <DeviceAuthorizationLink />
                  </div>
                )}
              </li>
            ))}
          </ol>
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("agentConfig.cli_skill_hint")}</p>
          <div className="flex flex-wrap gap-2">
            {cliDownloads.map(({ label, url }) => (
              <a key={url} href={url} className={buttonVariants({ size: "sm", variant: "outline" })}>
                <Download aria-hidden="true" className="size-3.5" />
                {label}
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("agentConfig.cross_link_title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("agentConfig.cross_link_hint")}</p>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => onNavigate("authorizations")}>
            {t("agentConfig.cross_link_goto")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
