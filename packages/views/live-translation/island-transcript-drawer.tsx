"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { AudioVisualizer } from "./audio-visualizer";
import { directionLabel } from "./language-options";
import { useLiveTranslation } from "./use-live-translation";

interface IslandTranscriptDrawerProps {
  /** True while the drawer is animating out (collapse in progress). */
  closing?: boolean;
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
export function IslandTranscriptDrawer({ closing }: IslandTranscriptDrawerProps) {
  const { t } = useTranslation();
  const { view } = useLiveTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

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
  const level = view.micSuppressed ? view.systemLevel : Math.max(view.micLevel, view.systemLevel);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        closing ? "animate-island-drawer-out" : "animate-island-drawer-in",
      )}
    >
      {/* Header */}
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between border-t border-border/40 px-4 pb-1 pt-2"
      >
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("recording_mode.transcribe")}
        </span>
        {translationOn && (
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {directionLabel(view.sourceLanguage ?? "auto", view.targetLanguage ?? "none", t)}
          </span>
        )}
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-2"
      >
        {segments.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-xs font-medium text-foreground/70">
              {t("live_translation.empty_title")}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("live_translation.empty_hint")}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {segments.map((segment) => {
              const showTranslation =
                translationOn &&
                segment.translatedText &&
                segment.translatedText !== segment.recognizedText;
              const speakerLabel =
                segment.speaker != null
                  ? `${t("live_translation.speaker")} ${segment.speaker}`
                  : segment.source === "mic"
                    ? t("live_translation.me")
                    : t("live_translation.remote");
              return (
                <div key={segment.id} className="text-[13px] leading-relaxed">
                  <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                    <span>{speakerLabel}</span>
                    {!segment.isFinal && (
                      <span className="animate-pulse">
                        {t("live_translation.recognizing")}
                      </span>
                    )}
                  </div>
                  <p className={cn(!segment.isFinal && "text-foreground/70")}>
                    {segment.recognizedText || segment.translatedText}
                  </p>
                  {showTranslation && (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {segment.translatedText}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recording waveform footer */}
      <div className="shrink-0 border-t border-border/40 px-3 py-2">
        <AudioVisualizer
          level={level}
          active={view.state === "recording"}
          className="h-7 w-full"
        />
      </div>
    </div>
  );
}
