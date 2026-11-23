"use client";

/**
 * Backend-suggested follow-up questions, rendered as a chip row under a
 * finished reply. Server-driven only: when the done frame carries no
 * suggestions the component renders nothing (zero local noise).
 */

import * as React from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Sparkles, ArrowUpRight } from "../icons";
import { cn } from "@lynse/ui/lib/utils";

export function FollowUpChips({
  suggestions,
  onPick,
  className,
}: {
  suggestions?: string[];
  onPick: (question: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const items = React.useMemo(
    () =>
      (suggestions ?? [])
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4),
    [suggestions],
  );
  if (!items.length) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 pt-1.5", className)}>
      <span className="flex items-center gap-1 text-2xs font-medium text-muted-foreground/70">
        <Sparkles className="size-3 text-muted-foreground/60" />
        <span>{t("chat.follow_ups")}</span>
      </span>
      {items.map((question) => (
        <button
          key={question}
          type="button"
          onClick={() => onPick(question)}
          className="group inline-flex max-w-full items-center gap-1 rounded-lg bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-all duration-150 hover:bg-muted/80 hover:text-foreground active:scale-[0.98]"
          title={question}
        >
          <span className="min-w-0 truncate">{question}</span>
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/40 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
        </button>
      ))}
    </div>
  );
}
