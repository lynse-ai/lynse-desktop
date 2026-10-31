"use client";

/**
 * ZCode-style assistant activity UI: a collapsible chain-of-thought block and
 * compact tool-call rows (icon + kind label + raw tool name + running/done).
 * Fed by the `thinking` / `tool` stream events; tool rows also light up from
 * status ticks that announce a tool call (see use-chat-store).
 */

import * as React from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  CircleStop,
  FileSearch,
  Lightbulb,
  Pencil,
  Plug,
  ScrollText,
  Search,
  SquareTerminal,
  Wrench,
} from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import { StatusGlyph } from "@lynse/ui/components/ui/status-glyph";
import { ActivityLabel } from "@lynse/ui/components/ui/activity-indicator";
import type { ChatToolUse } from "../workspace/types";

export type ToolKind =
  | "think"
  | "search"
  | "read"
  | "edit"
  | "terminal"
  | "task"
  | "stop"
  | "mcp"
  | "execute";

/**
 * Keyword rules over the raw backend tool name; anything else is "execute".
 * stop/task sit above read so `stop_task` and `get_task_output` classify by
 * their intent instead of falling into the `get_`/`_task` substrings.
 */
const TOOL_KIND_RULES: Array<[RegExp, ToolKind]> = [
  [/mcp/i, "mcp"],
  [/stop|cancel|abort|kill|terminate|停止|取消|终止/i, "stop"],
  [/task|job|output|poll|log|任务|输出|日志|后台/i, "task"],
  [/think|reason|思考/i, "think"],
  [/search|query|find|list|检索|查询|搜索/i, "search"],
  [/read|fetch|get_|view|读取|查看/i, "read"],
  [/edit|write|create|patch|update|save|编辑|修改|保存|新建/i, "edit"],
  [/terminal|bash|shell|command|终端|命令/i, "terminal"],
];

export function toolKind(name: string): ToolKind {
  for (const [pattern, kind] of TOOL_KIND_RULES) {
    if (pattern.test(name)) return kind;
  }
  return "execute";
}

const KIND_ICON: Record<ToolKind, React.ComponentType<{ className?: string }>> = {
  think: Brain,
  search: Search,
  read: FileSearch,
  edit: Pencil,
  terminal: SquareTerminal,
  task: ScrollText,
  stop: CircleStop,
  mcp: Plug,
  execute: Wrench,
};

/** Compact running/done rows for every tool call in the current turn. */
export function ToolActivity({ tools }: { tools: ChatToolUse[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      {tools.map((tool) => {
        const kind = toolKind(tool.name);
        const Icon = KIND_ICON[kind];
        return (
          <div
            key={tool.id}
            className="flex items-center gap-2 text-xs text-muted-foreground"
            aria-label={t("chat.tool_activity", { tool: tool.name })}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/60">
              <Icon className="size-3" />
            </span>
            <span className="shrink-0 font-medium text-foreground/80">{t(`chat.tool_${kind}`)}</span>
            <span className="min-w-0 truncate font-mono">{tool.name}</span>
            {tool.state === "running" ? (
              <StatusGlyph activity="running" className="size-3 shrink-0" />
            ) : tool.state === "error" ? (
              <AlertCircle className="size-3 shrink-0 text-destructive" aria-label={t("chat.tool_failed")} />
            ) : (
              <Check className="size-3 shrink-0 text-success" />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Collapsible chain-of-thought trace. While reasoning is streaming the block
 * is pinned open with a live label; when the answer starts it folds away
 * (ZCode behavior) and the user can reopen it manually.
 */
export function ThinkingBlock({ text, active }: { text: string; active?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(Boolean(active));
  const wasActive = React.useRef(Boolean(active));

  React.useEffect(() => {
    if (active) setOpen(true);
    else if (wasActive.current) setOpen(false);
    wasActive.current = Boolean(active);
  }, [active]);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Lightbulb className="size-3.5 shrink-0" />
        {active ? (
          <ActivityLabel text={t("chat.thinking_active")} />
        ) : (
          <span>{t("chat.thought_process")}</span>
        )}
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}
