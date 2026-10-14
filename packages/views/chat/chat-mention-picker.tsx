"use client";

import { useEffect, useRef } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { FileText, Hash, Layers, X } from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import type { ChatMention, MentionOption, MentionTrigger } from "./chat-mentions";

/**
 * Autocomplete popover for the chat composer: `@` lists notes, `#` lists note
 * groups. Rendered above the input (the composer sits at the bottom of the
 * page) and driven entirely by the textarea's keyboard — the list only tracks
 * a highlighted index.
 */
export function MentionPicker({
  trigger,
  options,
  activeIndex,
  onPick,
  onHover,
}: {
  trigger: MentionTrigger;
  options: MentionOption[];
  activeIndex: number;
  onPick: (option: MentionOption) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view when navigating with ↑/↓.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[activeIndex] as HTMLElement | undefined;
    // Guard for environments without scrollIntoView (e.g. jsdom tests).
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      className="glass-overlay overflow-hidden rounded-xl border border-border shadow-[0_10px_38px_rgba(0,0,0,0.16)]"
      role="listbox"
      aria-label={trigger === "@" ? t("chat.mention_pick_note") : t("chat.mention_pick_group")}
    >
      <div className="border-b border-border/60 px-3 py-1.5 text-2xs font-medium text-muted-foreground">
        {trigger === "@" ? t("chat.mention_pick_note") : t("chat.mention_pick_group")}
      </div>
      <div ref={listRef} className="max-h-60 overflow-y-auto p-1">
        {options.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            {t("chat.mention_empty")}
          </div>
        ) : (
          options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-13 text-foreground transition-colors",
                index === activeIndex ? "bg-accent" : "hover:bg-accent/50",
              )}
              // Keep focus in the textarea — the popover is keyboard-driven.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(option)}
              onMouseEnter={() => onHover(index)}
            >
              {option.kind === "note" ? (
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Hash className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{option.title}</span>
              {option.kind === "group" && option.count !== undefined && (
                <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                  {option.count}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** Selected `@note` / `#group` chips shown above the composer textarea. */
export function MentionChips({
  mentions,
  onRemove,
  skill,
  onRemoveSkill,
}: {
  mentions: ChatMention[];
  onRemove: (mention: ChatMention) => void;
  /** Pending skill quick prompt: rendered as a leading accent chip. */
  skill?: { label: string };
  onRemoveSkill?: () => void;
}) {
  const { t } = useTranslation();
  if (mentions.length === 0 && !skill) return null;

  return (
    <div className="flex flex-wrap gap-1 px-2.5 pt-2">
      {skill && (
        <span
          className="flex max-w-56 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 py-0.5 pl-2 pr-0.5 text-2xs leading-4 text-accent-brand-text"
        >
          <Layers className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{skill.label}</span>
          <button
            type="button"
            className="flex size-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-foreground/10"
            onClick={onRemoveSkill}
            title={t("chat.mention_remove")}
            aria-label={`${t("chat.mention_remove")}: ${skill.label}`}
          >
            <X className="size-2.5" />
          </button>
        </span>
      )}
      {mentions.map((mention) => (
        <span
          key={`${mention.kind}-${mention.id}`}
          className={cn(
            "flex max-w-56 items-center gap-1 rounded-full border py-0.5 pl-2 pr-0.5 text-2xs leading-4",
            mention.kind === "note"
              ? "border-primary/20 bg-primary/10 text-accent-brand-text"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          {mention.kind === "note" ? (
            <FileText className="size-3 shrink-0" />
          ) : (
            <Hash className="size-3 shrink-0" />
          )}
          <span className="min-w-0 truncate">{mention.title}</span>
          <button
            type="button"
            className="flex size-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-foreground/10"
            onClick={() => onRemove(mention)}
            title={t("chat.mention_remove")}
            aria-label={`${t("chat.mention_remove")}: ${mention.title}`}
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
    </div>
  );
}
