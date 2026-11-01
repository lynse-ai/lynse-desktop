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
      <span className="text-2xs uppercase tracking-[0.08em] text-muted-foreground/70">
        {t("chat.sources")}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-3xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent data-popup-open:border-primary/30 data-popup-open:bg-accent"
          aria-label={t("chat.sources")}
        >
          <FileText className="size-3 shrink-0 text-primary/70" />
          <span>{sources.length}</span>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-[360px] gap-0 p-1.5"
        >
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
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
                  className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
                  title={label}
                  onClick={() => {
                    setOpen(false);
                    onOpen?.(source.trim() || label);
                  }}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <FileText className="size-3.5 text-primary/70" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
