"use client";

/**
 * Backend-suggested follow-up questions, rendered as a chip row under a
 * finished reply. Server-driven only: when the done frame carries no
 * suggestions the component renders nothing (zero local noise).
 */

import * as React from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { MessageCircleQuestion } from "../icons";
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
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span className="text-2xs uppercase tracking-[0.08em] text-muted-foreground/70">
        {t("chat.follow_ups")}
      </span>
      {items.map((question) => (
        <button
          key={question}
          type="button"
          onClick={() => onPick(question)}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
          title={question}
        >
          <MessageCircleQuestion className="size-3 shrink-0 text-primary/70" />
          <span className="min-w-0 truncate">{question}</span>
        </button>
      ))}
    </div>
  );
}
