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
  Image as ImageIcon,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "../icons";
import { MilkdownViewer } from "../workspace/milkdown-viewer";
import { getDesktopInspirationApi } from "./desktop-api";
import { useInspirationDetailStore } from "./detail-store";
import { formatCardDateTime } from "./format";
import { parseHashtags } from "./tags";
import { InspirationAudioPlayer } from "./audio-player";
import { InspirationLightbox, type LightboxSlide } from "./lightbox";
import { InspirationMarkdownEditor } from "./markdown-editor";
import type { InspirationImage, InspirationRecord, InspirationStagedImage } from "./types";

const MAX_IMAGES = 9;

/** Xiaohongshu-style detail: images on top, content below; editable in place. */
export function InspirationDetailDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const activeId = useInspirationDetailStore((state) => state.activeId);
  const closeDetail = useInspirationDetailStore((state) => state.closeDetail);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [editText, setEditText] = useState("");
  const [keptImages, setKeptImages] = useState<InspirationImage[]>([]);
  const [pendingImages, setPendingImages] = useState<InspirationStagedImage[]>([]);
  const [saving, setSaving] = useState(false);
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
  const images = record?.images ?? [];
  const slides: LightboxSlide[] = images
    .map((image) => ({ url: urls[image.file] ?? "", label: image.file }))
    .filter((slide) => slide.url);

  const resetEditState = useCallback(() => {
    setEditText("");
    setKeptImages([]);
    setPendingImages([]);
  }, []);

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return;
      resetEditState();
      setMode("view");
      closeDetail();
    },
    [closeDetail, resetEditState],
  );

  const startEdit = useCallback(() => {
    if (!record) return;
    setEditText(record.text);
    setKeptImages(record.images ?? []);
    setPendingImages([]);
    setMode("edit");
  }, [record]);

  const handlePickImages = useCallback(async () => {
    if (!desktopApi) return;
    try {
      const picked = await desktopApi.pickImages();
      for (const path of picked) {
        const staged = await desktopApi.stageImageFromPath(path);
        setPendingImages((current) => {
          if (keptImages.length + current.length >= MAX_IMAGES) {
            toast.warning(t("inspiration.image_limit", { count: MAX_IMAGES }));
            return current;
          }
          return [...current, { sourcePath: staged.path, previewUrl: staged.url }];
        });
      }
    } catch (error) {
      toast.error(String(error));
    }
  }, [desktopApi, keptImages.length, t]);

  const handleSave = useCallback(async () => {
    const api = getDesktopInspirationApi();
    if (!api || !record || saving) return;
    setSaving(true);
    try {
      await api.save({
        id: record.id,
        text: editText,
        tags: parseHashtags(editText),
        images: keptImages.map((image) => ({ file: image.file })),
        ...(pendingImages.length
          ? {
              pendingImages: pendingImages.map(({ sourcePath, width, height }) => ({
                sourcePath,
                width,
                height,
              })),
            }
          : {}),
      });
      void queryClient.invalidateQueries({ queryKey: ["inspirations"] });
      toast.success(t("inspiration.toast_saved"));
      resetEditState();
      setMode("view");
    } catch (error) {
      toast.error(t("inspiration.toast_save_failed"), { description: String(error) });
    } finally {
      setSaving(false);
    }
  }, [editText, keptImages, pendingImages, queryClient, record, resetEditState, saving, t]);

  if (!activeId) {
    return null;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        {record && (
          <DialogContent
            className="flex max-h-[86vh] w-[min(760px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[min(760px,calc(100vw-2rem))]"
          >
            {mode === "view" ? (
              <DetailView
                record={record}
                slides={slides}
                onOpenLightbox={setLightboxIndex}
                onEdit={startEdit}
                onDelete={() => {
                  setDeleting(true);
                  deleteMutation.mutate(record.id);
                }}
                deleting={deleting}
              />
            ) : (
              <EditView
                record={record}
                onTextChange={setEditText}
                keptImages={keptImages}
                onRemoveKept={(file) => setKeptImages((current) => current.filter((image) => image.file !== file))}
                pendingImages={pendingImages}
                onRemovePending={(sourcePath) =>
                  setPendingImages((current) => current.filter((image) => image.sourcePath !== sourcePath))
                }
                onAddImages={() => void handlePickImages()}
                canAddImages={keptImages.length + pendingImages.length < MAX_IMAGES}
                saving={saving}
                onSave={() => void handleSave()}
                onCancel={() => {
                  resetEditState();
                  setMode("view");
                }}
              />
            )}
          </DialogContent>
        )}
      </Dialog>

      <InspirationLightbox
        slides={mode === "view" ? slides : []}
        index={mode === "view" ? lightboxIndex : null}
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
              className="mx-auto max-h-[46vh] w-full object-contain"
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
                      "h-1.5 rounded-full transition-all",
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

function EditView({ record, onTextChange, keptImages, onRemoveKept, pendingImages, onRemovePending, onAddImages, canAddImages, saving, onSave, onCancel }: {
  record: InspirationRecord;
  onTextChange: (value: string) => void;
  keptImages: InspirationImage[];
  onRemoveKept: (file: string) => void;
  pendingImages: InspirationStagedImage[];
  onRemovePending: (sourcePath: string) => void;
  onAddImages: () => void;
  canAddImages: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
      <div className="flex items-center justify-between">
        <span className="text-3xs font-medium text-foreground/80">{t("inspiration.edit")}</span>
        <Button variant="ghost" size="icon-sm" title={t("inspiration.edit_cancel")} onClick={onCancel}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {keptImages.map((image) => (
          <div key={image.file} className="group relative size-20 overflow-hidden rounded-lg bg-muted">
            <ImageThumbnail recordId={record.id} file={image.file} />
            <button
              type="button"
              title={t("inspiration.image_remove")}
              onClick={() => onRemoveKept(image.file)}
              className="absolute right-1 top-1 rounded-full bg-black/50 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        {pendingImages.map((image) => (
          <div key={image.sourcePath} className="group relative size-20 overflow-hidden rounded-lg bg-muted">
            <img src={image.previewUrl} alt="" className="size-full object-cover" />
            <button
              type="button"
              title={t("inspiration.image_remove")}
              onClick={() => onRemovePending(image.sourcePath)}
              className="absolute right-1 top-1 rounded-full bg-black/50 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          title={t("inspiration.add_image")}
          disabled={!canAddImages}
          onClick={onAddImages}
          className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 text-muted-foreground transition-colors hover:bg-muted/50 disabled:opacity-40"
        >
          <ImageIcon className="size-4" />
        </button>
      </div>

      <InspirationMarkdownEditor
        initialContent={record.text}
        onChange={onTextChange}
        autoFocus
      />

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("inspiration.edit_cancel")}
        </Button>
        <Button size="sm" disabled={saving} onClick={onSave}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("inspiration.edit_save")}
        </Button>
      </div>
    </div>
  );
}

function ImageThumbnail({ recordId, file }: { recordId: string; file: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getDesktopInspirationApi()?.getImageUrl(recordId, file).then((next) => {
      if (!cancelled && next) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [file, recordId]);
  if (!url) return <div className="size-full animate-pulse bg-muted" />;
  return <img src={url} alt="" className="size-full object-cover" />;
}
