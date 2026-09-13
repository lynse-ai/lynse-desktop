"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@lynse/ui/lib/utils";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent } from "@lynse/ui/components/ui/dialog";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Trash2,
} from "../icons";
import { MilkdownViewer } from "../workspace/milkdown-viewer";
import { getDesktopInspirationApi } from "./desktop-api";
import { useInspirationCaptureStore } from "./capture-store";
import { useInspirationDetailStore } from "./detail-store";
import { formatCardDateTime } from "./format";
import { InspirationAudioPlayer } from "./audio-player";
import { InspirationLightbox, type LightboxSlide } from "./lightbox";
import type { InspirationRecord } from "./types";

/** Xiaohongshu-style detail: images on top, content below; read-only —
 * 编辑 hands the record to the capture sheet (the same composer as 新建). */
export function InspirationDetailDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const activeId = useInspirationDetailStore((state) => state.activeId);
  const closeDetail = useInspirationDetailStore((state) => state.closeDetail);
  const openEdit = useInspirationCaptureStore((state) => state.openEdit);
  const [deleting, setDeleting] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const desktopApi = getDesktopInspirationApi();

  // Shares the feed's query cache: edits made anywhere show up here too.
  const { data: inspirations = [] } = useQuery({
    queryKey: ["inspirations"],
    queryFn: () => desktopApi!.list(),
    enabled: Boolean(desktopApi),
    refetchInterval: (query) =>
      ((query.state.data as InspirationRecord[] | undefined) ?? []).some(
        (record) => record.transcriptStatus === "pending",
      )
        ? 3_000
        : false,
  });
  const record = inspirations.find((item) => item.id === activeId) ?? null;

  // Resolve saved image URLs once per record; staged (pending) images carry
  // their preview URL from the staging response.
  useEffect(() => {
    let cancelled = false;
    for (const image of record?.images ?? []) {
      if (urls[image.file]) continue;
      void desktopApi?.getImageUrl(record!.id, image.file).then((url) => {
        if (!cancelled && url) setUrls((prev) => ({ ...prev, [image.file]: url! }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [desktopApi, record, urls]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["inspirations"] });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => desktopApi!.delete(id),
    onSuccess: () => {
      toast.success(t("inspiration.toast_deleted"));
      void invalidate();
      closeDetail();
    },
    onSettled: () => setDeleting(false),
  });

  const open = Boolean(record);

  const handleClose = useCallback(() => {
    closeDetail();
  }, [closeDetail]);

  const handleEdit = useCallback(() => {
    if (!record) return;
    closeDetail();
    openEdit(record.id);
  }, [closeDetail, openEdit, record]);

  const images = record?.images ?? [];
  const slides: LightboxSlide[] = images
    .map((image) => ({ url: urls[image.file] ?? "", label: image.file }))
    .filter((slide) => slide.url);

  if (!activeId) {
    return null;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
        {record && (
          <DialogContent
            className="flex max-h-[86vh] w-[min(760px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[min(760px,calc(100vw-2rem))]"
          >
            <DetailView
              record={record}
              slides={slides}
              onOpenLightbox={setLightboxIndex}
              onEdit={handleEdit}
              onDelete={() => {
                setDeleting(true);
                deleteMutation.mutate(record.id);
              }}
              deleting={deleting}
            />
          </DialogContent>
        )}
      </Dialog>

      <InspirationLightbox
        slides={slides}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </>
  );
}

function DetailView({ record, slides, onOpenLightbox, onEdit, onDelete, deleting }: {
  record: InspirationRecord;
  slides: LightboxSlide[];
  onOpenLightbox: (index: number) => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [slideIndex, setSlideIndex] = useState(0);
  const images = record.images ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {images.length > 0 && slides.length > 0 && (
        <div className="relative shrink-0 bg-black/5 dark:bg-black/20">
          <button
            type="button"
            className="block w-full cursor-zoom-in"
            onClick={() => onOpenLightbox(Math.min(slideIndex, slides.length - 1))}
          >
            <img
              src={slides[Math.min(slideIndex, slides.length - 1)]?.url ?? ""}
              alt=""
              decoding="async"
              className="mx-auto max-h-[46vh] w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          </button>
          {slides.length > 1 && (
            <>
              <button
                type="button"
                title="Previous"
                onClick={() => setSlideIndex((current) => (current - 1 + slides.length) % slides.length)}
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white transition-colors hover:bg-black/60"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                title="Next"
                onClick={() => setSlideIndex((current) => (current + 1) % slides.length)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white transition-colors hover:bg-black/60"
              >
                <ChevronRight className="size-4" />
              </button>
              <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
                {slides.map((slide, index) => (
                  <button
                    key={slide.url}
                    type="button"
                    onClick={() => setSlideIndex(index)}
                    className={cn(
                      "h-1.5 rounded-full transition-[width,background-color]",
                      index === slideIndex ? "w-4 bg-white" : "w-1.5 bg-white/50",
                    )}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-3xs text-muted-foreground/70">
              {formatCardDateTime(record.createdAt, i18n.language)}
            </span>
            {record.audio && <InspirationAudioPlayer record={record} />}
            {record.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-primary/10 px-2 py-0.5 text-3xs text-accent-brand-text">
                #{tag}
              </span>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={onEdit}>
              <Pencil className="size-3.5" />
              {t("inspiration.edit")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={deleting}
              onClick={onDelete}
            >
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {t("inspiration.delete")}
            </Button>
          </div>
        </div>

        {record.text.trim() ? (
          <div className="min-h-0 text-sm leading-relaxed">
            <MilkdownViewer content={record.text} />
          </div>
        ) : null}

        {record.transcript && (
          <p className="border-l-2 border-border/60 pl-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
            {record.transcript}
          </p>
        )}
      </div>
    </div>
  );
}
