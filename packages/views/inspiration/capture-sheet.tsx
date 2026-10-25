"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@lynse/ui/components/ui/button";
import { Sheet, SheetContent } from "@lynse/ui/components/ui/sheet";
import { cn } from "@lynse/ui/lib/utils";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { featureFlags } from "../feature-flags";
import { ArrowRight, Camera, Hash, Image as ImageIcon, Lightbulb, ListChecks, Loader2, Mic, Send, X, LockKeyhole, LockKeyholeOpen, Paperclip } from "../icons";
import { useNavigation } from "../navigation";
import { AudioVisualizer } from "../live-translation/audio-visualizer";
import { getDesktopInspirationApi } from "./desktop-api";
import { useInspirationCaptureStore, type CaptureMode } from "./capture-store";
import { ensureInspirationUnlocked, privacyError, useInspirationPrivacy } from "./privacy-state";
import { parseHashtags, splitByHashRuns, stripHashtags } from "./tags";
import { formatVoiceDuration, useInspirationVoice } from "./use-inspiration-voice";
import { saveTodo, type TodoItem } from "../todo/todo-api";
import { useTodoStore } from "../todo/use-todos";
import {
  LINK_RECORD_TAG,
  type InspirationImage,
  type InspirationFile,
  type InspirationStagedFile,
  type InspirationStagedImage,
  type InspirationVoiceStopResult,
} from "./types";

function captureSession() {
  const privacy = useInspirationPrivacy.getState();
  const capture = useInspirationCaptureStore.getState();
  return () => {
    const current = useInspirationPrivacy.getState();
    const sheet = useInspirationCaptureStore.getState();
    return !current.binding && current.accountScope === privacy.accountScope && current.generation === privacy.generation && sheet.open && sheet.editId === capture.editId;
  };
}

/** Xiaohongshu-style cap: nine images per inspiration. */
const MAX_IMAGES = 9;

/** Quick due-date choices offered when capturing a todo. */
type DueChoice = "none" | "today" | "tomorrow";

const DUE_CHOICES: Array<{ value: DueChoice; labelKey: string }> = [
  { value: "none", labelKey: "inspiration.due_none" },
  { value: "today", labelKey: "inspiration.due_today" },
  { value: "tomorrow", labelKey: "inspiration.due_tomorrow" },
];

/** Date-only local ISO (`YYYY-MM-DD`) — the todo page's due display has a
 * dedicated branch for it, and its grouping reads it back with `new Date`. */
