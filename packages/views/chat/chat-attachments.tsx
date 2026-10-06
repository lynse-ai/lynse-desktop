"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "@lynse/core/i18n/react";
import { getAuthStore } from "@lynse/core/auth";
import { api } from "@lynse/core/api/client";
import { downloadContextReview, isContextExportPath } from "@lynse/core/api";
import { toast } from "sonner";
import { Check, Download, FileText, Loader2, Share, X } from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import type { AttachmentDraft } from "./chat-attachment-upload";
import { formatFileSize } from "./chat-attachment-upload";
import type { ChatAttachment } from "../workspace/types";
import { refreshAttachmentUrl } from "../workspace/chat-transport";

function attachmentKind(attachment: ChatAttachment): "image" | "pdf" | "html" | "file" {
  const value = attachment.name || attachment.url || attachment.downloadUrl || "";
  if ((attachment.type || "").startsWith("image") || /\.(png|jpe?g|gif|webp)$/i.test(value)) {
    return "image";
  }
  if (attachment.type === "pdf" || /\.pdf$/i.test(value)) return "pdf";
  if (attachment.type === "html" || /\.html?$/i.test(value)) return "html";
  return "file";
}

/**
 * Fetch the attachment and hand it to the browser's downloader. Signed hosts
 * may refuse CORS — the fallback opens the URL so the user can save manually.
 */
