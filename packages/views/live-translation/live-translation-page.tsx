"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { Badge } from "@lynse/ui/components/ui/badge";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@lynse/ui/components/ui/alert";
import {
  Check,
  ChevronRight,
  Headphones,
  Loader2,
  Mic,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Square,
  Volume2,
} from "../icons";
import { uploadFileToOSS } from "../workspace/hooks/use-files";
import { completeRealtimeSession, requestRealtimeSession } from "./api";
import { useLiveTranslation } from "./use-live-translation";
import {
  DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
  type CompletedLiveSession,
  type LivePermissionStatus,
  type LiveRecoverySummary,
  type LiveTranslationProvider,
  type LiveTranslationProviderConfig,
} from "./types";

const LANGUAGE_OPTIONS = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
];

export function LiveTranslationPage() {
  const { t } = useTranslation();
  const { api, view } = useLiveTranslation();
  const [permissions, setPermissions] = useState<LivePermissionStatus | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState("zh");
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [busy, setBusy] = useState(false);
  const [subtitlesVisible, setSubtitlesVisible] = useState(false);
  const [completed, setCompleted] = useState<CompletedLiveSession | null>(null);
  const [recoveries, setRecoveries] = useState<LiveRecoverySummary[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [completedNeedsSync, setCompletedNeedsSync] = useState(false);
  const [providerConfig, setProviderConfig] = useState<LiveTranslationProviderConfig>({
    provider: "lynse_backend",
    ilivedata: {
      endpoint: DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
      pid: "",
      secretKey: "",
    },
  });
  const [providerConfigLoaded, setProviderConfigLoaded] = useState(false);
  const [savingProviderConfig, setSavingProviderConfig] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api?.permissions().then(setPermissions).catch(() => setPermissions(null));
  }, [api]);

  useEffect(() => {
    if (!api) return;
    api.getProviderConfig()
      .then(setProviderConfig)
      .catch((error) => toast.error(String(error)))
      .finally(() => setProviderConfigLoaded(true));
  }, [api]);

  useEffect(() => {
    if (!api || view.state !== "idle") return;
    api.listRecoveries().then(setRecoveries).catch(() => setRecoveries([]));
  }, [api, view.state]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [view.segments]);

  const visibleSegments = useMemo(
    () => view.segments.filter((segment) => !segment.echoOf && (segment.recognizedText || segment.translatedText)),
    [view.segments],
  );
  const active = Boolean(view.sessionId) && view.state !== "idle";
  const directProviderReady = providerConfig.provider !== "ilivedata_direct"
    || Boolean(
      providerConfig.ilivedata.endpoint.trim()
      && providerConfig.ilivedata.pid.trim()
      && providerConfig.ilivedata.secretKey.trim(),
    );
  const canStart = !!api
    && providerConfigLoaded
    && directProviderReady
    && permissions?.microphone === "granted"
    && sourceLanguage !== targetLanguage
    && !active;

  async function selectProvider(provider: LiveTranslationProvider) {
    if (!api) return;
    const next = { ...providerConfig, provider };
    setProviderConfig(next);
    try {
      setProviderConfig(await api.saveProviderConfig(next));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function saveProviderConfig() {
    if (!api) return;
    setSavingProviderConfig(true);
    try {
      setProviderConfig(await api.saveProviderConfig(providerConfig));
      toast.success(t("live_translation.provider_config_saved"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingProviderConfig(false);
    }
  }

  function updateILiveDataConfig(
    field: keyof LiveTranslationProviderConfig["ilivedata"],
    value: string,
  ) {
    setProviderConfig((current) => ({
      ...current,
      ilivedata: { ...current.ilivedata, [field]: value },
    }));
  }

  async function requestPermission(kind: "microphone" | "systemAudio") {
    if (!api) return;
    setBusy(true);
    try {
      const next = await api.requestPermission(kind);
      setPermissions(next);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!api) return;
    setBusy(true);
    setCompleted(null);
    try {
      const savedProviderConfig = await api.saveProviderConfig(providerConfig);
      setProviderConfig(savedProviderConfig);
      const credentials = await requestRealtimeSession({
        sourceLanguage,
        targetLanguage,
        epoch: 0,
      }, savedProviderConfig);
      await api.start({
        sessionId: credentials.sessionId,
        title: `${t("live_translation.record_title")} ${new Date().toLocaleString()}`,
        sourceLanguage,
        targetLanguage,
        epoch: credentials.epoch,
        connections: credentials.connections,
      });
    } catch (error) {
      toast.error(t("live_translation.start_failed"), { description: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function pause() {
    if (!api) return;
    setBusy(true);
    try {
      await api.pause();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!api || !view.sessionId) return;
    setBusy(true);
    try {
      const epoch = view.epoch + 1;
      const credentials = await requestRealtimeSession({
        sourceLanguage: view.sourceLanguage ?? sourceLanguage,
        targetLanguage: view.targetLanguage ?? targetLanguage,
        sessionId: view.sessionId,
        epoch,
      }, providerConfig);
      await api.resume({
        sessionId: view.sessionId,
        epoch: credentials.epoch,
        connections: credentials.connections,
      });
    } catch (error) {
      toast.error(t("live_translation.resume_failed"), { description: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!api) return;
    setBusy(true);
    try {
      const result = await api.stop();
      setCompleted(result);
      await finishCompletedSession(result);
    } catch (error) {
      toast.error(t("live_translation.stop_failed"), { description: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function finishCompletedSession(result: CompletedLiveSession) {
    if (!api) return;
    if (providerConfig.provider === "ilivedata_direct") {
      await api.finalizeLocal(result.sessionId, true);
      setCompletedNeedsSync(false);
      setRecoveries((current) => current.filter((item) => item.sessionId !== result.sessionId));
      toast.success(t("live_translation.direct_saved"));
      return;
    }
    setCompletedNeedsSync(true);
    await syncCompletedSession(result);
  }

  async function syncCompletedSession(result: CompletedLiveSession) {
    if (!api) return;
    setSyncing(true);
    try {
      const response = await fetch(result.playbackUrl);
      if (!response.ok) throw new Error(`读取本地录音失败：${response.status}`);
      const blob = await response.blob();
      const file = new File([blob], `live-translation-${result.sessionId}.wav`, { type: "audio/wav" });
      const fileId = await uploadFileToOSS(file);
      await completeRealtimeSession({
        sessionId: result.sessionId,
        fileId,
        durationMs: result.durationMs,
        segments: result.segments,
      });
      await api.finalizeLocal(result.sessionId, true);
      setCompletedNeedsSync(false);
      setRecoveries((current) => current.filter((item) => item.sessionId !== result.sessionId));
      toast.success(t("live_translation.saved"));
    } catch (error) {
      await api.finalizeLocal(result.sessionId, false).catch(() => undefined);
      setCompletedNeedsSync(true);
      toast.warning(t("live_translation.saved_locally"), { description: String(error) });
    } finally {
      setSyncing(false);
    }
  }

  async function recoverLocal(sessionId: string) {
    if (!api) return;
    setBusy(true);
    try {
      const result = await api.recover(sessionId);
      setCompleted(result);
      await finishCompletedSession(result);
    } catch (error) {
      toast.error(t("live_translation.recovery_failed"), { description: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleSubtitles() {
    if (!api) return;
    const next = !subtitlesVisible;
    await api.showSubtitles(next);
    setSubtitlesVisible(next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5" data-tauri-drag-region>
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Headphones className="size-4" />
          </span>
          <div>
            <h1 className="text-sm font-semibold">{t("live_translation.title")}</h1>
            <p className="text-[11px] text-muted-foreground">{t("live_translation.subtitle")}</p>
          </div>
        </div>
        <StatusBadge state={view.state} elapsedMs={view.elapsedMs} />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_1fr]">
        <aside className="overflow-y-auto border-r border-border p-5">
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("live_translation.provider")}
            </h2>
            <select
              value={providerConfig.provider}
              onChange={(event) => void selectProvider(event.target.value as LiveTranslationProvider)}
              disabled={active || !providerConfigLoaded}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            >
              <option value="lynse_backend">{t("live_translation.provider_backend")}</option>
              <option value="ilivedata_direct">{t("live_translation.provider_ilivedata_direct")}</option>
            </select>
            {providerConfig.provider === "ilivedata_direct" && (
              <div className="space-y-2 rounded-lg border border-border bg-card p-3">
                <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  {t("live_translation.direct_test_hint")}
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="ilivedata-pid" className="text-[11px]">
                    {t("live_translation.provider_pid")}
                  </Label>
                  <Input
                    id="ilivedata-pid"
                    value={providerConfig.ilivedata.pid}
                    onChange={(event) => updateILiveDataConfig("pid", event.target.value)}
                    disabled={active}
                    className="h-8 text-xs"
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ilivedata-secret-key" className="text-[11px]">
                    {t("live_translation.provider_secret_key")}
                  </Label>
                  <Input
                    id="ilivedata-secret-key"
                    type="password"
                    value={providerConfig.ilivedata.secretKey}
                    onChange={(event) => updateILiveDataConfig("secretKey", event.target.value)}
                    disabled={active}
                    className="h-8 text-xs"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ilivedata-endpoint" className="text-[11px]">
                    {t("live_translation.provider_websocket_endpoint")}
                  </Label>
                  <Input
                    id="ilivedata-endpoint"
                    value={providerConfig.ilivedata.endpoint}
                    onChange={(event) => updateILiveDataConfig("endpoint", event.target.value)}
                    disabled={active}
                    className="h-8 text-xs"
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 w-full text-xs"
                  onClick={saveProviderConfig}
                  disabled={active || savingProviderConfig}
                >
                  {savingProviderConfig ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {t("live_translation.save_provider_config")}
                </Button>
              </div>
            )}
          </section>

          <section className="mt-6 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("live_translation.languages")}</h2>
            <div className="flex items-center gap-2">
              <LanguageSelect value={sourceLanguage} onChange={setSourceLanguage} disabled={active} />
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              <LanguageSelect value={targetLanguage} onChange={setTargetLanguage} disabled={active} />
            </div>
          </section>

          <section className="mt-6 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("live_translation.audio_sources")}</h2>
            <PermissionRow
              icon={<Mic className="size-4" />}
              title={t("live_translation.microphone")}
              status={permissions?.microphone}
              level={view.micLevel}
              disabled={busy || active}
              onRequest={() => requestPermission("microphone")}
            />
            <PermissionRow
              icon={<Monitor className="size-4" />}
              title={t("live_translation.system_audio")}
              status={permissions?.systemAudio}
              level={view.systemLevel}
              disabled={busy || active}
              onRequest={() => requestPermission("systemAudio")}
            />
            {permissions?.restartRequired && (
              <Alert>
                <RefreshCw className="size-4" />
                <AlertTitle>{t("live_translation.restart_title")}</AlertTitle>
                <AlertDescription>{t("live_translation.restart_hint")}</AlertDescription>
              </Alert>
            )}
            {permissions?.microphone === "granted" && permissions.systemAudio !== "granted" && (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t("live_translation.mic_only_hint")}
              </p>
            )}
          </section>

          <section className="mt-6 space-y-3">
            <div className="flex gap-2">
              {view.state === "paused" ? (
                <Button className="flex-1" onClick={resume} disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <Play />}
                  {t("live_translation.resume")}
                </Button>
              ) : active ? (
                <Button className="flex-1" variant="secondary" onClick={pause} disabled={busy || view.state !== "recording"}>
                  <Pause /> {t("live_translation.pause")}
                </Button>
              ) : (
                <Button className="flex-1" onClick={start} disabled={!canStart || busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <Play />}
                  {permissions?.systemAudio === "granted" ? t("live_translation.start") : t("live_translation.start_mic_only")}
                </Button>
              )}
              {active && (
                <Button variant="destructive" onClick={stop} disabled={busy || view.state === "stopping"}>
                  <Square /> {t("live_translation.stop")}
                </Button>
              )}
            </div>
            <Button variant="outline" className="w-full" onClick={toggleSubtitles} disabled={!active}>
              <Volume2 />
              {subtitlesVisible ? t("live_translation.hide_overlay") : t("live_translation.show_overlay")}
            </Button>
          </section>

          {view.lastError && (
            <Alert variant="destructive" className="mt-5">
              <AlertTitle>{t("live_translation.issue")}</AlertTitle>
              <AlertDescription>{view.lastError}</AlertDescription>
            </Alert>
          )}
          {completed && (
            <div className="mt-5 rounded-lg border border-border bg-muted/30 p-3 text-xs">
              <div className="flex items-center gap-2 font-medium">
                {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5 text-emerald-500" />}
                {syncing ? t("live_translation.syncing") : t("live_translation.local_complete")}
              </div>
              {!syncing && completedNeedsSync && (
                <button className="mt-2 text-primary hover:underline" onClick={() => syncCompletedSession(completed)}>
                  {t("live_translation.retry_sync")}
                </button>
              )}
            </div>
          )}
          {!active && recoveries.some((item) => item.sessionId !== completed?.sessionId) && (
            <section className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <h2 className="text-xs font-semibold">{t("live_translation.recovery_title")}</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">{t("live_translation.recovery_hint")}</p>
              <div className="mt-2 space-y-2">
                {recoveries.filter((item) => item.sessionId !== completed?.sessionId).map((recovery) => (
                  <div key={recovery.sessionId} className="flex items-center gap-2 rounded-md bg-background/70 p-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{recovery.title}</p>
                      <p className="text-[10px] text-muted-foreground">{new Date(recovery.startedAt).toLocaleString()}</p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-[10px]" disabled={busy} onClick={() => recoverLocal(recovery.sessionId)}>
                      {t("live_translation.recover")}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </aside>

        <section className="flex min-h-0 flex-col bg-muted/10">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-5">
            <span className="text-xs font-medium">{t("live_translation.live_transcript")}</span>
            <span className="text-[11px] text-muted-foreground">{visibleSegments.length} {t("live_translation.segments")}</span>
          </div>
          <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-5">
            {visibleSegments.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
                <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
                  <Volume2 className="size-5" />
                </span>
                <p className="text-sm font-medium text-foreground">{t("live_translation.empty_title")}</p>
                <p className="mt-1 max-w-sm text-xs">{t("live_translation.empty_hint")}</p>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-3">
                {visibleSegments.map((segment) => (
                  <article key={segment.id} className="rounded-xl border border-border bg-background px-4 py-3 shadow-sm">
                    <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                        {segment.source === "mic" ? t("live_translation.me") : t("live_translation.remote")}
                      </Badge>
                      <span className="tabular-nums">{formatTime(segment.startMs)}</span>
                      {!segment.isFinal && <span className="animate-pulse">{t("live_translation.recognizing")}</span>}
                    </div>
                    {/* Original language on top */}
                    <p className="text-base font-medium leading-relaxed text-foreground">
                      {segment.recognizedText || segment.translatedText}
                    </p>
                    {/* Target language below, only when it adds something new */}
                    {segment.translatedText && segment.translatedText !== segment.recognizedText && (
                      <div className="mt-1.5 border-l-2 border-border pl-2.5">
                        <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                          {t("live_translation.translation")}
                        </span>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {segment.translatedText}
                        </p>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function LanguageSelect({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
    >
      {LANGUAGE_OPTIONS.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
    </select>
  );
}

function PermissionRow({ icon, title, status, level, disabled, onRequest }: {
  icon: ReactNode;
  title: string;
  status?: string;
  level: number;
  disabled: boolean;
  onRequest: () => void;
}) {
  const { t } = useTranslation();
  const granted = status === "granted";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="flex-1 text-xs font-medium">{title}</span>
        {granted ? (
          <Badge variant="secondary" className="text-[10px] text-emerald-600"><Check className="size-3" />{t("live_translation.granted")}</Badge>
        ) : (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" disabled={disabled} onClick={onRequest}>
            {t("live_translation.grant")}
          </Button>
        )}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width] duration-100" style={{ width: `${Math.min(100, Math.max(2, level * 100))}%` }} />
      </div>
    </div>
  );
}

function StatusBadge({ state, elapsedMs }: { state: string; elapsedMs: number }) {
  const { t } = useTranslation();
  const recording = state === "recording";
  return (
    <Badge variant="outline" className="gap-2 font-normal">
      <span className={`size-1.5 rounded-full ${recording ? "animate-pulse bg-red-500" : "bg-muted-foreground/50"}`} />
      {t(`live_translation.state_${state}`)}
      {state !== "idle" && <span className="tabular-nums text-muted-foreground">{formatTime(elapsedMs)}</span>}
    </Badge>
  );
}

function formatTime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}
