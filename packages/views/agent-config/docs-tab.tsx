"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { DeviceAuthorizationLink } from "../mcp-authorizations";
import type { AgentConfigTab } from "./agent-config-view";
import { CLI_EXAMPLE_COMMAND, CLI_SIGN_IN_COMMAND, CLI_VERSION, mcpEndpointUrl } from "./shared";

interface DocSection {
  id: string;
  titleKey: string;
  /** zh-primary long-form content; structural labels stay in i18n. */
  body: { heading: string; lines: string[] }[];
}

function sections(mcpUrl: string): DocSection[] {
  return [
    {
      id: "quickstart",
      titleKey: "agentConfig.docs_quickstart",
      body: [
        {
          heading: "1. 复制 MCP 服务地址",
          lines: [
            `在支持远程 MCP 的 AI 工具中添加 ${mcpUrl}，或从「AI Agent」复制对应客户端的配置。`,
          ],
        },
        {
          heading: "2. 登录授权",
          lines: [
            "客户端会打开官网，请确认账号和应用申请的权限。完成后返回客户端。",
            "授权记录出现在「我的授权」中，可随时解绑。",
          ],
        },
        {
          heading: "3. 验证连接",
          lines: [
            "连接成功后，在 AI 工具里试着说「列出我最近 7 天的会议」。",
          ],
        },
      ],
    },
    {
      id: "cli",
      titleKey: "agentConfig.cli_title",
      body: [
        {
          heading: `Lynse CLI v${CLI_VERSION}`,
          lines: [
            "从「AI Agent」安装 CLI，或下载对应的 Skill ZIP 并导入支持 Skill 的应用。",
            `运行 ${CLI_SIGN_IN_COMMAND}，在官网输入终端显示的 6 位设备码并确认权限。已有设备码可直接打开设备授权。`,
            `完成授权后运行 ${CLI_EXAMPLE_COMMAND} 查询最近 7 天的会议。`,
          ],
        },
      ],
    },
    {
      id: "auth",
      titleKey: "agentConfig.docs_auth",
      body: [
        {
          heading: "MCP 和 CLI 授权",
          lines: [
            "MCP 由客户端发起浏览器授权。CLI 在浏览器确认设备码和权限。",
            "在「我的授权」可以单独解绑某个客户端的连接。",
          ],
        },
        {
          heading: "API Key（账号体系）",
          lines: [
            "使用 API Key 的既有脚本可以继续使用原有登录方式。请在 Lynse 客户端管理 Key。",
          ],
        },
      ],
    },
    {
      id: "scopes",
      titleKey: "agentConfig.docs_scopes",
      body: [
        {
          heading: "权限范围",
          lines: [
            "lynse:read（默认）：会议、文件夹、待办的查询与阅读。",
            "lynse:write：文件夹整理、会议移动、待办删除等写操作；客户端侧仍要求每次显式确认。",
          ],
        },
      ],
    },
    {
      id: "errors",
      titleKey: "agentConfig.docs_errors",
      body: [
        {
          heading: "常见错误",
          lines: [
            "401 / invalid_token：Token 过期或授权被撤销，客户端应重新发起授权。",
            "invalid_target：resource 参数必须等于 MCP 服务地址。",
            "如果提示账号登录已过期，请从客户端重新发起授权，在官网登录后继续。",
          ],
        },
      ],
    },
  ];
}

/** 开发文档 tab: TOC + short zh-primary developer documentation. */
export function DocsTab({ onNavigate }: { onNavigate: (tab: AgentConfigTab) => void }) {
  const { t } = useTranslation();
  const content = sections(mcpEndpointUrl());
  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <nav aria-label={t("agentConfig.tab_docs")} className="shrink-0 lg:w-52">
        <ul className="space-y-1 text-xs lg:sticky lg:top-4">
          {content.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="block rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground">
                {t(section.titleKey)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 space-y-4">
        {content.map((section) => (
          <Card key={section.id}>
            <CardHeader className="pb-2">
              <CardTitle id={section.id} className="scroll-mt-6 text-xs">{t(section.titleKey)}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {section.body.map((block) => (
                <div key={block.heading} className="space-y-1.5">
                  <p className="text-xs font-medium">{block.heading}</p>
                  <ul className="list-disc space-y-1 pl-4 text-2xs leading-relaxed text-muted-foreground">
                    {block.lines.map((line) => (
                      <li className="break-words" key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {(section.id === "quickstart" || section.id === "cli") && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => onNavigate("agent")}>
                    {t("agentConfig.goto_setup")}
                  </Button>
                  {section.id === "cli" && <DeviceAuthorizationLink />}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
