"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "@lynse/core/i18n/react";
import { getAuthStore } from "@lynse/core/auth";
import { toast } from "sonner";
import { Check, Download, Eye, FileText, Fullscreen, Loader2, Share, X, ZoomIn, ZoomOut } from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Markdown } from "@lynse/ui/markdown";
import type { AttachmentDraft } from "./chat-attachment-upload";
import { formatFileSize } from "./chat-attachment-upload";
import type { ChatAttachment } from "../workspace/types";
import { refreshAttachmentUrl } from "../workspace/chat-transport";

function attachmentKind(
  attachment: ChatAttachment,
): "image" | "pdf" | "html" | "markdown" | "file" {
  const value = attachment.name || attachment.url || attachment.downloadUrl || "";
  if ((attachment.type || "").startsWith("image") || /\.(png|jpe?g|gif|webp)$/i.test(value)) {
    return "image";
  }
  if (attachment.type === "pdf" || /\.pdf$/i.test(value)) return "pdf";
  if (attachment.type === "html" || /\.html?$/i.test(value)) return "html";
  if (attachment.type === "markdown" || /\.mdx?$/i.test(value)) return "markdown";
  return "file";
}

/** Optional desktop bridge surface used for downloads (`window.desktopAPI`). */
type DesktopDownloadBridge = {
  attachment?: {
    save?: (url: string, fileName: string) => Promise<{ path: string } | null>;
    text?: (url: string) => Promise<string>;
  };
  openExternal?: (url: string) => Promise<void>;
};

/**
 * Read a text attachment for the in-app preview. Desktop goes through Rust:
 * the signed object hosts send no CORS headers for the app origin, so a
 * renderer fetch dies there (see `attachment_save` in the shell).
 */
