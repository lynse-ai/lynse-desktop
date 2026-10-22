"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@lynse/ui/components/ui/tooltip";
import { AlertCircle, Loader2, Mic, Monitor } from "../icons";
import { requestRealtimeSession } from "./api";
import { audioModeSources } from "./api";
import { sourceMode } from "./audio-sources";
import { useLiveTranslation } from "./use-live-translation";
import type { LiveAudioSource, LivePermissionStatus } from "./types";

/** One source selector shared by the recording page and the floating window.
 * Native snapshots, rather than optimistic clicks, own the live icon state. */
export function AudioSourceControls({ compact = false, statusOnly = false, onPreferenceChange }: { compact?: boolean; statusOnly?: boolean; onPreferenceChange?: (mode: "mic" | "system" | "both") => void }) {
  const { api, view } = useLiveTranslation();
  const { t } = useTranslation();
  const [preferred, setPreferred] = useState<LiveAudioSource[]>([]);
  const [permissions, setPermissions] = useState<LivePermissionStatus | null>(null);
  const [pending, setPending] = useState<LiveAudioSource | null>(null);
  const busy = useRef(false);
  const notified = useRef("");
  const active = !!view.sessionId;
  const sources = active ? (view.audioSources ?? []) : preferred;

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    const refresh = async () => {
      const [config, status] = await Promise.all([api.getProviderConfig(), api.permissions()]);
      if (!disposed) {
        setPreferred(audioModeSources(config.audioSource));
        setPermissions(status);
      }
    };
    void refresh().catch(() => undefined);
    const onFocus = () => { void refresh().catch(() => undefined); };
    window.addEventListener("focus", onFocus);
    return () => { disposed = true; window.removeEventListener("focus", onFocus); };
  }, [api, active]);

  const messages = (["system", "mic"] as const).flatMap((source) => {
    const available = source === "mic" ? permissions?.microphoneAvailable : permissions?.systemAudioAvailable;
    const error = view.sourceErrors?.[source] ?? (available === false ? "no_device" : undefined);
    return error ? [{ source, error, text: t("recording_sources.source_status", { source: t(`recording_sources.${source}`), status: t(`recording_sources.${error === "no_device" || error === "permission" ? error : "failed"}`) }) }] : [];
  });
  const showAecWarning = view.aecDegraded && sources.length === 2 && view.systemLevel > 0.01;
  const notice = [...messages.map((m) => m.text), ...(showAecWarning ? [t("recording_sources.aec_failed")] : [])].join("；");
  useEffect(() => {
    const key = `${view.sessionId ?? ""}:${notice}`;
    if (compact && active && notice && notified.current !== key) toast.warning(notice, { id: `recording-sources:${view.sessionId}` });
    notified.current = key;
  }, [compact, active, view.sessionId, notice]);

  if (!api) return null;

  const toggle = async (source: LiveAudioSource) => {
    if (busy.current) return;
    const enabled = sources.includes(source);
    const availableSelected = sources.filter((selected) => !messages.some((message) => message.source === selected));
    if (enabled && (sources.length === 1 || (!messages.some((message) => message.source === source) && availableSelected.length === 1))) { toast.info(t("recording_sources.last_source")); return; }
    const next = enabled ? sources.filter((s) => s !== source) : [...sources, source];
    busy.current = true;
    setPending(source);
    try {
      if (active) {
        if (!api.setSources || !view.sessionId) throw new Error(t("recording_sources.unsupported"));
        const result = await api.setSources({ sessionId: view.sessionId, audioSources: next, sourceRevision: view.sourceRevision ?? 0 });
        if (result.state === "recording" && result.sourceLanguage && result.targetLanguage && result.targetLanguage !== result.sourceLanguage) {
          try {
            const config = await api.getProviderConfig();
            const credentials = await requestRealtimeSession({ sessionId: view.sessionId, sourceLanguage: result.sourceLanguage,
              targetLanguage: result.targetLanguage, epoch: result.epoch + 1, audioSources: result.audioSources }, config);
            await api.setMode({ sessionId: view.sessionId, sourceLanguage: result.sourceLanguage,
              targetLanguage: result.targetLanguage, epoch: credentials.epoch, connections: credentials.connections });
          } catch (error) { toast.warning(t("recording_mode.switch_live_failed"), { description: String(error) }); }
        }
      } else {
        const config = await api.getProviderConfig();
        await api.saveProviderConfig({ ...config, audioSource: sourceMode(next) });
        setPreferred(next);
        onPreferenceChange?.(sourceMode(next));
      }
      const status = await api.permissions();
      setPermissions(status);
    } catch (error) {
      toast.error(t("recording_sources.change_failed"), { description: String(error) });
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  if (statusOnly) return notice ? <p role="status" className="px-3 py-1 text-2xs text-warning-text">{notice}</p> : null;

  return (
    <TooltipProvider delay={200}>
      <div className={cn("flex min-w-0 flex-col gap-1", !compact && "px-5 py-2")}>
        <div role="group" aria-label={t("recording_sources.label")} className="flex items-center gap-1">
          {(["system", "mic"] as const).map((source) => {
            const enabled = sources.includes(source);
            const error = messages.find((message) => message.source === source);
            const unavailable = !!error && (!active || !enabled);
            const off = !enabled || unavailable;
            const Icon = source === "mic" ? Mic : Monitor;
            const level = enabled && view.state === "recording" ? (source === "mic" ? view.micLevel : view.systemLevel) : 0;
            const status = unavailable
              ? t(`recording_sources.${error.error === "no_device" || error.error === "permission" ? error.error : "failed"}`)
              : t(`recording_sources.${enabled ? "on" : "off"}`);
            const action = t(`recording_sources.${unavailable && enabled ? "deselect" : enabled ? "disable" : "enable"}`);
            const label = t("recording_sources.control_label", { source: t(`recording_sources.${source}`), status, action });
            const disabled = pending !== null || (active ? !["recording", "paused"].includes(view.state) : preferred.length === 0);
            return (
              <Tooltip key={source}>
                <TooltipTrigger render={
                  <button type="button" role="switch" aria-checked={enabled && !unavailable} aria-label={label}
                    aria-busy={pending === source} disabled={disabled} onClick={() => void toggle(source)}
                    className={cn("relative flex shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", compact ? "size-6" : "size-9", enabled ? "text-foreground" : "text-muted-foreground")}>
                    <span className="relative" aria-hidden="true">
                      <Icon className={compact ? "size-3.5" : "size-4"} />
                      {off && <svg viewBox="0 0 24 24" className="absolute inset-0 size-full overflow-visible" fill="none"><path d="M3 21 21 3" className="stroke-background" strokeWidth="5" /><path d="M3 21 21 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>}
                    </span>
                    {pending === source && <Loader2 aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-3 animate-spin" />}
                    {unavailable && pending !== source && <AlertCircle aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-3 text-warning-text" />}
                    {!compact && <span aria-hidden="true" className="absolute inset-x-2 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-muted"><span className="block h-full origin-left bg-primary" style={{ transform: `scaleX(${Math.min(1, Math.max(0, level))})` }} /></span>}
                  </button>
                } />
                <TooltipContent>{enabled && sources.length === 1 ? `${label}。${t("recording_sources.last_source")}` : label}</TooltipContent>
              </Tooltip>
            );
          })}
          {!compact && active && view.aecActive && !showAecWarning && <span className="ml-2 text-2xs text-muted-foreground">{t("recording_sources.aec")}</span>}
        </div>
        {!compact && notice && <p role="status" className="text-2xs text-warning-text">{notice}</p>}
      </div>
    </TooltipProvider>
  );
}
