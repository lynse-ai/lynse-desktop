"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { IconSwap } from "../icon-swap";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ChevronLeft,
  Combine,
  Crop,
  Loader2,
  Pause,
  Play,
  Scissors,
  Trash2,
  VolumeX,
  Wand2,
  X,
} from "../icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@lynse/ui/components/ui/tooltip";
import { cn } from "@lynse/ui/lib/utils";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { getDesktopAudioEditorApi } from "./api";
import { TitleBarSlot } from "../layout/app-title-bar";
import { useAudioEditorStore, type AudioEditorSaveMode } from "./store";
import { EditorWaveform, type WaveformSelection } from "./editor-waveform";
import { EditorOverview } from "./editor-overview";
import { useAudioAnalysis } from "./use-audio-analysis";

type EditorMode = "trim" | "merge" | "desilence" | "enhance";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * `H:MM:SS.cs` — the trim screen's big-timer format. macOS always shows the
 * hours digit (`0:00:00.00`), even for sub-hour recordings.
 */
function formatCentis(seconds: number): string {
  const total = Math.max(0, seconds);
  const cs = Math.floor((total % 1) * 100);
  const ss = Math.floor(total) % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Total duration — `MM:SS`, hours prepended when needed. */
function formatTotal(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "00:00";
  const s = Math.round(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const base = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return hh > 0 ? `${hh}:${base}` : base;
}

/**
 * The macOS "skip 15 seconds" glyph: a circular arrow with `15` set inside.
 * `forward` mirrors it into the clockwise ↻15 variant.
 */
function GoTo15Icon({ forward, className }: { forward?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {forward ? (
        <>
          {/* lucide rotate-cw arc, arrowhead at the top right */}
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </>
      ) : (
        <>
          {/* lucide rotate-ccw arc, arrowhead at the top left */}
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </>
      )}
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        fontSize="8"
        fontWeight={700}
        stroke="none"
        fill="currentColor"
      >
        15
      </text>
    </svg>
  );
}

export function AudioEditorPage() {
  const { t, i18n } = useTranslation();
  const { push } = useNavigation();
  const queryClient = useQueryClient();
  const request = useAudioEditorStore((s) => s.request);
  const clearRequest = useAudioEditorStore((s) => s.clear);
  const api = useMemo(() => getDesktopAudioEditorApi(), []);
  const reduceMotion = useReducedMotion();

  const items = request?.items ?? [];
  const canMerge = items.length >= 2;

  const [mode, setMode] = useState<EditorMode>(canMerge ? "merge" : "trim");
  // Merge always produces a new note; every other mode defaults to replacing
  // the source recording in place.
  const [saveMode, setSaveMode] = useState<AudioEditorSaveMode>(request?.defaultSaveMode ?? "overwrite");
  const effectiveSaveMode: AudioEditorSaveMode = mode === "merge" ? "new" : saveMode;
  const [activeIndex, setActiveIndex] = useState(0);
  const activeItem = items[activeIndex] ?? null;

  // Recording date under the title, long-form per locale — the recording
  // page's header format (`2026年9月13日`).
  const recordingDate = useMemo(() => {
    if (!activeItem?.createdAt) return null;
    const date = new Date(activeItem.createdAt);
    if (isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(i18n.language, {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date);
  }, [activeItem?.createdAt, i18n.language]);

  // Audio URL per item, resolved from the local-transcription store.
  // Re-resolvable on demand: an overwrite export swaps the bytes behind the
  // same record, so the page refreshes its URLs (fresh `?v=`) when it ends.
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const resolveAudioUrls = useCallback(async (isCancelled?: () => boolean) => {
    if (!api || items.length === 0) return;
    const desktopWindow = window as Window & {
      desktopAPI?: { localTranscription?: { getAudioUrl: (id: string) => Promise<string | null> } };
    };
    const localApi = desktopWindow.desktopAPI?.localTranscription;
    if (!localApi) return;
    const entries = await Promise.all(
      items.map(async (item) => {
        const url = await localApi.getAudioUrl(item.id);
        return url ? ([item.id, url] as const) : null;
      }),
    );
    if (isCancelled?.()) return;
    setAudioUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry != null)));
  }, [api, items]);

  useEffect(() => {
    let cancelled = false;
    void resolveAudioUrls(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [resolveAudioUrls]);

  const activeUrl = activeItem ? audioUrls[activeItem.id] ?? null : null;

  // FFmpeg runtime availability (downloaded on demand, shared with STT).
  const [runtimeReady, setRuntimeReady] = useState<boolean | null>(null);
  const [runtimeDownloading, setRuntimeDownloading] = useState(false);
  const [runtimePercent, setRuntimePercent] = useState<number | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.status().then((status) => setRuntimeReady(status.ffmpegAvailable));
  }, [api]);

  // Runtime download progress arrives on the shared stt-download-progress
  // channel (provider "editor").
  useEffect(() => {
    if (!runtimeDownloading) return;
    const desktopWindow = window as Window & {
      desktopAPI?: {
        localTranscription?: { onSttDownloadProgress: (cb: (p: { provider: string; percent: number | null; phase: string }) => void) => Promise<() => void> };
      };
    };
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void desktopWindow.desktopAPI?.localTranscription?.onSttDownloadProgress((progress) => {
      if (progress.provider !== "editor") return;
      setRuntimePercent(progress.percent);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runtimeDownloading]);

  const handleEnsureRuntime = useCallback(async () => {
    if (!api) return;
    setRuntimeDownloading(true);
    setRuntimePercent(null);
    try {
      const status = await api.ensureRuntime();
      setRuntimeReady(status.ffmpegAvailable);
      if (!status.ffmpegAvailable) {
        toast.error(t("audio_editor.runtime_failed"));
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRuntimeDownloading(false);
      setRuntimePercent(null);
    }
  }, [api, t]);

  // Analysis of the active file (peaks + silence segments). Desilence keeps
  // one-click defaults; the same numbers feed both the preview overlay and
  // the ffmpeg filter on the Rust side.
  const desilenceThresholdDb = -35;
  const desilenceMinSilenceSec = 0.6;
  const analysis = useAudioAnalysis(activeUrl, {
    thresholdDb: desilenceThresholdDb,
    minSilenceSec: desilenceMinSilenceSec,
  });
  const analysisRef = useRef(analysis);
  analysisRef.current = analysis;
  const durationSec = analysis.durationSec;

  // ── View window (zoom) ──
  // `null` means "fit the whole file". The overview strip pans/zooms it, and
  // playback recentres it when the playhead walks out of view.
  const [view, setView] = useState<{ start: number; end: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const viewStart = view?.start ?? 0;
  const viewEnd = view?.end ?? durationSec;
  const clampWindow = useCallback((start: number, end: number): { start: number; end: number } => {
    const dur = analysisRef.current.durationSec;
    const minSpan = dur > 0
      ? Math.max(1, (dur / Math.max(1, analysisRef.current.peaks.length)) * 8)
      : 1;
    const span = Math.min(Math.max(end - start, minSpan), dur);
    const s = Math.max(0, Math.min(start, dur - span));
    return { start: s, end: s + span };
  }, []);

  // Playback. The authoritative playhead lives in a ref that the canvases
  // read every frame; React state is throttled (~20 Hz) for the big timer
  // text, so playback never re-renders the page at 60 fps.
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const playheadRef = useRef(0);
  const getPlayheadSec = useCallback(() => playheadRef.current, []);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastReactUpdate = 0;
    const tick = (now: number) => {
      const audio = audioRef.current;
      if (audio) {
        const time = audio.currentTime;
        playheadRef.current = time;
        if (now - lastReactUpdate >= 50) {
          lastReactUpdate = now;
          setPlayheadSec(time);
        }
        // Follow the playhead: recentre the window when it walks out of view.
        const dur = analysisRef.current.durationSec;
        const current = viewRef.current;
        if (dur > 0 && current && (time < current.start || time > current.end)) {
          const span = current.end - current.start;
          setView(clampWindow(time - span / 2, time + span / 2));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clampWindow]);

  // Reset transport + zoom when switching files.
  useEffect(() => {
    playheadRef.current = 0;
    setPlayheadSec(0);
    setSelection(null);
    setView(null);
  }, [activeItem?.id]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // Replaying after the clip ran out restarts from the top.
      if (audio.ended) audio.currentTime = 0;
      void audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, []);

  const seekTo = useCallback((sec: number) => {
    const clamped = Math.max(0, sec);
    if (audioRef.current) audioRef.current.currentTime = clamped;
    playheadRef.current = clamped;
    setPlayheadSec(clamped);
  }, []);

  const skip = useCallback((deltaSec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const dur = analysisRef.current.durationSec;
    const target = Math.max(0, Math.min(audio.currentTime + deltaSec, dur > 0 ? dur : audio.currentTime + deltaSec));
    audio.currentTime = target;
    playheadRef.current = target;
    setPlayheadSec(target);
  }, []);

  // Trim selection.
  const [selection, setSelection] = useState<WaveformSelection | null>(null);

  // Zoom the main view to exactly the trim selection (the crop button in the
  // transport's trim pill).
  const zoomToSelection = useCallback(() => {
    if (!selection) return;
    setView(clampWindow(selection.startSec, selection.endSec));
  }, [clampWindow, selection]);

  // Pinch / ⌘-wheel zoom and two-finger horizontal pan on the main band —
  // the macOS Voice Memos zoom gesture. React's onWheel is passive, so the
  // listener is attached natively with `passive: false` to allow
  // preventDefault (stops the browser page-zoom on pinch).
  const bandRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const { durationSec, viewStart, viewEnd } = analysisRef.current.durationSec > 0
        ? { durationSec: analysisRef.current.durationSec, viewStart: viewRef.current?.start ?? 0, viewEnd: viewRef.current?.end ?? analysisRef.current.durationSec }
        : { durationSec: 0, viewStart: 0, viewEnd: 0 };
      if (durationSec <= 0) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = el.getBoundingClientRect();
        const anchor = viewStart + ((event.clientX - rect.left) / Math.max(1, rect.width)) * (viewEnd - viewStart);
        const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2;
        const span = (viewEnd - viewStart) * factor;
        const start = anchor - (anchor - viewStart) * factor;
        setView(clampWindow(start, start + span));
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const rect = el.getBoundingClientRect();
        const delta = (event.deltaX / Math.max(1, rect.width)) * (viewEnd - viewStart);
        setView(clampWindow(viewStart + delta, viewEnd + delta));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clampWindow]);

  // Job state. Liveness/done/error arrive via `audio-editor-progress`; the
  // command promise itself carries success/failure for the toast.
  const [processing, setProcessing] = useState(false);

  // Completed export awaiting the user's stay/leave decision (dialog).
  const [exportDone, setExportDone] = useState<AudioEditorSaveMode | null>(null);

  const runExport = useCallback(
    async (action: () => Promise<unknown>, saveMode: AudioEditorSaveMode) => {
      if (!api) return;
      setProcessing(true);
      try {
        await action();
        toast.success(
          t(saveMode === "overwrite" ? "audio_editor.overwrite_done" : "audio_editor.export_done"),
        );
        // Refresh the notes page caches so an overwritten recording (new audio
        // URL) or a newly registered note shows up immediately.
        for (const item of items) {
          void queryClient.invalidateQueries({ queryKey: ["file-audio-url", item.id] });
          void queryClient.invalidateQueries({ queryKey: ["file-transcription", item.id] });
        }
        void queryClient.invalidateQueries({ queryKey: ["files"] });
        void queryClient.invalidateQueries({ queryKey: ["notes"] });
        // Stay on the page — an export is not an exit. An overwrite swapped
        // the bytes behind the active record, so reload its audio (fresh
        // `?v=`), drop the applied edit, and let the user choose between
        // more editing and leaving via the completion dialog.
        playheadRef.current = 0;
        setPlayheadSec(0);
        setSelection(null);
        setView(null);
        void resolveAudioUrls();
        setExportDone(saveMode);
      } catch (error) {
        toast.error(String(error));
      } finally {
        setProcessing(false);
      }
    },
    [api, items, queryClient, resolveAudioUrls, t],
  );

  const handleTrim = useCallback(() => {
    if (!api || !activeItem || !selection) return;
    void runExport(
      () => api.trim(activeItem.id, selection.startSec, selection.endSec, activeItem.title, effectiveSaveMode === "overwrite"),
      effectiveSaveMode,
    );
  }, [api, activeItem, effectiveSaveMode, selection, runExport]);

  const handleMerge = useCallback(() => {
    if (!api || !canMerge) return;
    void runExport(() => api.merge(items.map((item) => item.id)), effectiveSaveMode);
  }, [api, canMerge, effectiveSaveMode, items, runExport]);

  const handleDesilence = useCallback(() => {
    if (!api || !activeItem) return;
    void runExport(
      () =>
        api.removeSilence(
          activeItem.id,
          {
            thresholdDb: desilenceThresholdDb,
            minSilenceSec: desilenceMinSilenceSec,
          },
          activeItem.title,
          effectiveSaveMode === "overwrite",
        ),
      effectiveSaveMode,
    );
  }, [api, activeItem, effectiveSaveMode, runExport]);

  const handleEnhance = useCallback(() => {
    if (!api || !activeItem) return;
    void runExport(
      () => api.enhanceVoice(activeItem.id, activeItem.title, effectiveSaveMode === "overwrite"),
      effectiveSaveMode,
    );
  }, [api, activeItem, effectiveSaveMode, runExport]);

  // Landing choreography, shared with the recording page's stage: waveform,
  // then overview, then the transport bar rise in staggered layers. Mount-only.
  // Matches the project motion tokens: ≤ 300ms on --ease-out.
  const enter = (delay: number, y: number, duration = 0.3) => ({
    initial: reduceMotion
      ? false
      : { opacity: 0, transform: `translateY(${y}px)` },
    animate: { opacity: 1, transform: "translateY(0px)" },
    transition: { duration, delay, ease: [0.23, 1, 0.32, 1] } as Transition,
  });
  const pillSpring: Transition = reduceMotion
    ? { duration: 0 }
    : { type: "spring", bounce: 0, duration: 0.3 };

  if (!api || items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
        <p>{t("audio_editor.empty")}</p>
        <Button variant="outline" size="sm" onClick={() => push("/notes")}>
          {t("audio_editor.back_to_notes")}
        </Button>
      </div>
    );
  }

  const modes: { id: EditorMode; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
    { id: "trim", label: t("audio_editor.trim"), icon: <Scissors className="size-3.5" /> },
    { id: "merge", label: t("audio_editor.merge"), icon: <Combine className="size-3.5" />, disabled: !canMerge },
    { id: "desilence", label: t("audio_editor.desilence"), icon: <VolumeX className="size-3.5" /> },
    { id: "enhance", label: t("audio_editor.enhance"), icon: <Wand2 className="size-3.5" /> },
  ];

  const totalSilenceSec = analysis.silenceSegments.reduce(
    (sum, s) => sum + (s.endSec - s.startSec),
    0,
  );

  // One muted status line in the control row — same content the old timer
  // block carried: analysing, selection, silence census, or the mode hint.
  const status = ((): string => {
    if (analysis.loading) return t("audio_editor.analyzing");
    if (mode === "trim" && selection) {
      return t("audio_editor.selection", {
        start: formatTime(selection.startSec),
        end: formatTime(selection.endSec),
      });
    }
    if (mode === "desilence" && analysis.silenceSegments.length > 0) {
      return t("audio_editor.silence_found", { count: analysis.silenceSegments.length, seconds: formatTime(totalSilenceSec) });
    }
    if (mode === "trim") return t("audio_editor.trim_hint");
    if (mode === "merge") return canMerge ? t("audio_editor.merge_hint") : t("audio_editor.merge_needs_two");
    if (mode === "desilence") return t("audio_editor.desilence_hint");
    return t("audio_editor.enhance_hint");
  })();

  const playPauseLabel = playing ? t("audio_editor.pause") : t("audio_editor.play");
  const backLabel = processing ? t("audio_editor.cancel") : t("audio_editor.back_to_notes");
  const canApply =
    runtimeReady === true &&
    !processing &&
    (mode !== "trim" || !!selection) &&
    (mode !== "merge" || canMerge);
  const apply = () => {
    if (mode === "trim") handleTrim();
    else if (mode === "merge") handleMerge();
    else if (mode === "desilence") handleDesilence();
    else handleEnhance();
  };
  // The ✕ / ✓ pair only exists while there is an unapplied edit: a trim
  // selection, or one of the one-shot operations (merge / desilence /
  // enhance) whose whole purpose is to produce a modified file.
  const hasPendingEdit =
    mode === "trim" ? !!selection : mode === "merge" ? canMerge : true;
  // Discard the pending edit without leaving the page: a trim selection is
  // simply cleared; the other modes revert to trim. While a job runs the
  // button cancels it instead.
  const discard = () => {
    if (processing) {
      void api?.cancel();
      return;
    }
    if (mode === "trim") setSelection(null);
    else setMode("trim");
  };
  const showOverview = !analysis.loading && !analysis.error && !analysis.skipped && durationSec > 0;

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        {/* ═══ Header — the recording page's header: back button on the
               left, mode / save-target pills on the right. The document
               title + date live in the unified app title bar. The ✕ / ✓
               pair lives between the timer and the transport below, and
               only while an edit is pending. ═══ */}
        <TitleBarSlot
          title={
            <span className="flex max-w-full flex-col items-center leading-tight" data-tauri-drag-region>
              <span className="max-w-full truncate text-[13px] font-medium text-foreground" title={activeItem?.title}>
                {activeItem?.title ?? ""}
              </span>
              {recordingDate && (
                <span className="truncate text-2xs text-muted-foreground/60">{recordingDate}</span>
              )}
            </span>
          }
        />
        <header
          className="flex h-12 shrink-0 select-none items-center justify-between gap-3 border-b border-border px-5"
          data-tauri-drag-region
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => {
                      if (processing) void api?.cancel();
                      push("/notes");
                    }}
                    aria-label={backLabel}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color] duration-150 hover:bg-muted hover:text-foreground"
                  >
                    <ChevronLeft className="size-4.5" />
                  </button>
                }
              />
              <TooltipContent>{backLabel}</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* Mode switch — the recording page's header pills. */}
            <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-background/40 p-0.5">
              {modes.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={entry.disabled || processing}
                  title={entry.disabled ? t("audio_editor.merge_needs_two") : undefined}
                  onClick={() => setMode(entry.id)}
                  className={cn(
                    "relative rounded-full px-2.5 py-1 text-2xs font-medium transition-colors disabled:opacity-40",
                    mode === entry.id
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === entry.id && (
                    <motion.span
                      layoutId="audio-editor-mode-thumb"
                      className="absolute inset-0 rounded-full bg-primary/15"
                      transition={pillSpring}
                    />
                  )}
                  <span className="relative flex items-center gap-1.5">
                    {entry.icon}
                    {entry.label}
                  </span>
                </button>
              ))}
            </div>

            {mode !== "merge" && (
              <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-background/40 p-0.5">
                {(
                  [
                    { id: "overwrite", label: t("audio_editor.save_overwrite") },
                    { id: "new", label: t("audio_editor.save_as_new") },
                  ] as { id: AudioEditorSaveMode; label: string }[]
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={processing}
                    onClick={() => setSaveMode(option.id)}
                    className={cn(
                      "relative rounded-full px-2.5 py-1 text-2xs font-medium transition-colors disabled:opacity-40",
                      effectiveSaveMode === option.id
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {effectiveSaveMode === option.id && (
                      <motion.span
                        layoutId="audio-editor-save-thumb"
                        className="absolute inset-0 rounded-full bg-primary/15"
                        transition={pillSpring}
                      />
                    )}
                    <span className="relative">{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        {/* Runtime banner */}
        {runtimeReady === false && (
          <div className="flex shrink-0 items-center gap-3 border-b border-border/50 bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground">
            <span className="flex-1">{t("audio_editor.runtime_missing")}</span>
            <Button
              size="sm"
              className="tabular-nums"
              disabled={runtimeDownloading}
              onClick={() => void handleEnsureRuntime()}
            >
              {runtimeDownloading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {runtimePercent != null ? `${runtimePercent}%` : t("audio_editor.runtime_downloading")}
                </>
              ) : (
                t("audio_editor.runtime_download")
              )}
            </Button>
          </div>
        )}

        {/* ═══ Main ═══ */}
        <main className="flex min-h-0 flex-1">
          {/* Merge order rail (merge mode only) */}
          {mode === "merge" && canMerge && (
            <div className="w-60 shrink-0 overflow-y-auto border-r border-border px-3 py-3">
              <p className="px-1 pb-2 text-2xs font-medium text-muted-foreground">
                {t("audio_editor.merge_order")}
              </p>
              {items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  className={
                    "mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors " +
                    (index === activeIndex
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")
                  }
                >
                  <span className="tabular-nums">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              ))}
            </div>
          )}

          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Zoomed waveform band — the trim screen's main view */}
            <motion.div ref={bandRef} className="flex min-h-0 w-full flex-[2]" {...enter(0, 14)}>
              {analysis.loading ? (
                <div className="flex h-full w-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("audio_editor.analyzing")}
                </div>
              ) : analysis.skipped || analysis.error || !activeUrl ? (
                <div className="flex h-full w-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
                  {t("audio_editor.waveform_unavailable")}
                </div>
              ) : (
                <EditorWaveform
                  className="min-h-0 w-full flex-1"
                  peaks={analysis.peaks}
                  durationSec={durationSec}
                  getPlayheadSec={getPlayheadSec}
                  viewStartSec={viewStart}
                  viewEndSec={viewEnd}
                  selection={mode === "trim" ? selection : null}
                  silenceSegments={mode === "desilence" ? analysis.silenceSegments : undefined}
                  onSeek={seekTo}
                  onSelectionChange={setSelection}
                />
              )}
            </motion.div>

            {/* Overview strip — whole file + draggable view window */}
            {showOverview && (
              <motion.div className="shrink-0 px-6 pt-3" {...enter(0.06, 10)}>
                <EditorOverview
                  className="h-11 w-full"
                  peaks={analysis.peaks}
                  durationSec={durationSec}
                  getPlayheadSec={getPlayheadSec}
                  viewStartSec={viewStart}
                  viewEndSec={viewEnd}
                  selection={mode === "trim" ? selection : null}
                  onSelectionChange={setSelection}
                  onViewChange={(start, end) => setView(clampWindow(start, end))}
                />
                <div className="mt-1 flex justify-between text-2xs tabular-nums text-muted-foreground">
                  <span>{formatTime(0)}</span>
                  <span>{formatTotal(durationSec)}</span>
                </div>
              </motion.div>
            )}

            {/* Large centisecond timer + status — centred under the waveform,
                   the same block the recording stage uses (the macOS layout
                   parked the timer at the transport's right edge). macOS
                   always shows the hours digit. */}
            <motion.div className="mt-5 shrink-0 text-center" {...enter(0.09, 12)}>
              <div className="text-6xl font-medium tracking-tight tabular-nums text-foreground">
                {formatCentis(playheadSec)}
              </div>
              <p className="mt-1.5 truncate px-6 text-sm text-muted-foreground">{status}</p>
            </motion.div>

            {/* Open band between the timer and the transport — parks the
                   ✕ (discard) / ✓ (apply) pair, present only while an edit
                   is pending. */}
            <div className="relative min-h-14 flex-1">
              <AnimatePresence initial={false}>
                {hasPendingEdit && (
                  <>
                    <motion.div
                      key="editor-discard"
                      className="absolute left-10 top-0 flex h-full items-center"
                      initial={reduceMotion ? false : { opacity: 0, transform: "translateY(8px)" }}
                      animate={{ opacity: 1, transform: "translateY(0px)" }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
                      transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                    >
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={discard}
                              aria-label={t("audio_editor.cancel")}
                              className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground transition-[color,background-color,transform] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96]"
                            >
                              <IconSwap stateKey={processing ? "busy" : "idle"}>
                                {processing ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4.5" />}
                              </IconSwap>
                            </button>
                          }
                        />
                        <TooltipContent>{t("audio_editor.cancel")}</TooltipContent>
                      </Tooltip>
                    </motion.div>
                    <motion.div
                      key="editor-apply"
                      className="absolute right-10 top-0 flex h-full items-center"
                      initial={reduceMotion ? false : { opacity: 0, transform: "translateY(8px)" }}
                      animate={{ opacity: 1, transform: "translateY(0px)" }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
                      transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                    >
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={apply}
                              disabled={!canApply}
                              aria-label={t("audio_editor.done")}
                              className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.96] disabled:opacity-40"
                            >
                              <IconSwap stateKey={processing ? "busy" : "idle"}>
                                {processing ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4.5" />}
                              </IconSwap>
                            </button>
                          }
                        />
                        <TooltipContent>{t("audio_editor.done")}</TooltipContent>
                      </Tooltip>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            {/* ═══ Transport — the recording page's transport bar: the ±15 ·
                   play · ±15 cluster centred, with the trim tools on the row's
                   edges (zoom left / clear right) where the reference screen
                   puts its trim and trash buttons. ═══ */}
            <motion.div
              className="relative mx-auto mb-9 grid w-full max-w-[1100px] grid-cols-[1fr_auto_1fr] items-center px-10"
              {...enter(0.14, 18, 0.38)}
            >
              {/* Left edge: zoom the view into the trim selection */}
              <div className="justify-self-start">
                {mode === "trim" && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={zoomToSelection}
                          disabled={!selection}
                          aria-label={t("audio_editor.zoom_to_selection")}
                          className="mx-auto flex flex-col items-center gap-1.5 rounded-xl px-3 py-1.5 text-2xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
                        >
                          <Crop className="size-5 text-foreground/80" />
                          <span>{t("audio_editor.zoom_to_selection")}</span>
                        </button>
                      }
                    />
                    <TooltipContent>{t("audio_editor.zoom_to_selection")}</TooltipContent>
                  </Tooltip>
                )}
              </div>

              <div className="flex items-center gap-3">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => skip(-15)}
                        disabled={!activeUrl}
                        aria-label={t("audio_editor.skip_back")}
                        className="flex size-10 items-center justify-center rounded-full text-foreground transition-[color,background-color,transform] duration-150 hover:bg-muted active:scale-[0.96] disabled:opacity-40"
                      >
                        <GoTo15Icon forward={false} className="size-6" />
                      </button>
                    }
                  />
                  <TooltipContent>{t("audio_editor.skip_back")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={togglePlay}
                        disabled={!activeUrl}
                        aria-label={playPauseLabel}
                        className="flex size-12 items-center justify-center rounded-full text-foreground transition-[color,opacity,transform] duration-150 hover:opacity-70 active:scale-[0.96] disabled:opacity-40"
                      >
                        <IconSwap stateKey={playing ? "pause" : "play"}>
                          {playing ? <Pause className="size-7" fill="currentColor" /> : <Play className="ml-1 size-7 fill-current" />}
                        </IconSwap>
                      </button>
                    }
                  />
                  <TooltipContent>{playPauseLabel}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => skip(15)}
                        disabled={!activeUrl}
                        aria-label={t("audio_editor.skip_forward")}
                        className="flex size-10 items-center justify-center rounded-full text-foreground transition-[color,background-color,transform] duration-150 hover:bg-muted active:scale-[0.96] disabled:opacity-40"
                      >
                        <GoTo15Icon forward className="size-6" />
                      </button>
                    }
                  />
                  <TooltipContent>{t("audio_editor.skip_forward")}</TooltipContent>
                </Tooltip>
              </div>

              {/* Right edge: clear the trim selection */}
              <div className="justify-self-end">
                {mode === "trim" && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => setSelection(null)}
                          disabled={!selection}
                          aria-label={t("audio_editor.clear_selection")}
                          className="mx-auto flex flex-col items-center gap-1.5 rounded-xl px-3 py-1.5 text-2xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40 disabled:hover:text-muted-foreground"
                        >
                          <Trash2 className="size-5 text-foreground/80" />
                          <span>{t("audio_editor.clear_selection")}</span>
                        </button>
                      }
                    />
                    <TooltipContent>{t("audio_editor.clear_selection")}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </motion.div>
          </section>
        </main>

        {/* ═══ Export complete — the user confirms the exit themselves ═══ */}
        <Dialog open={exportDone != null} onOpenChange={(open) => { if (!open) setExportDone(null); }}>
          <DialogContent className="max-w-sm gap-4">
            <DialogTitle>
              {exportDone === "overwrite" ? t("audio_editor.overwrite_done") : t("audio_editor.export_done")}
            </DialogTitle>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("audio_editor.done_hint")}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setExportDone(null)}>
                {t("audio_editor.continue_editing")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setExportDone(null);
                  clearRequest();
                  push("/notes");
                }}
              >
                {t("audio_editor.back_to_notes")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {activeUrl && (
          <audio
            ref={audioRef}
            src={activeUrl}
            preload="metadata"
            onPlaying={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            className="hidden"
          />
        )}
      </div>
    </TooltipProvider>
  );
}