function dueDateValue(choice: DueChoice): string | undefined {
  if (choice === "none") return undefined;
  const date = new Date();
  if (choice === "tomorrow") date.setDate(date.getDate() + 1);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Mirrors `use-todos.ts` — client-minted ids keep the localStorage fallback
 * usable (the Rust bridge preserves provided ids too). */
function newTodoId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
 * the sidebar inspiration icon is clicked (or "记一条" on the feed page, or
 * the home quick-capture bar). The single composer for notes and quick todos,
 * and also the editor for existing records (opened via `openEdit` from the
 * detail dialog — prefilled, with the same tag highlighting and quick tag
 * picker). It opens in the mode requested by the capture store (note by
 * default); notes accept plain text with inline `#tags`, quick voice memos,
 * and image attachments (file picker, clipboard paste, or macOS Continuity
 * Camera from the paired iPhone); todos are text-only with a quick due-date
 * chip. Attachments are staged by the desktop shell and adopted into durable
 * storage when the memo is saved; an edit keeps the record's saved images
 * unless removed and never touches its audio/transcript.
 */
export function InspirationCaptureSheet() {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const queryClient = useQueryClient();
  const open = useInspirationCaptureStore((state) => state.open);
  const storeMode = useInspirationCaptureStore((state) => state.mode);
  const editId = useInspirationCaptureStore((state) => state.editId);
  const closeCapture = useInspirationCaptureStore((state) => state.closeCapture);
  const [mode, setMode] = useState<CaptureMode>("note");
  const [due, setDue] = useState<DueChoice>("none");
  const [text, setText] = useState("");
  const [audio, setAudio] = useState<InspirationVoiceStopResult | null>(null);
  const [images, setImages] = useState<InspirationStagedImage[]>([]);
  /** Already-saved images of the record being edited (kept files). */
  const [keptImages, setKeptImages] = useState<InspirationImage[]>([]);
  const [files, setFiles] = useState<InspirationStagedFile[]>([]);
  const [keptFiles, setKeptFiles] = useState<InspirationFile[]>([]);
  const [protection, setProtection] = useState<"plain" | "e2ee">("plain");
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const accountScope = useInspirationPrivacy((s) => s.accountScope);
  const generation = useInspirationPrivacy((s) => s.generation);
  const binding = useInspirationPrivacy((s) => s.binding);
  const [saving, setSaving] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const prefilledEditId = useRef<string | null>(null);

  // Adopt the opener's mode each time the sheet opens (the store resets to
  // note on close, which also restores this local state for the next open).
  useEffect(() => {
    if (open) {
      setMode(storeMode);
      setDue("none");
    }
  }, [open, storeMode]);

  const onVoiceError = useCallback((message: string) => toast.error(message), []);
  const voice = useInspirationVoice(onVoiceError);
  // Voice input is gated off by flag — with it off, `voice.start()` is
  // unreachable, so `recording` stays false and the mic UI never renders.
  const voiceEnabled = featureFlags.inspirationVoiceCapture;
  const recording = voiceEnabled && voice.phase !== "idle";
  const desktopApi = getDesktopInspirationApi();
  const isMac = (window as Window & { desktopAPI?: { appInfo?: { platform?: string } } }).desktopAPI?.appInfo?.platform === "darwin";

  const tags = useMemo(() => parseHashtags(text), [text]);
  const todoTitle = useMemo(() => stripHashtags(text), [text]);

  // Shares the feed's query cache so the picker reflects existing tags even
  // when the capture sheet is opened from the home page before visiting it.
  const { data: inspirations = [] } = useQuery({
    queryKey: ["inspirations", accountScope],
    queryFn: () => desktopApi!.list(),
    enabled: Boolean(desktopApi) && !binding,
  });
  const { data: editingRecord } = useQuery({
    queryKey: ["inspiration-detail", accountScope, editId, generation],
    queryFn: () => desktopApi!.read!(editId!),
    enabled: !!desktopApi?.read && !!editId && open && !binding,
    gcTime: 0,
  });
  // Quick-picker source: tags ranked by how many records use them; the
  // reserved link-collection tag stays out of the picker.
  const frequentTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of inspirations) {
      for (const tag of new Set(parseHashtags(record.text))) {
        if (tag === LINK_RECORD_TAG) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag]) => tag);
  }, [inspirations]);

  // Editing reuses this composer: prefill once per opened record from the
  // shared query cache. The ref guard keeps later refetches from clobbering
  // in-progress edits.
  useEffect(() => {
    if (!open || !editId) {
      prefilledEditId.current = null;
      return;
    }
    if (prefilledEditId.current === editId) return;
    const record = editingRecord ?? inspirations.find((item) => item.id === editId);
    if (record?.locked) return;
    if (!record) return;
    prefilledEditId.current = editId;
    setText(record.text);
    setKeptImages(record.images ?? []);
    setKeptFiles(record.files ?? []);
    setProtection(record.protection ?? "plain");
    setImages([]);
    setAudio(null);
    setDue("none");
    setMode("note");
    setTagPickerOpen(false);
  }, [open, editId, inspirations, editingRecord]);

  const canSave =
    saving
      ? false
      : editId
        ? true
        : mode === "todo"
          ? Boolean(todoTitle)
          : Boolean(text.trim() || audio || images.length || files.length || keptFiles.length);

  const reset = useCallback(() => {
    setText("");
    setAudio(null);
    setImages([]);
    setKeptImages([]);
    setFiles([]);
    setKeptFiles([]);
    setProtection("plain");
    setDue("none");
    setMode("note");
    setTagPickerOpen(false);
  }, []);

  useEffect(() => {
    reset();
    if (binding) closeCapture();
  }, [accountScope, binding, reset, closeCapture]);

  /** Complete a tag at the caret. When the caret sits right after a dangling
   * `#` (dropped by the # button when the picker opened), only the tag name
   * is appended — no second hash. */
  const insertTag = useCallback(
    (tag: string) => {
      const start = textareaRef.current?.selectionStart ?? text.length;
      const end = textareaRef.current?.selectionEnd ?? start;
      const dangling = /#$/.test(text.slice(0, start));
      const glue = !dangling && start > 0 && /[a-zA-Z0-9/#]/.test(text.charAt(start - 1));
      const token = dangling ? `${tag} ` : `${glue ? " " : ""}#${tag} `;
      setText(text.slice(0, start) + token + text.slice(end));
      pendingCaret.current = start + token.length;
    },
    [text],
  );

  /** The # button: drops a bare `#` at the caret and opens the quick-tag bar,
   * so picking a tag completes that hash. Clicking again just closes the bar
   * (a stray `#` stays as plain text, which the lexer ignores). */
  const handleHashButton = useCallback(() => {
    if (tagPickerOpen) {
      setTagPickerOpen(false);
      return;
    }
    const start = textareaRef.current?.selectionStart ?? text.length;
    const end = textareaRef.current?.selectionEnd ?? start;
    const needsSpace = start > 0 && !/\s/.test(text.charAt(start - 1));
    const token = `${needsSpace ? " " : ""}#`;
    setText(text.slice(0, start) + token + text.slice(end));
    pendingCaret.current = start + token.length;
    setTagPickerOpen(true);
  }, [tagPickerOpen, text]);

  // Restore the caret after the controlled textarea re-renders with the
  // inserted `#tag` token.
  useEffect(() => {
    if (pendingCaret.current === null) return;
    const element = textareaRef.current;
    if (element) {
      element.focus();
      element.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
  }, [text]);

  /** Keep the highlight backdrop scrolled in step with the textarea (both
   * share identical text metrics, so offsets map 1:1). */
  const syncHighlightScroll = useCallback(() => {
    if (highlightRef.current && textareaRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
    }
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
    async (staged: { path: string; url: string }, current = captureSession()) => {
      if (!current()) return;
      setImages((current) => {
        if (keptImages.length + current.length >= MAX_IMAGES) {
          toast.warning(t("inspiration.image_limit", { count: MAX_IMAGES }));
          return current;
        }
        return [...current, { sourcePath: staged.path, previewUrl: staged.url }];
      });
      const dimensions = await probeDimensions(staged.url);
      if (!current()) return;
      setImages((current) =>
        current.map((image) =>
          image.sourcePath === staged.path ? { ...image, ...dimensions } : image,
        ),
      );
    },
    [keptImages.length, t],
  );

  const handlePickImages = useCallback(async () => {
    if (!desktopApi) return;
    const current = captureSession();
    try {
      const picked = await desktopApi.pickImages();
      if (!current()) return;
      for (const path of picked) {
        const staged = await desktopApi.stageImageFromPath(path);
        await addStagedImage(staged, current);
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
      const current = captureSession();
      if (isMac) {
        try {
          const staged = await api.stageImageFromClipboard();
          await addStagedImage(staged, current);
          return;
        } catch {
          /* nothing usable on the pasteboard — fall through to raw transfer */
        }
      }
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!current()) return;
          const staged = await api.stageImage(bytes);
          await addStagedImage(staged, current);
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

  /** Drop a saved image from the record being edited (deleted on save). */
  const handleRemoveKept = useCallback((file: string) => {
    setKeptImages((current) => current.filter((image) => image.file !== file));
  }, []);

  /**
   * Single save entry, branched by capture mode. The planned AI classifier
   * hooks into the note branch: after the note lands, classify it async and
   * promote it to a todo when it looks like one.
   */
  useEffect(() => {
    const locked = () => { if (protection === "e2ee") { reset(); closeCapture(); } };
    window.addEventListener("inspiration-private-lock", locked);
    return () => window.removeEventListener("inspiration-private-lock", locked);
  }, [protection, reset, closeCapture]);

  const togglePrivacy = async () => {
    setPrivacyBusy(true);
    try {
      if (!(await ensureInspirationUnlocked())) return;
      if (editId) {
        const result = await desktopApi!.privacy!.toggle(editId);
        setProtection(result.protection ?? "plain");
        void queryClient.invalidateQueries({ queryKey: ["inspirations"] });
      } else { setProtection((current) => current === "plain" ? "e2ee" : "plain"); }
    } catch (error) { toast.error(privacyError(error, t)); } finally { setPrivacyBusy(false); }
  };
  const pickFiles = async () => {
    const current = captureSession();
    try {
      if (!(await desktopApi?.privacy?.status())?.enabled) throw new Error("private_storage_unavailable");
      const paths = await desktopApi?.pickFiles?.() ?? [];
      if (!current()) return;
      if (paths.length + files.length + keptFiles.length > 20) throw new Error("too_many_attachments");
      const staged: InspirationStagedFile[] = [];
      for (const path of paths) {
        const file = await desktopApi!.stageFile!(path);
        staged.push({ sourcePath: file.path, name: file.name, mime: file.mime, size: file.size });
      }
      if (!current()) return;
      setFiles((previous) => [...previous, ...staged]);
    } catch (error) { toast.error(privacyError(error, t)); }
  };

  const persist = useCallback(async () => {
    if (saving || privacyBusy) return;
    if (protection === "e2ee" && !(await ensureInspirationUnlocked())) return;
    if (mode === "todo") {
      if (!todoTitle) return;
      setSaving(true);
      try {
        const now = new Date().toISOString();
        const dueDate = dueDateValue(due);
        const todo: TodoItem = {
          id: newTodoId(),
          title: todoTitle,
          completed: false,
          ...(dueDate ? { dueDate } : {}),
          createdAt: now,
          updatedAt: now,
          backend: false,
        };
        const saved = await saveTodo(todo);
        // Publish into the shared todo store so the todo page / home feed
        // pick the new item up without waiting for their next load.
        useTodoStore.getState().upsert(saved);
        toast.success(t("inspiration.toast_todo_saved"));
        reset();
        closeCapture();
      } catch (error) {
        toast.error(t("inspiration.toast_save_failed"), { description: String(error) });
      } finally {
        setSaving(false);
      }
      return;
    }
    // Edit of an existing record: same composer, but the payload keeps the
    // record's saved images (files missing from the keep-list are deleted)
    // and never touches its audio/transcript.
    if (editId) {
      const api = getDesktopInspirationApi();
      if (!api) return;
      setSaving(true);
      try {
        await api.save({
          id: editId,
          protection,
          files: keptFiles.map(({ file }) => ({ file })),
          pendingFiles: files,
          text,
          tags: parseHashtags(text),
          images: keptImages.map((image) => ({ file: image.file })),
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
        void queryClient.invalidateQueries({ queryKey: ["inspirations"] });
        toast.success(t("inspiration.toast_saved"));
        reset();
        closeCapture();
      } catch (error) {
        toast.error(t("inspiration.toast_save_failed"), { description: String(error) });
      } finally {
        setSaving(false);
      }
      return;
    }
    const api = getDesktopInspirationApi();
    if (!api || (!text.trim() && !audio && images.length === 0 && files.length === 0)) return;
    setSaving(true);
    try {
      const saved = await api.save({
        protection,
        pendingFiles: files,
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
      if (audio && protection !== "e2ee") void api.transcribe(saved.id).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: ["inspirations"] });
      toast.success(t("inspiration.toast_saved"));
      reset();
      closeCapture();
    } catch (error) {
      toast.error(t("inspiration.toast_save_failed"), { description: String(error) });
    } finally {
      setSaving(false);
    }
  }, [audio, closeCapture, due, editId, images, keptImages, mode, queryClient, reset, saving, t, text, todoTitle, files, keptFiles, protection, privacyBusy]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void persist();
      }
    },
    [persist],
  );

  /** Leave the popup for the feed of the active mode. */
  const handleViewAll = useCallback(() => {
    reset();
    closeCapture();
    push(mode === "todo" ? "/todo" : "/inspiration");
  }, [closeCapture, mode, push, reset]);

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
          <div className="flex min-h-[208px] flex-col gap-2 p-4 pt-3">
            {/* Fixed base height so both capture modes render the same sheet
                size; the textarea flexes to absorb the leftover space. */}
            {protection === "e2ee" && <p className="text-xs text-muted-foreground">{t("inspiration_private.no_ai")}</p>}
            {(files.length > 0 || keptFiles.length > 0) && <div className="flex flex-col gap-1">
              {keptFiles.map((file) => <div key={file.file} className="flex items-center gap-2 text-xs"><Paperclip className="size-3.5" /><span className="min-w-0 flex-1 truncate">{file.name}</span><button type="button" aria-label={t("inspiration.image_remove")} onClick={() => setKeptFiles((current) => current.filter((item) => item.file !== file.file))}><X className="size-3.5" /></button></div>)}
              {files.map((file) => <div key={file.sourcePath} className="flex items-center gap-2 text-xs"><Paperclip className="size-3.5" /><span className="min-w-0 flex-1 truncate">{file.name}</span><button type="button" aria-label={t("inspiration.image_remove")} onClick={() => setFiles((current) => current.filter((item) => item.sourcePath !== file.sourcePath))}><X className="size-3.5" /></button></div>)}
            </div>}
            <div className="flex items-center justify-between">
              {editId ? (
                <span className="px-1 text-xs font-medium text-foreground">
                  {t("inspiration.edit")}
                </span>
              ) : (
                <div className="flex items-center rounded-full bg-muted/70 p-0.5">
                  <button
                    type="button"
                    aria-pressed={mode === "note"}
                    onClick={() => setMode("note")}
                    className={cn(
                      "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                      mode === "note"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Lightbulb className="size-3" />
                    {t("inspiration.mode_note")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "todo"}
                    disabled={recording}
                    onClick={() => setMode("todo")}
                    className={cn(
                      "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                      mode === "todo"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <ListChecks className="size-3" />
                    {t("inspiration.mode_todo")}
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={handleViewAll}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("inspiration.view_all")}
                <ArrowRight className="size-3" />
              </button>
            </div>
            <div className="relative max-h-48 min-h-[72px] w-full flex-1">
              {/* Highlight backdrop mirroring the textarea's text metrics:
                  every `#…` run (up to the next whitespace) is painted in the
                  accent color while the textarea itself renders its text
                  transparent, keeping only the caret and selection. Tag runs
                  shrink via transform only — layout keeps the body font size,
                  so line breaks and the caret still line up 1:1. Trailing
                  newline preserves the final line's height. */}
              <div
                ref={highlightRef}
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
              >
                {splitByHashRuns(text).map((segment, index) =>
                  segment.tag ? (
                    <span
                      key={index}
                      className="inline-block origin-left scale-[0.857] text-accent-brand-text"
                    >
                      {segment.text}
                    </span>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
                )}
                {"\n"}
              </div>
              <textarea
                ref={textareaRef}
                autoFocus
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={(event) => void handlePaste(event)}
                onScroll={syncHighlightScroll}
                placeholder={
                  mode === "todo"
                    ? t("inspiration.todo_placeholder")
                    : t("inspiration.capture_placeholder")
                }
                className="relative size-full resize-none bg-transparent p-0 text-sm leading-relaxed text-transparent caret-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </div>
            {mode === "note" && (images.length > 0 || keptImages.length > 0) && (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={tagPickerOpen}
                  title={t("inspiration.add_tag")}
                  onClick={handleHashButton}
                >
                  <Hash className="size-4" />
                </Button>
                <div className="grid flex-1 grid-cols-3 gap-1.5">
                  {keptImages.map((image) => (
                    <div
                      key={image.file}
                      className="group relative aspect-square overflow-hidden rounded-lg bg-muted"
                    >
                      <SavedImageThumbnail recordId={editId!} file={image.file} />
                      <button
                        type="button"
                        title={t("inspiration.image_remove")}
                        onClick={() => handleRemoveKept(image.file)}
                        className="absolute right-1 top-1 rounded-full bg-black/50 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                  {images.map((image) => (
                    <div
                      key={image.sourcePath}
                      className="group relative aspect-square overflow-hidden rounded-lg bg-muted"
                    >
                      <img
                        src={image.previewUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
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
              </div>
            )}
            {mode === "note" && tagPickerOpen && (
              <div className="rounded-xl border border-border/60 bg-muted/30 p-2">
                <p className="mb-1.5 text-3xs text-muted-foreground">{t("inspiration.common_tags")}</p>
                {frequentTags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {frequentTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          insertTag(tag);
                          setTagPickerOpen(false);
                        }}
                        className="rounded-full bg-background px-2 py-0.5 text-3xs text-accent-brand-text transition-colors hover:bg-primary/10"
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-3xs text-muted-foreground/70">{t("inspiration.common_tags_empty")}</p>
                )}
              </div>
            )}
            {mode === "note" && audio && (
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
            {mode === "note" && tags.length > 0 && (
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
                {mode === "note" ? (
                  <>
                    {images.length === 0 && keptImages.length === 0 && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-pressed={tagPickerOpen}
                        title={t("inspiration.add_tag")}
                        onClick={handleHashButton}
                      >
                        <Hash className="size-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" title={t("inspiration_private.add_file")} aria-label={t("inspiration_private.add_file")} disabled={files.length + keptFiles.length >= 20} onClick={() => void pickFiles()}><Paperclip className="size-4" /></Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t("inspiration.add_image")}
                      disabled={images.length + keptImages.length >= MAX_IMAGES}
                      onClick={() => void handlePickImages()}
                    >
                      <ImageIcon className="size-4" />
                    </Button>
                    {isMac && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t("inspiration.iphone_camera")}
                        disabled={images.length + keptImages.length >= MAX_IMAGES}
                        onClick={() => void handleIPhone()}
                      >
                        <Camera className="size-4" />
                      </Button>
                    )}
                    {voiceEnabled && !editId && protection !== "e2ee" && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t("inspiration.record")}
                        disabled={Boolean(audio)}
                        onClick={() => void voice.start()}
                      >
                        <Mic className="size-4" />
                      </Button>
                    )}
                  </>
                ) : (
                  DUE_CHOICES.map(({ value, labelKey }) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={due === value}
                      onClick={() => setDue(value)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-3xs transition-colors",
                        due === value
                          ? "border-primary/40 bg-primary/10 text-accent-brand-text"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(labelKey)}
                    </button>
                  ))
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-3xs text-muted-foreground/70">
                  {t("inspiration.save_hint")}
                </span>
                {mode === "note" && (<Button variant="ghost" size="icon-sm" aria-label={t(protection === "e2ee" ? "inspiration_private.decrypt" : "inspiration_private.encrypt")} title={t(protection === "e2ee" ? "inspiration_private.decrypt" : "inspiration_private.encrypt")} aria-pressed={protection === "e2ee"} disabled={privacyBusy || saving || recording || !!audio} onClick={() => void togglePrivacy()}>
                      {privacyBusy ? <Loader2 className="size-4 animate-spin" /> : protection === "e2ee" ? <LockKeyhole className="size-4" /> : <LockKeyholeOpen className="size-4" />}
                    </Button>)}
                <Button
                  size="sm"
                  disabled={!canSave}
                  onClick={() => void persist()}
                >
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  {t(editId ? "inspiration.edit_save" : "inspiration.save")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** One already-saved image of the record being edited, served through
 * `local-media://`, with skeleton while the URL resolves. */
function SavedImageThumbnail({ recordId, file }: { recordId: string; file: string }) {
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
  return <img src={url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />;
}