async function downloadAttachment(url: string, filename: string): Promise<void> {
  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename || "attachment";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * One attachment's live URLs. lynclaw hands out signed download links that
 * expire (~1h) while chat history keeps rendering them, so a lynclaw
 * artifact can be re-signed on demand (`refreshAttachmentUrl`): broken
 * images re-fetch themselves on error, and links re-sign before opening.
 * Attachments without an artifact id (other backends) pass through
 * untouched.
 */
function useAttachmentUrls(attachment: ChatAttachment) {
  const [href, setHref] = useState(
    attachment.downloadUrl || attachment.url || attachment.thumbnailUrl || "",
  );
  const [imgSrc, setImgSrc] = useState(attachment.thumbnailUrl || attachment.url || href);
  const attempted = useRef(false);

  const refresh = useCallback(async (): Promise<string | null> => {
    if (attempted.current) return null;
    attempted.current = true;
    let userId: string | null = null;
    try {
      userId = getAuthStore()?.getState().user?.id ?? null;
    } catch {
      userId = null; // auth store not registered (tests, early boot)
    }
    const fresh = await refreshAttachmentUrl(attachment, { userId });
    if (fresh) {
      setHref(fresh);
      setImgSrc(fresh);
    }
    return fresh;
  }, [attachment]);

  /** Re-sign first, then open — stale links never reach the browser. */
  const openWithFreshUrl = useCallback(
    (event: { preventDefault: () => void }) => {
      if (!attachment.id) return; // no artifact to re-sign — native navigation
      event.preventDefault();
      void refresh().then((fresh) => {
        window.open(fresh || href, "_blank", "noopener,noreferrer");
      });
    },
    [attachment.id, refresh, href],
  );

  // An attachment can arrive with NO url at all (the CloudBase storage backend
  // ships `download_url: ""` and signs lazily by object path). Such a card
  // renders nothing and never hits the img onError path above, so without this
  // the attachment is silently invisible. Mint the URL on mount — this also
  // restores already-saved history messages whose attachments were persisted
  // url-less.
  useEffect(() => {
    if (href || !attachment.id) return;
    void refresh();
  }, [href, attachment.id, refresh]);

  return { href, imgSrc, refresh, openWithFreshUrl };
}

/**
 * Fullscreen image viewer for chat attachments: click the bubble image to
 * inspect it, click again (or pinch of the wheel — same toggle) to blow it up
 * to natural size with pan/scroll, plus download and forward (copy to
 * clipboard) actions. Esc / backdrop click closes.
 */
function ChatImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleForward = useCallback(async () => {
    try {
      const response = await fetch(src, { mode: "cors" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      toast.success(t("chat.attachment_forward_done"));
    } catch {
      toast.error(t("chat.attachment_forward_failed"));
      window.open(src, "_blank", "noopener,noreferrer");
    }
  }, [src, t]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        className="fixed inset-0 z-[90] overflow-auto bg-black/85 backdrop-blur-sm"
        onClick={onClose}
      >
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          <motion.img
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.16 }}
            src={src}
            alt={alt}
            onClick={(event) => {
              event.stopPropagation();
              setZoomed((value) => !value);
            }}
            className={cn(
              "shadow-2xl outline outline-1 -outline-offset-1 outline-white/10",
              zoomed
                ? "max-h-none max-w-none cursor-zoom-out"
                : "max-h-[88vh] max-w-[88vw] cursor-zoom-in rounded-lg object-contain",
            )}
          />
        </div>

        <button
          type="button"
          title="Close"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white/90 transition-colors hover:bg-white/20"
        >
          <X className="size-4" />
        </button>

        <div
          className="absolute bottom-6 left-1/2 flex -translate-x-1/2 gap-2"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            data-testid="chat-image-download"
            title={t("chat.attachment_download")}
            onClick={() => void downloadAttachment(src, alt)}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-sm text-white/90 transition-colors hover:bg-white/20"
          >
            <Download className="size-4" />
            {t("chat.attachment_download")}
          </button>
          <button
            type="button"
            data-testid="chat-image-forward"
            title={t("chat.attachment_forward")}
            onClick={() => void handleForward()}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-sm text-white/90 transition-colors hover:bg-white/20"
          >
            <Share className="size-4" />
            {t("chat.attachment_forward")}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export function ChatAttachments({
  attachments,
  compact = false,
}: {
  attachments?: ChatAttachment[];
  compact?: boolean;
}) {
  const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);

  if (!attachments?.length) return null;

  return (
    <>
      <div className={compact ? "mt-2 flex flex-col gap-2" : "mt-3 grid gap-3"}>
        {attachments.map((attachment, index) => (
          <AttachmentItem
            key={attachment.id || `${attachment.url}-${index}`}
            attachment={attachment}
            compact={compact}
            onOpenImage={setViewer}
          />
        ))}
      </div>
      {viewer && (
        <ChatImageLightbox
          src={viewer.src}
          alt={viewer.alt}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}

function AttachmentItem({
  attachment,
  compact,
  onOpenImage,
}: {
  attachment: ChatAttachment;
  compact: boolean;
  onOpenImage: (viewer: { src: string; alt: string } | null) => void;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const { href, imgSrc, refresh } = useAttachmentUrls(attachment);
  if (!href) return null;
  const kind = attachmentKind(attachment);
  const name = attachment.name || "附件";

  if (isContextExportPath(href)) {
    const downloadReview = () => {
      if (downloading) return;
      const token = api().getToken();
      if (!token) { toast.error(t("notifications.context_unavailable")); return; }
      setDownloading(true);
      void downloadContextReview(href, token).then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
      }).catch(() => toast.error(t("notifications.context_unavailable")))
        .finally(() => setDownloading(false));
    };
    return (
      <button type="button" disabled={downloading} onClick={downloadReview}
        className="flex max-w-sm min-w-56 items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-primary/30 hover:bg-accent disabled:opacity-50">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        {downloading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Download className="size-4 text-muted-foreground" />}
      </button>
    );
  }

  if (kind === "image") {
    // Bare picture — no card chrome, the message bubble is the container.
    // Click opens the fullscreen viewer instead of navigating away.
    return (
      <img
        src={imgSrc}
        alt={name}
        onClick={() => onOpenImage({ src: href, alt: name })}
        onError={() => void refresh()}
        className={cn(
          "w-fit max-w-full cursor-zoom-in rounded-lg object-contain",
          "outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10",
          compact ? "max-h-52" : "max-h-80",
        )}
      />
    );
  }

  if (kind === "pdf") {
    // WeChat-style file card: icon + filename, tap to download locally —
    // no inline preview, the PDF viewer is the user's own app.
    const openLocally = () => {
      if (downloading) return;
      setDownloading(true);
      void (async () => {
        try {
          const fresh = attachment.id ? await refresh() : null;
          const url = fresh || href;
          if (!url) return;
          await downloadAttachment(url, name.endsWith(".pdf") ? name : `${name}.pdf`);
        } finally {
          setDownloading(false);
        }
      })();
    };
    return (
      <button
        type="button"
        onClick={openLocally}
        className={cn(
          "flex max-w-sm min-w-56 items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left",
          "transition-colors hover:border-primary/30 hover:bg-accent",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
          <FileText className="size-5 text-destructive" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm text-foreground">{name}</span>
          <span className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
            PDF
          </span>
        </span>
        {downloading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Download className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
    );
  }

  if (kind === "html") {
    return (
      <section className="overflow-hidden rounded-xl border border-border bg-card">
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
          src={href}
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
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </a>
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
            <X className="size-2.5 shrink-0 text-destructive" />
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
