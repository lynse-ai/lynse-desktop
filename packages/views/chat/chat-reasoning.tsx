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

/** Compact running/done chip rows for every tool call in the current turn. */
export function ToolActivity({ tools }: { tools: ChatToolUse[] }) {
  return (
    <div className="flex flex-col gap-1">
      {tools.map((tool) => (
        <ToolChip key={tool.id} tool={tool} />
      ))}
    </div>
  );
}

/** One bordered tool chip: icon tile + kind label + mono name + live state. */
function ToolChip({ tool }: { tool: ChatToolUse }) {
  const { t } = useTranslation();
  const kind = toolKind(tool.name);
  const Icon = KIND_ICON[kind];
  const running = tool.state === "running";
  const elapsed = useElapsedSeconds(tool.startedAt, running);
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-2 py-1.5 text-xs text-muted-foreground"
      aria-label={t("chat.tool_activity", { tool: tool.name })}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/60">
        <Icon className="size-3" />
      </span>
      <span className="shrink-0 font-medium text-foreground/80">{t(`chat.tool_${kind}`)}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{tool.name}</span>
      {running ? (
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
          {elapsed != null && <span>{t("chat.elapsed_seconds", { seconds: elapsed })}</span>}
          <StatusGlyph activity="running" className="size-3" />
        </span>
      ) : tool.state === "error" ? (
        <AlertCircle className="size-3 shrink-0 text-destructive" aria-label={t("chat.tool_failed")} />
      ) : (
        <Check className="size-3 shrink-0 text-success" />
      )}
    </div>
  );
}

/**
 * Live "running Ns" counter for a tool call. Ticks once a second while the
 * call is running; returns null when there is no anchor or the call ended.
 */
function useElapsedSeconds(startedAt: number | undefined, running: boolean): number | null {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running || startedAt == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  if (startedAt == null || !running) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * Collapsible chain-of-thought trace. While reasoning is streaming the block
 * is pinned open with a live label and an elapsed counter; when the answer
 * starts it folds away (ZCode behavior) showing "已思考 N 秒", and the user
 * can reopen it manually. Without a `startedAt` anchor (persisted history) it
 * falls back to the static labels.
 */
export function ThinkingBlock({
  text,
  active,
  startedAt,
}: {
  text: string;
  active?: boolean;
  startedAt?: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(Boolean(active));
  const wasActive = React.useRef(Boolean(active));
  // Elapsed seconds, frozen the moment reasoning ends so the folded label
  // keeps the final duration instead of drifting with the wall clock.
  const [frozenSeconds, setFrozenSeconds] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (active) {
      setOpen(true);
      setFrozenSeconds(null);
    } else if (wasActive.current) {
      setOpen(false);
      if (startedAt != null) {
        setFrozenSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
      }
    }
    wasActive.current = Boolean(active);
  }, [active, startedAt]);

  const liveSeconds = useElapsedSeconds(startedAt, Boolean(active) && startedAt != null);
  const elapsed = active ? liveSeconds : null;

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
          <>
            <ActivityLabel text={t("chat.thinking_active")} />
            {elapsed != null && (
              <span aria-hidden="true" className="tabular-nums">
                · {t("chat.elapsed_seconds", { seconds: elapsed })}
              </span>
            )}
          </>
        ) : frozenSeconds != null ? (
          <span>{t("chat.thinking_elapsed_done", { seconds: frozenSeconds })}</span>
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
