"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { mcpEndpointUrl } from "./shared";

interface DocSection {
  id: string;
  titleKey: string;
  /** zh-primary long-form content; structural labels stay in i18n. */
  body: { heading: string; lines: string[] }[];
}

const SECTIONS: DocSection[] = [
  {
    id: "quickstart",
    titleKey: "agentConfig.docs_quickstart",
    body: [
      {
        heading: "1. 复制 MCP 服务地址",
        lines: [
          "在「我的授权」标签复制服务地址（当前部署为 " + "https://www.lynse.ai/mcp" + "）。",
          "在支持 MCP（连接器）的 AI 应用（Codex、Claude Code、WorkBuddy、Cursor 等）的设置中添加该地址。",
        ],
      },
      {
        heading: "2. 登录授权",
        lines: [
          "首次连接会跳转官网登录页，使用手机验证码登录并确认授权；默认只授予 lynse:read 只读权限。",
          "授权记录出现在「我的授权」中，可随时撤销；撤销后客户端立即断开。",
        ],
      },
      {
        heading: "3. 验证连接",
        lines: [
          "连接成功后即可在 AI 应用中发现工具（会议、文件夹、待办等查询与整理能力）。",
          "Access Token 最长 15 分钟，客户端自动刷新；授权 90 天绝对期、闲置 30 天自动失效。",
        ],
      },
    ],
  },
  {
    id: "auth",
    titleKey: "agentConfig.docs_auth",
    body: [
      {
        heading: "MCP OAuth（推荐）",
        lines: [
          "AI 应用通过动态客户端注册（DCR）+ PKCE 完成授权，无需手工管理凭据。",
          "撤销任一 Token 会终止整条授权；重放已轮换的 Refresh Token 同样吊销整族。",
        ],
      },
      {
        heading: "API Key（账号体系）",
        lines: [
          "账号 API Key 由 Lynse 客户端签发，可用于换取业务 Token：POST /api/auth/apikey/token。",
          "网页端的 Key 管理接口即将开放；当前请通过 Lynse 客户端管理。",
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
          "上游业务凭据过期时，回官网重新登录即可刷新，授权本体不受影响。",
        ],
      },
    ],
  },
];

const MCP_URL_STANDIN = "https://www.lynse.ai/mcp";

/** 开发文档 tab: TOC + short zh-primary developer documentation. */
export function DocsTab() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <nav aria-label={t("agentConfig.tab_docs")} className="shrink-0 lg:w-52">
        <ul className="space-y-1 text-xs lg:sticky lg:top-4">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="block rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground">
                {t(section.titleKey)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 space-y-4">
        {SECTIONS.map((section) => (
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
                      <li key={line}>
                        {line.includes(MCP_URL_STANDIN)
                          ? (<>{line.split(MCP_URL_STANDIN)[0]}<code className="rounded bg-muted/40 px-1">{mcpEndpointUrl() || MCP_URL_STANDIN}</code>{line.split(MCP_URL_STANDIN)[1]}</>)
                          : line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