async function loadAttachmentText(url: string): Promise<string> {
  const desktop = (window as Window & { desktopAPI?: DesktopDownloadBridge }).desktopAPI;
  if (desktop?.attachment?.text) return desktop.attachment.text(url);
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/**
 * Save the attachment. Desktop first asks where to save with a native
 * dialog, then Rust fetches (the webview can't — no CORS for the app
 * origin) and writes to the picked path, revealing the file afterwards.
 * Cancelling the dialog does nothing. The web uses the browser's
 * downloader, falling back to opening the URL for a manual save when the
 * signed host refuses CORS.
 */
async function downloadAttachment(
  url: string,
  filename: string,
  savedMessage?: string,
): Promise<void> {
  const desktop = (window as Window & { desktopAPI?: DesktopDownloadBridge }).desktopAPI;
  if (desktop?.attachment?.save) {
    try {
      const saved = await desktop.attachment.save(url, filename || "attachment");
      if (saved && savedMessage) toast.success(savedMessage);
      // Cancelled or saved — either way the web path must stay silent.
      return;
    } catch {
      // Dialog or write failed on the desktop side — try the web path below.
    }
  }
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
    if (desktop?.openExternal) void desktop.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
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

/** Zoom bounds relative to the fit-to-window size, plus one button step. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.25;

type ViewState = { scale: number; x: number; y: number };
/** Fit-to-window image rect in stage coordinates. */
type FitRect = { left: number; top: number; w: number; h: number };

/**
 * Fullscreen image viewer for chat attachments (Windows Photos style):
 * click the bubble image to inspect it, then zoom with the magnifier
 * buttons, the mouse wheel, or Mac trackpad scroll / pinch, and drag to
 * pan once zoomed in. The fit / "还原默认大小" button returns to the
 * fit-to-window size. Esc / backdrop click closes; download and forward
 * (copy to clipboard) stay in the toolbar.
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
  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });
  // Programmatic zooms (buttons, keyboard) ease; gestures stay 1:1.
  const [smooth, setSmooth] = useState(true);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);

  // Fit-to-window rect. The zoomed image is laid out at its real display
  // size (width/height below) instead of being blown up by a CSS transform
  // — a transform re-scales the fit-sized bitmap layer and the zoomed image
  // goes blurry, while a real layout size resamples at full resolution.
  const fit = useMemo<FitRect | null>(() => {
    if (!stageSize || !natural || !natural.w || !natural.h) return null;
    const pad = 48;
    const scale = Math.min(1, (stageSize.w - pad) / natural.w, (stageSize.h - pad) / natural.h);
    const w = natural.w * scale;
    const h = natural.h * scale;
    return { left: (stageSize.w - w) / 2, top: (stageSize.h - h) / 2, w, h };
  }, [stageSize, natural]);
  const fitRef = useRef(fit);
  fitRef.current = fit;

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setStageSize({ w: stage.clientWidth, h: stage.clientHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Keep the image covering the stage: centered whenever it is smaller
  // than the window, edges pinned to the window when it is larger.
  const clampOffset = useCallback(
    (scale: number, x: number, y: number): { x: number; y: number } => {
      const stage = stageRef.current;
      const fitNow = fitRef.current;
      if (!stage || !fitNow) return { x, y };
      const axis = (scaled: number, bound: number, base: number, value: number) => {
        if (scaled <= bound) return (bound - scaled) / 2 - base;
        return Math.min(-base, Math.max(bound - scaled - base, value));
      };
      return {
        x: axis(fitNow.w * scale, stage.clientWidth, fitNow.left, x),
        y: axis(fitNow.h * scale, stage.clientHeight, fitNow.top, y),
      };
    },
    [],
  );

  const stagePoint = (event: { clientX: number; clientY: number }) => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null;
  };

  /** Zoom to an absolute scale, keeping stage point (px, py) stationary. */
  const zoomTo = useCallback(
    (target: number, px: number | null, py: number | null) => {
      setView((prev) => {
        const stage = stageRef.current;
        const fitNow = fitRef.current;
        const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target));
        if (!stage || !fitNow) return { ...prev, scale };
        const sx = px ?? stage.clientWidth / 2;
        const sy = py ?? stage.clientHeight / 2;
        const ux = (sx - fitNow.left - prev.x) / prev.scale;
        const uy = (sy - fitNow.top - prev.y) / prev.scale;
        return {
          scale,
          ...clampOffset(scale, sx - fitNow.left - ux * scale, sy - fitNow.top - uy * scale),
        };
      });
    },
    [clampOffset],
  );

  const resetView = useCallback(() => {
    setSmooth(true);
    zoomTo(1, null, null);
  }, [zoomTo]);

  // Wheel = zoom, following the Windows Photos viewer: the mouse wheel on
  // Windows, two-finger scroll on the Mac trackpad, and pinch (delivered
  // as ctrl+wheel) on precision touchpads. React registers wheel passively,
  // so this listener is added manually to allow preventDefault.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setSmooth(false);
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      // Pinch deltas are tiny and need a coarser factor than wheel notches.
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0022));
      const point = stagePoint(event);
      setView((prev) => {
        const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.scale * factor));
        const fitNow = fitRef.current;
        if (!fitNow) return { ...prev, scale };
        const sx = point?.x ?? stage.clientWidth / 2;
        const sy = point?.y ?? stage.clientHeight / 2;
        const ux = (sx - fitNow.left - prev.x) / prev.scale;
        const uy = (sy - fitNow.top - prev.y) / prev.scale;
        return {
          scale,
          ...clampOffset(scale, sx - fitNow.left - ux * scale, sy - fitNow.top - uy * scale),
        };
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [clampOffset]);

  // Mac trackpad pinch under WKWebView arrives as Safari gesture events,
  // not ctrl+wheel. `scale` is cumulative from gesturestart, so the base
  // view is captured there.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let base = 1;
    const start = (event: Event) => {
      event.preventDefault();
      base = viewRef.current.scale;
    };
    const change = (event: Event) => {
      const gesture = event as Event & { scale: number; clientX: number; clientY: number };
      event.preventDefault();
      setSmooth(false);
      const point = stagePoint(gesture);
      zoomTo(base * (gesture.scale || 1), point?.x ?? null, point?.y ?? null);
    };
    stage.addEventListener("gesturestart", start);
    stage.addEventListener("gesturechange", change);
    return () => {
      stage.removeEventListener("gesturestart", start);
      stage.removeEventListener("gesturechange", change);
    };
  }, [zoomTo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "+" || (event.ctrlKey && event.key === "=")) {
        setSmooth(true);
        zoomTo(viewRef.current.scale * ZOOM_STEP, null, null);
      }
      if (event.key === "-" || (event.ctrlKey && event.key === "-")) {
        setSmooth(true);
        zoomTo(viewRef.current.scale / ZOOM_STEP, null, null);
      }
      if (event.key === "0") resetView();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, zoomTo, resetView]);

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

  const zoomButton =
    "flex items-center justify-center rounded-full p-2 text-white transition-colors hover:bg-white/15 disabled:pointer-events-none disabled:opacity-40";

  return (
    <AnimatePresence>
      <motion.div
        ref={stageRef}
        data-testid="chat-image-stage"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        className="fixed inset-0 z-[90] select-none overflow-hidden bg-black/85 backdrop-blur-sm"
        onClick={onClose}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) =>
            setNatural({
              w: event.currentTarget.naturalWidth,
              h: event.currentTarget.naturalHeight,
            })
          }
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setSmooth(false);
            dragRef.current = {
              id: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              baseX: view.x,
              baseY: view.y,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.id !== event.pointerId) return;
            setView((prev) => ({
              ...prev,
              ...clampOffset(
                prev.scale,
                drag.baseX + event.clientX - drag.startX,
                drag.baseY + event.clientY - drag.startY,
              ),
            }));
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          onClick={(event) => event.stopPropagation()}
          style={{
            position: "absolute",
            left: fit ? fit.left + view.x : 0,
            top: fit ? fit.top + view.y : 0,
            width: fit ? fit.w * view.scale : undefined,
            height: fit ? fit.h * view.scale : undefined,
            visibility: fit ? "visible" : "hidden",
            transition: smooth
              ? "left 180ms ease-out, top 180ms ease-out, width 180ms ease-out, height 180ms ease-out"
              : "none",
          }}
          className={cn(
            "rounded-lg shadow-2xl outline outline-1 -outline-offset-1 outline-white/10",
            view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
          )}
        />

        <button
          type="button"
          title="Close"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full bg-neutral-900/90 p-2 text-white ring-1 ring-white/15 transition-colors hover:bg-neutral-800"
        >
          <X className="size-4" />
        </button>

        <div
          className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-neutral-900/90 p-1.5 text-white shadow-2xl ring-1 ring-white/15 backdrop-blur"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            data-testid="chat-image-zoom-out"
            title={t("chat.image_zoom_out")}
            disabled={view.scale <= ZOOM_MIN}
            onClick={() => {
              setSmooth(true);
              zoomTo(view.scale / ZOOM_STEP, null, null);
            }}
            className={zoomButton}
          >
            <ZoomOut className="size-4" />
          </button>
          <span
            data-testid="chat-image-zoom-level"
            className="min-w-12 text-center text-sm tabular-nums text-white"
          >
            {Math.round(view.scale * 100)}%
          </span>
          <button
            type="button"
            data-testid="chat-image-zoom-in"
            title={t("chat.image_zoom_in")}
            disabled={view.scale >= ZOOM_MAX}
            onClick={() => {
              setSmooth(true);
              zoomTo(view.scale * ZOOM_STEP, null, null);
            }}
            className={zoomButton}
          >
            <ZoomIn className="size-4" />
          </button>
          <button
            type="button"
            data-testid="chat-image-zoom-reset"
            title={t("chat.image_zoom_fit")}
            onClick={resetView}
            className={zoomButton}
          >
            <Fullscreen className="size-4" />
          </button>
          <span className="mx-1 h-4 w-px bg-white/20" />
          <button
            type="button"
            data-testid="chat-image-download"
            title={t("chat.attachment_download")}
            onClick={() => void downloadAttachment(src, alt, t("chat.attachment_download_done"))}
            className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-white transition-colors hover:bg-white/15"
          >
            <Download className="size-4" />
            {t("chat.attachment_download")}
          </button>
          <button
            type="button"
            data-testid="chat-image-forward"
            title={t("chat.attachment_forward")}
            onClick={() => void handleForward()}
            className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-white transition-colors hover:bg-white/15"
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
  const [downloading, setDownloading] = useState(false);
  const { href, imgSrc, refresh } = useAttachmentUrls(attachment);
  if (!href) return null;
  const kind = attachmentKind(attachment);
  const name = attachment.name || "附件";

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

  if (kind === "markdown") {
    return (
      <MarkdownAttachmentCard
        attachment={attachment}
        name={name}
        href={href}
        refresh={refresh}
      />
    );
  }

  // Nothing below navigates. A signed URL in an <a href> or an <iframe src>
  // puts the object host, key and signature in the address bar and the status
  // bar, so the bytes land on disk first and the user's own app opens them.
  const filename = kind === "pdf" && !/\.pdf$/i.test(name) ? `${name}.pdf` : name;
  const openLocally = () => {
    if (downloading) return;
    setDownloading(true);
    void (async () => {
      try {
        const fresh = attachment.id ? await refresh() : null;
        const url = fresh || href;
        if (!url) return;
        await downloadAttachment(url, filename);
      } finally {
        setDownloading(false);
      }
    })();
  };

  if (kind === "pdf") {
    // WeChat-style file card: icon + filename, tap to download locally —
    // no inline preview, the PDF viewer is the user's own app.
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

  return (
    <button
      type="button"
      onClick={openLocally}
      className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      {kind === "html" && (
        <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
          HTML
        </span>
      )}
      {downloading ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Download className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

/**
 * Markdown attachment: a card that opens the document inside the app instead
 * of handing the user a bucket URL. The body is fetched lazily on first open
 * and kept for the lifetime of the message.
 */
function MarkdownAttachmentCard({
  attachment,
  name,
  href,
  refresh,
}: {
  attachment: ChatAttachment;
  name: string;
  href: string;
  refresh: () => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next || text != null) return;
    setFailed(false);
    void (async () => {
      // Re-sign first: the URL stored in history may already be dead.
      const fresh = attachment.id ? await refresh() : null;
      try {
        setText(await loadAttachmentText(fresh || href));
      } catch {
        setFailed(true);
      }
    })();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
      >
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
        <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
          MD
        </span>
        <Eye className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <DialogContent className="max-w-3xl gap-0 p-0">
        <DialogHeader className="border-b border-border/50 px-5 py-4">
          <DialogTitle className="truncate text-sm">{name}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {failed ? (
            <p className="text-sm text-muted-foreground">{t("chat.attachment_preview_failed")}</p>
          ) : text == null ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <Markdown mode="full" className="text-sm">
              {text}
            </Markdown>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
