"use client";

import { useId, useMemo, type ReactNode } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { getDesktopAppApi, openExternalUrl } from "./app-update";
import { parseReleaseNotes } from "./release-notes";

/** A deliberately small inline format: all other content stays literal text. */
function InlineNote({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\u0060([^\u0060]+)\u0060|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > at) parts.push(text.slice(at, index));
    if (match[1]) parts.push(<strong key={index} className="font-medium text-foreground">{match[1]}</strong>);
    else if (match[2]) parts.push(<code key={index} className="rounded bg-muted px-1 py-0.5 text-[0.92em]">{match[2]}</code>);
    else {
      const url = match[4]!;
      parts.push(
        <a
          key={index}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={(event) => {
            if (getDesktopAppApi()) {
              event.preventDefault();
              openExternalUrl(url);
            }
          }}
        >{match[3]}</a>,
      );
    }
    at = index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Structured notes shared by the updater and About, with a legacy-text fallback. */
export function ReleaseNotesContent({
  notes,
  compact = false,
  className,
}: {
  notes: string;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const parsed = useMemo(() => parseReleaseNotes(notes), [notes]);
  return (
    <div className={cn("min-w-0 space-y-7 break-words text-foreground/85 [overflow-wrap:anywhere]", compact ? "text-xs leading-5" : "text-[15px] leading-7", className)}>
      {parsed.paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line"><InlineNote text={paragraph} /></p>
      ))}
      {parsed.sections.map((section, index) => (
        <section key={section.key} aria-labelledby={`${id}-${index}`}>
          <h3 id={`${id}-${index}`} className="mb-3 flex items-baseline gap-2 text-base font-semibold text-foreground">
            {section.category ? t(`settings.update_notes_${section.category}`) : section.title}
            <span aria-hidden="true" className="text-[13px] font-normal tabular-nums text-muted-foreground">{section.items.length}</span>
          </h3>
          <ul className="list-disc space-y-2.5 pl-5 marker:text-muted-foreground">
            {section.items.map((item, itemIndex) => (
              <li key={itemIndex} className="whitespace-pre-line pl-0.5"><InlineNote text={item} /></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
