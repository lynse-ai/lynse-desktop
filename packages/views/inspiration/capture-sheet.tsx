"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@lynse/ui/components/ui/button";
import { Sheet, SheetContent } from "@lynse/ui/components/ui/sheet";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { ArrowRight, Camera, Image as ImageIcon, Loader2, Mic, Send, X } from "../icons";
import { useNavigation } from "../navigation";
import { AudioVisualizer } from "../live-translation/audio-visualizer";
import { getDesktopInspirationApi } from "./desktop-api";
import { useInspirationCaptureStore } from "./capture-store";
import { parseHashtags } from "./tags";
import { formatVoiceDuration, useInspirationVoice } from "./use-inspiration-voice";
import type { InspirationStagedImage, InspirationVoiceStopResult } from "./types";

/** Xiaohongshu-style cap: nine images per inspiration. */
const MAX_IMAGES = 9;

/** Read natural dimensions without `new Image()` (clashes with the icon import). */
function probeDimensions(url: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve) => {
    const element = document.createElement("img");
    element.onload = () =>
      resolve({ width: element.naturalWidth || undefined, height: element.naturalHeight || undefined });
    element.onerror = () => resolve({});
    element.src = url;
  });
}

/**
 * The flomo-style capture panel: slides up from the bottom of the window when
 * the sidebar inspiration icon is clicked (or "记一条" on the feed page).
 * Accepts plain text with inline `#tags`, quick voice memos, and image
 * attachments (file picker, clipboard paste, or macOS Continuity Camera from
 * the paired iPhone). Attachments are staged by the desktop shell and adopted
 * into durable storage when the memo is saved.
 */
