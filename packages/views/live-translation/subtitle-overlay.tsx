"use client";

import { useMemo } from "react";
import { ChevronDown, X } from "../icons";
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
      <div
        className="group relative h-full select-none bg-transparent px-5 py-3 text-slate-900"
        data-tauri-drag-region
      >
        <div
          className="absolute inset-0 cursor-move active:cursor-grabbing"
          data-tauri-drag-region
        />

        <div className="absolute right-3 top-3 z-20 flex items-center gap-0.5 rounded-full bg-black/25 p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label="最小化到状态栏"
            title="最小化到状态栏"
            onClick={() => api?.minimizeToTray()}
            className="rounded-full p-1.5 text-white/75 transition-colors hover:bg-white/15 hover:text-white"
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="关闭悬浮字幕"
            title="关闭悬浮字幕"
            onClick={() => api?.showSubtitles(false)}
            className="rounded-full p-1.5 text-white/75 transition-colors hover:bg-white/15 hover:text-white"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-center gap-2 px-6 py-4 text-center">
          {active.length === 0 ? (
            <p className="text-lg font-light text-slate-600">
              等待实时字幕…
            </p>
          ) : active.map((segment) => (
            <div key={segment.id} className="min-w-0">
              <div className="mb-1 text-[11px] font-normal uppercase leading-none tracking-wider text-slate-500">
                {segment.source === "mic" ? "我" : "远端"}
              </div>
              <p className="truncate text-2xl font-light leading-tight text-slate-900">
                {segment.recognizedText || segment.translatedText}
              </p>
              {segment.translatedText && segment.translatedText !== segment.recognizedText && (
                <p className="mt-0.5 truncate text-base font-normal leading-tight text-slate-600">
                  {segment.translatedText}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
