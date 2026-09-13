"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Check, FileText, Loader2, X } from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import type { AttachmentDraft } from "./chat-attachment-upload";
import { formatFileSize } from "./chat-attachment-upload";
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
}) {  if (!attachments?.length) return null;

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
                  className={`outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 ${compact ? "max-h-52 w-full object-contain" : "max-h-[440px] w-full object-contain"}`}
                />
              </a>
              <figcaption className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
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
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
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
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
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

/**
 * Attachment drafts picked via the composer "+" button, shown above the
 * textarea until the message is sent. Images preview from a local object URL
 * while uploading; documents show an icon. Progress replaces the size label
 * while the OSS upload is in flight.
 */
export function ChatAttachmentTray({
  drafts,
  onRemove,
}: {
  drafts: AttachmentDraft[];
  onRemove: (draft: AttachmentDraft) => void;
}) {
  const { t } = useTranslation();
  if (drafts.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-2.5 pt-2">
      {drafts.map((draft) => (
        <span
          key={draft.localId}
          className={cn(
            "flex max-w-56 items-center gap-1.5 rounded-lg border py-1 pl-1.5 pr-1",
            draft.status === "error"
              ? "border-destructive/40 bg-destructive/10"
              : "border-border bg-muted/40",
          )}
          title={draft.status === "error" ? t("chat.attachment_failed") : draft.name}
        >
          {draft.kind === "image" && draft.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
            <img
              src={draft.previewUrl}
              alt={draft.name}
              className="size-7 shrink-0 rounded-md object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          ) : (
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-2xs text-foreground">{draft.name}</span>
          {draft.status === "uploading" ? (
            <span className="flex shrink-0 items-center gap-1 text-3xs tabular-nums text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {draft.progress}%
            </span>
          ) : draft.status === "ready" ? (
            <Check className="size-3 shrink-0 text-success" />
          ) : (
            <X className="size-3 shrink-0 text-destructive" />
          )}
          {draft.status === "uploading" ? null : (
            <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
              {formatFileSize(draft.size)}
            </span>
          )}
          <button
            type="button"
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            onClick={() => onRemove(draft)}
            title={t("chat.attachment_remove")}
            aria-label={`${t("chat.attachment_remove")}: ${draft.name}`}
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
    </div>
  );
}
