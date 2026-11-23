"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChevronDown, Monitor, Settings, X } from "../icons";
import { initI18n } from "@lynse/core/i18n";
import { useTranslation } from "@lynse/core/i18n/react";
import { Popover, PopoverContent, PopoverTrigger } from "@lynse/ui/components/ui/popover";
import { RESOURCES } from "../locales";
import { useLiveTranslation } from "./use-live-translation";
import {
  applySubtitlePreset,
  readSubtitlePrefs,
  saveSubtitlePrefs,
  selectVisibleFinals,
  translationLagMs,
  type SubtitleDisplayMode,
  type SubtitleFontScale,
  type SubtitlePrefs,
  type SubtitlePreset,
} from "./overlay-logic";
import { TRANSLATION_ENGINES, readTranslationServiceConfig } from "./translation-service";
import type { LiveTranslationSegment } from "./types";

/** Floating subtitle bar. Renders a small stack of frozen finals plus the
 *  in-flight partial, with history scroll-back, display modes (bilingual /
 *  translation-only / original), scenario presets, a latency HUD, and the
 *  stream-health dot. Runs in its own always-on-top Tauri window and
 *  subscribes to the same global live-translation event stream. */

const HOLD_MS = 2500;
const HISTORY_LINES = 40;

const FONT_CLASS: Record<SubtitleFontScale, { original: string; translation: string }> = {
  s: { original: "text-lg leading-snug", translation: "text-xs" },
  m: { original: "text-2xl leading-tight", translation: "text-sm" },
  l: { original: "text-3xl leading-tight", translation: "text-lg" },
};

const PROVIDER_LABEL_KEYS: Record<string, string> = {
  lynse_backend: "live_translation.provider_backend",
  ilivedata_direct: "live_translation.provider_ilivedata_direct",
  qwen: "live_translation.provider_qwen",
  apple: "live_translation.provider_apple",
  volc: "live_translation.provider_volc",
  tencent: "live_translation.provider_tencent",
  custom: "live_translation.provider_custom",
};

function latestPartial(
  segments: LiveTranslationSegment[],
  source: "system" | "mic",
): LiveTranslationSegment | undefined {
  return segments.findLast((segment) => segment.source === source && !segment.echoOf && !segment.isFinal
    && (segment.translatedText || segment.recognizedText));
}

function activeEngineLabels(): { asr: string; engine: string | null } {
  // Labels come from persisted client settings, not the session — the Rust
  // snapshot carries no provider identity, and this window skips secret
  // hydration anyway. Both reads are best-effort.
  let asrKey: string | undefined;
  try {
    const blob = JSON.parse(
      window.localStorage.getItem("lynse_live_translation_settings_v2") ?? "{}",
    ) as { activeProvider?: string };
    asrKey = blob.activeProvider ? PROVIDER_LABEL_KEYS[blob.activeProvider] : undefined;
  } catch {
    // Corrupt blob → fall through to the raw provider id.
  }
  const engineHead = readTranslationServiceConfig().providers[0];
  const engineMeta = TRANSLATION_ENGINES.find((engine) => engine.id === engineHead);
  return {
    asr: asrKey ?? "live_translation.provider_backend",
    engine: engineMeta?.labelKey ?? null,
  };
}

function SubtitleLine({
  segment,
  prefs,
  translationOn,
}: {
  segment: LiveTranslationSegment;
  prefs: SubtitlePrefs;
  translationOn: boolean;
}) {
  const { t } = useTranslation();
  const fonts = FONT_CLASS[prefs.fontScale];
  // Gate the translation on the authoritative backend state: when translation
  // is off, a stale `translatedText` left on the segment must not be shown.
  const hasTranslation = translationOn
    && Boolean(segment.translatedText)
    && segment.translatedText !== segment.recognizedText;
  // Translation-only mode falls back to the original line while the chain is
  // still working, so the bar never shows an empty block.
  const showOriginal = prefs.mode !== "translation" || !hasTranslation;
  const showTranslation = prefs.mode !== "original" && hasTranslation;
  return (
    <div className="group/line min-w-0">
      <div className="text-2xs font-normal uppercase leading-none tracking-wider text-slate-400">
        {segment.speaker != null
          ? `${t("live_translation.speaker")} ${segment.speaker}`
          : segment.source === "mic"
            ? t("live_translation.me")
            : t("live_translation.remote")}
      </div>
      {showOriginal && (
        <p className={`line-clamp-2 font-light tracking-tight text-white ${fonts.original}`}>
          {segment.recognizedText || segment.translatedText}
        </p>
      )}
      {showTranslation && (
        <p
          className={`line-clamp-2 font-normal text-white/80 ${fonts.translation} ${
            prefs.mode === "original" ? "opacity-0 transition-opacity group-hover/line:opacity-100" : ""
          }`}
        >
          {segment.translatedText}
        </p>
      )}
    </div>
  );
}

