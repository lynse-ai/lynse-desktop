"use client";

import { FileText } from "../icons";
import type { ChatAttachment } from "../workspace/types";

function attachmentKind(attachment: ChatAttachment): "image" | "pdf" | "html" | "file" {
  const value = attachment.name || attachment.url || attachment.downloadUrl || "";
  if ((attachment.type || "").startsWith("image") || /\.(png|jpe?g|gif|webp)$/i.test(value)) {
    return "image";
  }
  if (attachment.type === "pdf" || /\.pdf$/i.test(value)) return "pdf";
  if (attachment.type === "html" || /\.html?$/i.test(value)) return "html";
  return "file";
}

export function ChatAttachments({
  attachments,
  compact = false,
}: {
  attachments?: ChatAttachment[];
  compact?: boolean;
}) {
  if (!attachments?.length) return null;

  return (
    <div className={compact ? "mt-2 flex flex-col gap-2" : "mt-3 grid gap-3"}>
      {attachments.map((attachment, index) => {
        const href = attachment.downloadUrl || attachment.url || attachment.thumbnailUrl;
        if (!href) return null;
        const kind = attachmentKind(attachment);
        const name = attachment.name || "附件";
        const key = attachment.id || `${href}-${index}`;

        if (kind === "image") {
          return (
            <figure key={key} className="overflow-hidden rounded-xl border border-border bg-card">
              <a href={href} target="_blank" rel="noreferrer" className="block bg-muted/20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={attachment.thumbnailUrl || attachment.url || href}
                  alt={name}
                  className={compact ? "max-h-52 w-full object-contain" : "max-h-[440px] w-full object-contain"}
                />
              </a>
              <figcaption className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                <span className="truncate">{name}</span>
              </figcaption>
            </figure>
          );
        }

        if (kind === "pdf") {
          return (
            <section key={key} className="overflow-hidden rounded-xl border border-border bg-card">
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-foreground hover:bg-accent"
              >
                <FileText className="size-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  PDF
                </span>
              </a>
              <iframe
                src={attachment.url || href}
                title={name}
                className={compact ? "h-48 w-full bg-background" : "h-80 w-full bg-background"}
              />
            </section>
          );
        }

        if (kind === "html") {
          return (
            <section key={key} className="overflow-hidden rounded-xl border border-border bg-card">
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-foreground hover:bg-accent"
              >
                <FileText className="size-3.5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  HTML
                </span>
              </a>
              <iframe
                src={attachment.url || href}
                title={name}
                sandbox=""
                referrerPolicy="no-referrer"
                className={compact ? "h-48 w-full bg-background" : "h-80 w-full bg-background"}
              />
            </section>
          );
        }

        return (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
          </a>
        );
      })}
    </div>
  );
}
