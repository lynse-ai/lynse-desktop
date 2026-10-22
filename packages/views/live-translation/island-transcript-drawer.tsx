"use client";

import { recordingLevel } from "./audio-sources";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { AudioVisualizer } from "./audio-visualizer";
import { directionLabel, TARGET_LANGUAGE_OPTIONS } from "./language-options";
import { Check, ChevronDown, Languages } from "../icons";
import { useLiveTranslation } from "./use-live-translation";

interface IslandTranscriptDrawerProps {
  /** True while the drawer is animating out (collapse in progress). */
  closing?: boolean;
  /** Re-point the running session's live connection at a target language
   * ("none" = transcription-only). Drives the language picker. */
  onSelectTargetLanguage?: (code: string) => void;
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}

/**
 * Live-transcript drawer inside the recording island.
 *
 * Rendered beneath the DynamicIsland pill when the user taps the captions
 * toggle: the recognized source text with the translation underneath
 * (identical content model to the main page's transcript panel), followed by
 * a live waveform footer. The Tauri window is resized by
 * `RecordingIslandWindow`, so this component just fills the space it gets.
 */
export function IslandTranscriptDrawer({
  closing,
  onSelectTargetLanguage,
}: IslandTranscriptDrawerProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const { view } = useLiveTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const segments = useMemo(
    () =>
      view.segments.filter(
        (segment) =>
          !segment.echoOf && (segment.recognizedText || segment.translatedText),
      ),
    [view.segments],
  );
  const translationOn =
    view.targetLanguage != null && view.targetLanguage !== "none";
  // Actively translating to a *different* language — a pure-recording session
  // (target == source) must still offer the translation switch.
  const translating =
    translationOn && view.targetLanguage !== view.sourceLanguage;

  // Follow the newest segment, unless the user scrolled up to re-read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [segments]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // When the mic feed is echo-suppressed the system stream is the one that
  // actually carries the audio — animate to whichever level is alive.
  const level = recordingLevel(view);

  return (
    <motion.div
      className="relative flex min-h-0 flex-1 flex-col"
      initial={reduceMotion ? false : { y: -14, opacity: 0 }}
      animate={{ y: closing ? -10 : 0, opacity: closing ? 0 : 1 }}
      // Interruptible transition instead of one-shot keyframes: reopening
      // mid-close retargets smoothly. Curves/durations match the window
      // unroll (`animate_island_height` in live_translation.rs).
      transition={
        reduceMotion
          ? { duration: 0 }
          : closing
            ? { duration: 0.15, ease: [0.55, 0, 1, 0.45] }
            : { duration: 0.32, ease: [0.22, 1, 0.36, 1] }
      }
    >
      {/* Header */}
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between border-t border-border/40 pl-4 pr-2 pb-1 pt-2"
      >
        <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
          {translating ? t("recording_mode.translate") : t("recording_mode.transcribe")}
        </span>
        {onSelectTargetLanguage && (
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-label={t("live_translation.translation_direction")}
            title={t("live_translation.translation_direction")}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-3xs tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {directionLabel(view.sourceLanguage ?? "auto", view.targetLanguage ?? "none", t)}
            <ChevronDown
              className={cn(
                "size-3 transition-transform duration-200",
                pickerOpen && "rotate-180",
              )}
            />
          </button>
        )}
      </div>

      {/* Target-language picker — anchored under the header chip, overlays the
          transcript so the drawer never reflows. */}
      {pickerOpen && onSelectTargetLanguage && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setPickerOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute right-2 top-9 z-20 max-h-72 w-44 overflow-y-auto rounded-xl border border-border/60 bg-background/95 p-1 shadow-lg backdrop-blur-xl">
            {TARGET_LANGUAGE_OPTIONS.map((option) => {
              const selected = view.targetLanguage === option.code;
              return (
                <button
                  key={option.code}
                  type="button"
                  onClick={() => {
                    setPickerOpen(false);
                    if (!selected) onSelectTargetLanguage(option.code);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                    selected && "text-primary",
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {selected && <Check className="size-3 shrink-0" />}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-2"
      >
        {/* Engine/connection problems surface here — the compact pill gives
            no room for a message, and "recording but nothing appears" is
            exactly when the user opens the drawer asking why. */}
        {view.lastError && (
          <div className="mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="break-words text-2xs font-medium leading-relaxed text-destructive">
              {view.lastError}
            </p>
          </div>
        )}
        {segments.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center text-center",
              !view.lastError && "h-full",
            )}
          >
            <p className="text-xs font-medium text-foreground/70">
              {t("live_translation.empty_title")}
            </p>
            <p className="mt-1 text-2xs text-muted-foreground">
              {t("live_translation.empty_hint")}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {segments.map((segment, index) => {
              const showTranslation =
                translationOn &&
                segment.translatedText &&
                segment.translatedText !== segment.recognizedText;
              // New speaker (or a new mic/system source) opens a new
              // utterance; continuation lines stay bare for a clean read.
              const prev = index > 0 ? segments[index - 1] : undefined;
              const speakerLabel =
                segment.speaker != null
                  ? `${t("live_translation.speaker")} ${segment.speaker}`
                  : segment.source === "mic"
                    ? t("live_translation.me")
                    : t("live_translation.remote");
              const newUtterance =
                segment.speaker != null
                  ? segment.speaker !== prev?.speaker
                  : segment.source !== prev?.source;
              return (
                <div key={segment.id} className="flex items-start gap-2 text-[13px] leading-relaxed">
                  <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-3xs tabular-nums text-muted-foreground/50">
                    {formatTime(segment.startMs).slice(3)}
                  </span>
                  <div className="min-w-0 flex-1">
                    {newUtterance && (
                      <div className="mb-0.5 text-3xs font-medium text-primary/80">
                        {speakerLabel}
                      </div>
                    )}
                    <p className={cn(!segment.isFinal && "text-foreground/70")}>
                      {segment.recognizedText || segment.translatedText}
                      {!segment.isFinal && (
                        <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse rounded-full bg-primary align-[-1px]" />
                      )}
                    </p>
                    {showTranslation && (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {segment.translatedText}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recording waveform footer; the languages icon opens the same
          target-language picker as the header chip. */}
      <div className="shrink-0 border-t border-border/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <AudioVisualizer
            level={level}
            active={view.state === "recording"}
            className="h-7 min-w-0 flex-1"
          />
          {onSelectTargetLanguage && (
            <button
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              aria-label={t("live_translation.translation_direction")}
              title={t("live_translation.translation_direction")}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground",
                pickerOpen || translating ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Languages className="size-4" />
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