export function LiveSubtitleOverlay() {
  // This overlay window renders outside CoreProvider, so bootstrap i18n
  // itself — during render, before useTranslation() below: a passive effect
  // is too late (the hook resolves no i18next instance on the first render,
  // subscribes to nothing, and never re-renders once init completes).
  useMemo(() => initI18n({ resources: RESOURCES }), []);
  const { t } = useTranslation();
  const { api, view } = useLiveTranslation();
  const [prefs, setPrefsState] = useState<SubtitlePrefs>(() => readSubtitlePrefs());
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyStickRef = useRef(true);
  // Tick so hold-expiry re-renders without a segment event landing.
  const [, forceTick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = window.setInterval(forceTick, 500);
    return () => window.clearInterval(timer);
  }, []);
  // First-seen timestamps drive the freeze hold: a brand-new final must not
  // be instantly evicted by the next one on a 1-line bar.
  const finalSeenRef = useRef(new Map<string, number>());
  useEffect(() => {
    for (const segment of view.segments) {
      if (segment.isFinal && !segment.echoOf && (segment.recognizedText || segment.translatedText)
        && !finalSeenRef.current.has(segment.id)) {
        finalSeenRef.current.set(segment.id, Date.now());
      }
    }
  }, [view.segments]);

  function setPrefs(next: SubtitlePrefs) {
    setPrefsState(next);
    saveSubtitlePrefs(next);
    void api?.setSubtitleWindowPreset?.(next.preset === "stage" ? "stage" : "default").catch(() => undefined);
  }

  // Re-apply the window geometry preset on mount: the Rust side always
  // creates the overlay at the default 720×190 regardless of saved prefs.
  const prefsRef = useRef(prefs);
  useEffect(() => {
    if (prefsRef.current.preset === "stage") {
      void api?.setSubtitleWindowPreset?.("stage").catch(() => undefined);
    }
    // Mount only — the saved preset is what matters, not live edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translationOn = view.targetLanguage != null && view.targetLanguage !== "none";
  const finals = useMemo(
    () =>
      view.segments
        .filter((segment) => segment.isFinal && !segment.echoOf && (segment.recognizedText || segment.translatedText))
        .map((segment) => ({ segment, seenAtMs: finalSeenRef.current.get(segment.id) ?? Date.now() })),
    [view.segments],
  );
  // Visible stack: newest N finals, plus any final still inside the freeze
  // hold that would otherwise be evicted (one-line bars briefly run longer).
  const visibleFinals = useMemo(() => {
    const recent = finals.slice(-Math.max(prefs.visibleLines, 6));
    const ids = new Set(
      selectVisibleFinals(
        recent.map(({ segment, seenAtMs }) => ({ id: segment.id, seenAtMs })),
        prefs.visibleLines,
        HOLD_MS,
        Date.now(),
      ),
    );
    return recent.filter((item) => ids.has(item.segment.id));
  }, [finals, prefs.visibleLines]);

  const partials = useMemo(
    () => [latestPartial(view.segments, "system"), latestPartial(view.segments, "mic")]
      .filter((segment): segment is LiveTranslationSegment => segment !== undefined),
    [view.segments],
  );
  const lagMs = useMemo(() => {
    for (let index = finals.length - 1; index >= 0; index -= 1) {
      const entry = finals[index];
      if (!entry) continue;
      const lag = translationLagMs(entry.segment);
      if (lag != null) return lag;
    }
    return null;
  }, [finals]);
  const labels = activeEngineLabels();
  const streamStates = Object.values(view.streamStates);
  const streamFailed = streamStates.includes("failed");
  const streamConnecting = streamStates.includes("connecting");

  // History scroll-back: wheel up opens a scrollable backlog over the bar;
  // reaching the bottom again (or Esc) returns to the live bar.
  useEffect(() => {
    if (!historyOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setHistoryOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyOpen]);
  useEffect(() => {
    if (!historyOpen) return;
    const el = historyRef.current;
    if (!el || !historyStickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [historyOpen, view.segments]);
  const historyFinals = useMemo(() => finals.slice(-HISTORY_LINES), [finals]);

  const justify = prefs.position === "top" ? "justify-start" : "justify-end";
  const fonts = FONT_CLASS[prefs.fontScale];

  return (
    <div
      className="h-screen w-screen select-none overflow-hidden bg-transparent p-2"
      onWheel={(event) => {
        if (historyOpen) {
          const el = historyRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 24 && event.deltaY > 0) {
            setHistoryOpen(false);
          }
          return;
        }
        if (event.deltaY < 0 && historyFinals.length > 0) setHistoryOpen(true);
      }}
    >
      <div className="group relative h-full cursor-move bg-transparent px-5 py-3 text-white" data-tauri-drag-region>
        {/* Window controls: hidden until hover, like the HUD below. */}
        <div className="absolute right-3 top-3 z-20 flex items-center gap-0.5 rounded-full bg-black/40 p-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Popover>
            <PopoverTrigger
              aria-label={t("live_translation.overlay_settings")}
              title={t("live_translation.overlay_settings")}
              className="rounded-full p-1.5 text-white/75 transition-colors hover:bg-white/15 hover:text-white"
            >
              <Settings className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-64 space-y-3 border border-[var(--stroke-overlay)] text-foreground">
              <div>
                <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("live_translation.overlay_presets")}
                </p>
                <div className="grid grid-cols-3 gap-1">
                  {(["meeting", "listen", "stage"] as SubtitlePreset[]).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setPrefs(applySubtitlePreset(preset, prefs))}
                      className={`rounded-md border px-2 py-1.5 text-2xs transition-colors ${
                        prefs.preset === preset
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {t(`live_translation.overlay_preset_${preset}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("live_translation.overlay_mode")}
                </p>
                <div className="grid grid-cols-3 gap-1">
                  {(["bilingual", "translation", "original"] as SubtitleDisplayMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPrefs({ ...prefs, mode })}
                      className={`rounded-md border px-2 py-1.5 text-2xs transition-colors ${
                        prefs.mode === mode
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {t(`live_translation.overlay_mode_${mode}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-2xs text-muted-foreground">{t("live_translation.overlay_font")}</span>
                <div className="flex gap-1">
                  {(["s", "m", "l"] as SubtitleFontScale[]).map((scale) => (
                    <button
                      key={scale}
                      type="button"
                      onClick={() => setPrefs({ ...prefs, fontScale: scale })}
                      className={`rounded-md border px-2 py-0.5 transition-colors ${
                        prefs.fontScale === scale
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {scale.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-2xs text-muted-foreground">{t("live_translation.overlay_lines")}</span>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((lines) => (
                    <button
                      key={lines}
                      type="button"
                      onClick={() => setPrefs({ ...prefs, visibleLines: lines })}
                      className={`size-6 rounded-md border text-2xs transition-colors ${
                        prefs.visibleLines === lines
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {lines}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setPrefs({ ...prefs, position: prefs.position === "bottom" ? "top" : "bottom" })}
                  className="flex-1 rounded-md border border-border px-2 py-1.5 text-2xs text-muted-foreground transition-colors hover:bg-muted"
                >
                  {prefs.position === "bottom"
                    ? t("live_translation.overlay_pin_top")
                    : t("live_translation.overlay_pin_bottom")}
                </button>
                <button
                  type="button"
                  onClick={() => void api?.moveSubtitleToCursorScreen?.().catch(() => undefined)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-2xs text-muted-foreground transition-colors hover:bg-muted"
                >
                  <Monitor className="size-3" />
                  {t("live_translation.overlay_move_screen")}
                </button>
              </div>
            </PopoverContent>
          </Popover>
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

        {/* Latency + health HUD: honest about how far translation trails. */}
        <div className="absolute left-3 top-3 z-20 flex items-center gap-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <span className="flex items-center gap-1.5 rounded-full bg-black/40 px-2.5 py-1 text-2xs text-white/85 backdrop-blur">
            {streamFailed || streamConnecting ? (
              <span className={`size-1.5 rounded-full ${streamFailed ? "bg-red-400" : "animate-pulse bg-amber-300"}`} />
            ) : (
              <span className="size-1.5 rounded-full bg-emerald-400" />
            )}
            <span>{t(labels.asr)}</span>
            {labels.engine && <span className="text-white/60">· {t(labels.engine)}</span>}
            {lagMs != null && (
              <span className="tabular-nums text-white/60">+{(lagMs / 1000).toFixed(1)}s</span>
            )}
          </span>
        </div>

        <div
          className={`pointer-events-none absolute inset-0 z-10 flex flex-col gap-2 px-6 py-4 text-center ${justify}`}
          style={{ textShadow: "0 1px 3px rgba(0,0,0,0.7), 0 0 6px rgba(0,0,0,0.45)" }}
        >
          {historyOpen ? (
            <div
              ref={historyRef}
              className="pointer-events-auto absolute inset-4 overflow-y-auto rounded-xl bg-black/70 p-3 text-left backdrop-blur"
              onScroll={(event) => {
                const el = event.currentTarget;
                historyStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              }}
            >
              <div className="sticky top-0 mb-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setHistoryOpen(false)}
                  className="rounded-full bg-white/10 p-1 text-white/80 transition-colors hover:bg-white/20"
                  aria-label={t("live_translation.overlay_history_close")}
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="space-y-3">
                {historyFinals.length === 0 ? (
                  <p className="py-8 text-center text-sm text-white/60">{t("live_translation.overlay_waiting")}</p>
                ) : (
                  historyFinals.map(({ segment }) => {
                    const hasTranslation = translationOn
                      && Boolean(segment.translatedText)
                      && segment.translatedText !== segment.recognizedText;
                    return (
                      <div key={segment.id} className="min-w-0">
                        {(prefs.mode !== "translation" || !hasTranslation) && (
                          <p className={`text-white ${fonts.original}`}>{segment.recognizedText || segment.translatedText}</p>
                        )}
                        {prefs.mode !== "original" && hasTranslation && (
                          <p className={`text-white/80 ${fonts.translation}`}>{segment.translatedText}</p>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <>
              {visibleFinals.map(({ segment }) => (
                <SubtitleLine key={segment.id} segment={segment} prefs={prefs} translationOn={translationOn} />
              ))}
              {partials.map((segment) => {
                const hasTranslation = translationOn
                  && Boolean(segment.translatedText)
                  && segment.translatedText !== segment.recognizedText;
                const translationPrimary = prefs.mode === "translation" && hasTranslation;
                const main = translationPrimary
                  ? segment.translatedText
                  : (segment.recognizedText || segment.translatedText);
                return (
                  <div key={segment.id} className="min-w-0 opacity-60">
                    <p
                      className={`line-clamp-2 tracking-tight text-white ${
                        translationPrimary ? `${fonts.translation} font-normal` : `${fonts.original} font-light`
                      }`}
                    >
                      {main}
                      <span className="ml-0.5 animate-pulse">…</span>
                    </p>
                    {prefs.mode === "bilingual" && hasTranslation && (
                      <p className={`text-white/70 ${fonts.translation}`}>{segment.translatedText}</p>
                    )}
                  </div>
                );
              })}
              {visibleFinals.length === 0 && partials.length === 0 && (
                <p className="text-lg font-light text-white/70">{t("live_translation.overlay_waiting")}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
