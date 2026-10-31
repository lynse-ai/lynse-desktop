"use client";

import { useEffect, useState } from "react";
import { api, getUsageSummary, type UsageSummary } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";

export function UsageCard() {
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id);
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const featureLabels: Record<string, string> = {
    agent_chat: zh ? "对话" : "Chat", meeting_summary: zh ? "会议总结" : "Meeting summary",
    source_analysis: zh ? "材料分析" : "Source analysis", topic_compile: zh ? "专题编写" : "Topic writing",
    wiki_catalog: zh ? "主题归类" : "Topic catalog", wiki_topic_match: zh ? "主题匹配" : "Topic matching",
    wiki_topic_group: zh ? "主题分组" : "Topic grouping", graph_extract: zh ? "知识图谱" : "Knowledge graph",
    memory_extract: zh ? "记忆提取" : "Memory extraction", project_review: zh ? "项目回顾" : "Project review",
    conversation_memory: zh ? "会话记忆" : "Conversation memory", memory_embedding: zh ? "知识索引与检索" : "Knowledge indexing and search",
    report: zh ? "报告" : "Report", "lynse-report": zh ? "报告" : "Report", visual: zh ? "可视化" : "Visualization",
  };
  const featureLabel = (value: string) => featureLabels[value] ?? (zh ? "其他 AI 处理" : "Other AI work");
  const statusLabels: Record<string, string> = { succeeded: zh ? "完成" : "Completed", failed: zh ? "失败" : "Failed",
    cancelled: zh ? "已取消" : "Cancelled", started: zh ? "处理中" : "Processing",
    unknown: zh ? "结果待确认" : "Outcome pending" };
  const statusLabel = (value: string) => statusLabels[value] ?? (zh ? "待确认" : "Pending");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    setSummary(null);
    setError(false);
    const token = api().getToken();
    if (!authenticated || !token) return;
    const controller = new AbortController();
    getUsageSummary(token, controller.signal).then((result) => {
      if (!controller.signal.aborted && api().getToken() === token) setSummary(result);
    }).catch(() => {
      if (!controller.signal.aborted && api().getToken() === token) setError(true);
    });
    return () => controller.abort();
  }, [authenticated, userId, refresh]);

  if (!authenticated) return null;
  return <Card>
    <CardHeader className="pb-2 flex-row items-center justify-between">
      <CardTitle className="text-xs">{zh ? "AI 用量与积分" : "AI usage & credits"}</CardTitle>
      <Button variant="ghost" size="sm" onClick={() => setRefresh((value) => value + 1)}>{zh ? "刷新" : "Refresh"}</Button>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">{zh ? "模拟计费期间，当前不扣积分。" : "Shadow billing is active. No credits are deducted."}</p>
      {error ? <p role="status">{zh ? "用量服务暂不可用，请稍后刷新。" : "Usage is unavailable. Try refreshing later."}</p>
        : !summary ? <p role="status">{zh ? "正在读取用量…" : "Loading usage…"}</p>
        : <>
          <dl className="grid grid-cols-2 gap-3">
            <div><dt className="text-xs text-muted-foreground">{zh ? "累计模型调用" : "Total model calls"}</dt><dd>{summary.totals.calls.toLocaleString()}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{zh ? "模拟应付积分" : "Shadow credits"}</dt><dd>{(summary.shadow_micro_points / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{zh ? "已知输入 / 输出 tokens" : "Known input / output tokens"}</dt><dd>{summary.totals.input_tokens.toLocaleString()} / {summary.totals.output_tokens.toLocaleString()}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{zh ? "实际扣费积分" : "Charged credits"}</dt><dd>0</dd></div>
          </dl>
          {(summary.totals.unknown_usage_calls > 0 || summary.totals.unknown_cost_calls > 0 || summary.pending_orders > 0) && <p className="text-xs text-muted-foreground">{zh ? "部分用量或价格尚未确认，以上数值仅包含已确认部分。" : "Some usage or pricing is pending; figures include confirmed amounts only."}</p>}
          <details className="text-xs"><summary>{zh ? "按功能和模型查看" : "View by feature and model"}</summary><ul className="mt-2 space-y-1">{summary.groups.map((group) => <li key={`${group.feature}:${group.model}:${group.credential_source}:${group.status}`}>{featureLabel(group.feature)} · {group.model} · {group.credential_source === "user" ? (zh ? "自带 Key" : "Your key") : group.credential_source === "platform" ? (zh ? "平台模型" : "Hosted model") : (zh ? "来源待确认" : "Source pending")} · {group.calls} · {statusLabel(group.status)}</li>)}</ul></details>
        </>}
    </CardContent>
  </Card>;
}