export function InspirationCaptureSheet() {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const queryClient = useQueryClient();
  const open = useInspirationCaptureStore((state) => state.open);
  const closeCapture = useInspirationCaptureStore((state) => state.closeCapture);
  const [text, setText] = useState("");
  const [audio, setAudio] = useState<InspirationVoiceStopResult | null>(null);
  const [images, setImages] = useState<InspirationStagedImage[]>([]);
  const [saving, setSaving] = useState(false);

  const onVoiceError = useCallback((message: string) => toast.error(message), []);
  const voice = useInspirationVoice(onVoiceError);
  const recording = voice.phase !== "idle";
  const desktopApi = getDesktopInspirationApi();
  const isMac = (window as Window & { desktopAPI?: { appInfo?: { platform?: string } } }).desktopAPI?.appInfo?.platform === "darwin";

  const tags = useMemo(() => parseHashtags(text), [text]);
  const canSave = Boolean(text.trim() || audio || images.length) && !saving;

  const reset = useCallback(() => {
    setText("");
    setAudio(null);
    setImages([]);
  }, []);

  const handleClose = useCallback(
    async (nextOpen: boolean) => {
      if (nextOpen) return;
      // Closing the sheet discards the draft; an in-flight recording is
      // cancelled along with its captured audio. Staged images are orphaned
      // on purpose — the shell wipes the staging folder on the next launch.
      if (voice.phase !== "idle") await voice.cancel();
      reset();
      closeCapture();
    },
    [closeCapture, reset, voice],
  );

  const addStagedImage = useCallback(
    async (staged: { path: string; url: string }) => {
      setImages((current) => {
        if (current.length >= MAX_IMAGES) {
          toast.warning(t("inspiration.image_limit", { count: MAX_IMAGES }));
          return current;
        }
        return [...current, { sourcePath: staged.path, previewUrl: staged.url }];
      });
      const dimensions = await probeDimensions(staged.url);
      setImages((current) =>
        current.map((image) =>
          image.sourcePath === staged.path ? { ...image, ...dimensions } : image,
        ),
      );
    },
    [t],
  );

  const handlePickImages = useCallback(async () => {
    if (!desktopApi) return;
    try {
      const picked = await desktopApi.pickImages();
      for (const path of picked) {
        const staged = await desktopApi.stageImageFromPath(path);
        await addStagedImage(staged);
      }
    } catch (error) {
      toast.error(String(error));
    }
  }, [addStagedImage, desktopApi]);

  /** Attach image files from the clipboard (screenshots, Continuity Camera).
   * On macOS the bytes are pulled straight from the system pasteboard by the
   * shell — pushing megabytes of image data through the webview IPC froze the
   * whole app, so the raw-byte transfer is only a fallback. */
  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const api = getDesktopInspirationApi();
      if (!api) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      event.preventDefault();
      if (isMac) {
        try {
          const staged = await api.stageImageFromClipboard();
          await addStagedImage(staged);
          return;
        } catch {
          /* nothing usable on the pasteboard — fall through to raw transfer */
        }
      }
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const staged = await api.stageImage(bytes);
          await addStagedImage(staged);
        } catch (error) {
          toast.error(String(error));
        }
      }
    },
    [addStagedImage, isMac],
  );

  /** macOS Continuity Camera: the paired iPhone shoots, the photo lands as a
   * paste event on the focused textarea and flows through `handlePaste`. */
  const handleIPhone = useCallback(async () => {
    const api = getDesktopInspirationApi();
    if (!api) return;
    try {
      await api.captureFromIPhone();
    } catch (error) {
      toast.warning(String(error));
    }
  }, []);

  const handleMic = useCallback(async () => {
    if (recording) {
      const result = await voice.stop();
      if (result) setAudio(result);
      return;
    }
    if (!audio) await voice.start();
  }, [audio, recording, voice]);

  const handleRemoveAudio = useCallback(() => {
    if (recording) return;
    // The discarded WAV lives in an orphaned capture directory and is cleaned
    // up by the backend when the next memo is adopted, so no delete is needed.
    setAudio(null);
  }, [recording]);

  const handleRemoveImage = useCallback((sourcePath: string) => {
    setImages((current) => current.filter((image) => image.sourcePath !== sourcePath));
  }, []);

  const handleSave = useCallback(async () => {
    const api = getDesktopInspirationApi();
    if (!api || saving || (!text.trim() && !audio && images.length === 0)) return;
    setSaving(true);
    try {
      const saved = await api.save({
        text,
        tags: parseHashtags(text),
        ...(audio
          ? { pendingAudioPath: audio.audioPath, pendingAudioDurationMs: audio.durationMs }
          : {}),
        ...(images.length
          ? {
              pendingImages: images.map(({ sourcePath, width, height }) => ({
                sourcePath,
                width,
                height,
              })),
            }
          : {}),
      });
      // Fire-and-forget: the feed polls while any memo is `pending`.
      if (audio) void api.transcribe(saved.id).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: ["inspirations"] });
      toast.success(t("inspiration.toast_saved"));
      reset();
      closeCapture();
    } catch (error) {
      toast.error(t("inspiration.toast_save_failed"), { description: String(error) });
    } finally {
      setSaving(false);
    }
  }, [audio, closeCapture, images, queryClient, reset, saving, t, text]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void handleSave();
      }
    },
    [handleSave],
  );

  /** Leave the popup for the full feed page. */
  const handleViewAll = useCallback(() => {
    reset();
    closeCapture();
    push("/inspiration");
  }, [closeCapture, push, reset]);

  return (
    <Sheet open={open} onOpenChange={(next) => void handleClose(next)}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="data-[side=bottom]:inset-x-auto data-[side=bottom]:bottom-4 data-[side=bottom]:left-1/2 data-[side=bottom]:w-[min(560px,calc(100vw-2rem))] data-[side=bottom]:-translate-x-1/2 data-[side=bottom]:rounded-2xl data-[side=bottom]:border"
      >
        {!desktopApi ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {t("inspiration.desktop_only")}
          </p>
        ) : recording ? (
          <div className="flex items-center gap-3 p-4">
            <span className="flex items-center gap-1.5 text-3xs font-medium text-destructive">
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
              {t("inspiration.recording")}
            </span>
            <AudioVisualizer level={voice.level} active className="h-9 flex-1" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatVoiceDuration(voice.elapsedMs)}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              title={t("inspiration.record_cancel")}
              onClick={() => void voice.cancel()}
            >
              <X className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              title={t("inspiration.record_stop")}
              onClick={() => void handleMic()}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              <span className="size-2.5 rounded-[2px] bg-current" />
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-4 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-3xs font-medium text-foreground/80">{t("inspiration.title")}</span>
              <button
                type="button"
                onClick={handleViewAll}
                className="flex items-center gap-1 text-3xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("inspiration.view_all")}
                <ArrowRight className="size-3" />
              </button>
            </div>
            <textarea
              autoFocus
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={(event) => void handlePaste(event)}
              placeholder={t("inspiration.capture_placeholder")}
              className="max-h-48 min-h-[72px] w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {images.length > 0 && (
              <div className="grid grid-cols-3 gap-1.5">
                {images.map((image) => (
                  <div
                    key={image.sourcePath}
                    className="group relative aspect-square overflow-hidden rounded-lg bg-muted"
                  >
                    <img
                      src={image.previewUrl}
                      alt=""
                      className="size-full object-cover"
                    />
                    <button
                      type="button"
                      title={t("inspiration.image_remove")}
                      onClick={() => handleRemoveImage(image.sourcePath)}
                      className="absolute right-1 top-1 rounded-full bg-black/50 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {audio && (
              <div className="flex items-center gap-2 self-start rounded-full bg-muted/70 px-3 py-1.5 text-xs text-muted-foreground">
                <Mic className="size-3.5" />
                <span className="tabular-nums">{formatVoiceDuration(audio.durationMs)}</span>
                <button
                  type="button"
                  title={t("inspiration.record_remove_audio")}
                  className="rounded-full p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
                  onClick={handleRemoveAudio}
                >
                  <X className="size-3" />
                </button>
              </div>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-primary/10 px-2 py-0.5 text-3xs text-accent-brand-text"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={t("inspiration.add_image")}
                  disabled={images.length >= MAX_IMAGES}
                  onClick={() => void handlePickImages()}
                >
                  <ImageIcon className="size-4" />
                </Button>
                {isMac && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t("inspiration.iphone_camera")}
                    disabled={images.length >= MAX_IMAGES}
                    onClick={() => void handleIPhone()}
                  >
                    <Camera className="size-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={t("inspiration.record")}
                  disabled={Boolean(audio)}
                  onClick={() => void voice.start()}
                >
                  <Mic className="size-4" />
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-3xs text-muted-foreground/70">
                  {t("inspiration.save_hint")}
                </span>
                <Button
                  size="sm"
                  disabled={!canSave}
                  onClick={() => void handleSave()}
                >
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  {t("inspiration.save")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
