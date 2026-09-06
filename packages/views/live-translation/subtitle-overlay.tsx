"use client";

import { useMemo } from "react";
import { ChevronDown, X } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { useLiveTranslation } from "./use-live-translation";

export function LiveSubtitleOverlay() {
  const { t } = useTranslation();
  const { api, view } = useLiveTranslation();
  const active = useMemo(() => {
    const visible = view.segments.filter(
      (segment) => !segment.echoOf && (segment.translatedText || segment.recognizedText),
    );
    return (["system", "mic"] as const).flatMap((source) => {
      const segment = visible.filter((item) => item.source === source).at(-1);
      return segment ? [segment] : [];
    });
  }, [view.segments]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-2">
      <div
        className="group relative h-full select-none bg-transparent px-5 py-3 text-white"
        data-tauri-drag-region
      >
        <div
          className="absolute inset-0 cursor-move active:cursor-grabbing"
          data-tauri-drag-region
        />

        <div className="absolute right-3 top-3 z-20 flex items-center gap-0.5 rounded-full bg-black/40 p-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            aria-label={t("live_translation.overlay_minimize")}
            title={t("live_translation.overlay_minimize")}
            onClick={() => api?.minimizeToTray()}
            className="rounded-full p-1.5 text-white/75 transition-colors hover:bg-white/15 hover:text-white"
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("live_translation.overlay_close")}
            title={t("live_translation.overlay_close")}
            onClick={() => api?.showSubtitles(false)}
            className="rounded-full p-1.5 text-white/75 transition-colors hover:bg-white/15 hover:text-white"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div
          className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-center gap-2 px-6 py-4 text-center"
          style={{ textShadow: "0 1px 3px rgba(0,0,0,0.7), 0 0 6px rgba(0,0,0,0.45)" }}
        >
          {active.length === 0 ? (
            <p className="text-lg font-light text-white/70">
              {t("live_translation.overlay_waiting")}
            </p>
          ) : active.map((segment) => {
            // Gate the translation line on the authoritative backend state:
            // when translation is off the target language is "none", so a
            // stale `translatedText` left on the segment must not be shown.
            const translationOn =
              view.targetLanguage != null && view.targetLanguage !== "none";
            const showTranslation =
              translationOn &&
              segment.translatedText &&
              segment.translatedText !== segment.recognizedText;
            const displayOriginal =
              segment.recognizedText || (translationOn ? segment.translatedText : "");
            return (
              <div key={segment.id} className="min-w-0">
                <div className="mb-1 text-2xs font-normal uppercase leading-none tracking-wider text-slate-500">
                  {segment.speaker != null
                    ? `${t("live_translation.speaker")} ${segment.speaker}`
                    : segment.source === "mic"
                      ? t("live_translation.me")
                      : t("live_translation.remote")}
                </div>
                {/* Fixed-height, bottom-anchored line blocks: while a sentence
                    streams in, overflow clips at the TOP so the newest words
                    stay visible (truncate would drop them), and the block's
                    height never changes, so nothing reflows or re-centers. */}
                {displayOriginal && (
                  <div className="flex h-[5.625rem] flex-col justify-end overflow-hidden text-2xl font-light leading-tight tracking-tight text-white">
                    <p>{displayOriginal}</p>
                  </div>
                )}
                {showTranslation && (
                  <div className="mt-0.5 flex h-10 flex-col justify-end overflow-hidden text-base font-normal leading-tight text-white/80">
                    <p>{segment.translatedText}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
