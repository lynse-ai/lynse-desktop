"use client";

/**
 * Collapsed citation strip shared by the chat page and the side panel: one
 * icon chip carrying the source count, opening a popover of mini-cards for
 * the cited meetings. The poll payload may carry meeting IDs/titles (resolved
 * via `resolveLabel`) or, from older backends, empty placeholders — those fall
 * back to titles parsed from the reply's meeting table. `onOpen` receives the
 * best key available for the jump.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { ChevronRight, FileText } from "../icons";
import { Popover, PopoverContent, PopoverTrigger } from "@lynse/ui/components/ui/popover";

/**
 * Meeting titles from the reply's own markdown table (`| # | 日期 | 时长 |
 * 分类 | 主题 |`). Older lynclaw builds emit one empty string per meeting in
 * `sources`, so on those turns the table's topic column is the only
 * client-side source for row labels.
 */
export function meetingTitlesFromReply(content: string): string[] {
  const titles: string[] = [];
  for (const line of content.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 7) continue;
    // Only rows whose second cell is a MM-DD date count as meeting rows;
    // header and separator rows fail this check.
    if (!/^\d{1,2}-\d{1,2}$/.test(cells[2] ?? "")) continue;
    const title = cells[cells.length - 2] ?? "";
    if (title) titles.push(title);
  }
  return titles;
}

export function ChatSources({
  sources,
  resolveLabel,
  content,
  onOpen,
}: {
  sources: string[];
  resolveLabel: (source: string) => string;
  content?: string;
  onOpen?: (source: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rescuedTitles = useMemo(
    () => (content ? meetingTitlesFromReply(content) : []),
    [content],
  );

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition-all duration-150 hover:border-primary/30 hover:bg-muted/60 hover:text-foreground data-popup-open:border-primary/40 data-popup-open:bg-accent/60"
          aria-label={t("chat.sources")}
        >
          <FileText className="size-3.5 shrink-0 text-primary/80" />
          <span className="font-medium text-foreground/80">{t("chat.sources_title")}</span>
          <span className="rounded-full bg-primary/10 px-1.5 py-0.2 text-3xs font-medium text-primary">
            {sources.length}
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-[360px] gap-0 p-0 shadow-lg border-border/70 rounded-xl overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>{t("chat.sources_title")}</span>
            <span className="text-3xs text-muted-foreground/70">{t("chat.sources_count", { count: sources.length })}</span>
          </div>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto p-1.5">
            {sources.map((source, index) => {
              // Empty placeholders fall back to the reply-table topic, then
              // resolveLabel upgrades it to the full note title (with its
              // date prefix) when the matching note exists.
              const label = source.trim()
                ? resolveLabel(source)
                : rescuedTitles[index]
                  ? resolveLabel(rescuedTitles[index])
                  : source;
              return (
                <button
                  key={`${source}-${index}`}
                  type="button"
                  className="group flex w-full items-center gap-2.5 rounded-lg border border-border/60 bg-background/60 p-2 text-left text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
                  title={label}
                  onClick={() => {
                    setOpen(false);
                    onOpen?.(source.trim() || label);
                  }}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-inset ring-primary/20">
                    <FileText className="size-3.5 text-primary" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground/90 group-hover:text-primary transition-colors">{label}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
