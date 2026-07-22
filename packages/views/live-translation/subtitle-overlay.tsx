"use client";

import { useMemo } from "react";
import { X } from "../icons";
import { useLiveTranslation } from "./use-live-translation";

export function LiveSubtitleOverlay() {
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
      <div className="group relative flex h-full flex-col justify-center gap-2 rounded-2xl border border-white/15 bg-black/75 px-5 py-3 text-white shadow-2xl backdrop-blur-xl" data-tauri-drag-region>
        <button
          type="button"
          aria-label="关闭悬浮字幕"
          onClick={() => api?.showSubtitles(false)}
          className="absolute right-2 top-2 rounded-full p-1 text-white/50 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
        >
          <X className="size-3.5" />
        </button>
        {active.length === 0 ? (
          <p className="text-center text-sm text-white/60">等待实时字幕…</p>
        ) : active.map((segment) => (
          <div key={segment.id} className="min-w-0">
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-white/45">
              {segment.source === "mic" ? "我" : "远端"}
            </div>
            <p className="truncate text-lg font-medium leading-snug">
              {segment.recognizedText || segment.translatedText}
            </p>
            {segment.translatedText && segment.translatedText !== segment.recognizedText && (
              <p className="mt-0.5 truncate text-xs text-white/55">{segment.translatedText}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
