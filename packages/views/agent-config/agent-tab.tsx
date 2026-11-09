"use client";

import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { cn } from "@lynse/ui/lib/utils";
import { Bot, Copy } from "../icons";
import type { AgentConfigTab } from "./agent-config-view";
import { mcpEndpointUrl } from "./shared";

/** Copy-ready connector setup per AI tool. Snippets are re-computed at render
 *  time so the deployed origin (www.lynse.ai) is always the one shown. */
function setupSnippets(mcpUrl: string): { id: string; label: string; lang: string; code: string }[] {
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
          <CardTitle className="text-xs">{t("agentConfig.cli_title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("agentConfig.cli_hint")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
              python3 -m pip install "git+https://github.com/lynse-ai/lynse-cli.git@v1.8.5"
            </code>
            <Button size="sm" variant="outline"
              onClick={() => copy('python3 -m pip install "git+https://github.com/lynse-ai/lynse-cli.git@v1.8.5"')}>
              <Copy className="size-3.5" />
              {t("agentConfig.copy")}
            </Button>
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
