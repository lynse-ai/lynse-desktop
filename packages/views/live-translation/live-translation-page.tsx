"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { Badge } from "@lynse/ui/components/ui/badge";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@lynse/ui/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@lynse/ui/components/ui/command";
import { Alert, AlertDescription, AlertTitle } from "@lynse/ui/components/ui/alert";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe,
  Headphones,
  Loader2,
  Mic,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Square,
  Volume2,
} from "../icons";
import { requestRealtimeSession } from "./api";
import { useNavigation } from "../navigation";
import { useLiveTranslation } from "./use-live-translation";
import {
  DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
  DEFAULT_QWEN_ENDPOINT,
  DEFAULT_VOLC_AST_ENDPOINT,
  type CompletedLiveSession,
  type LivePermissionStatus,
  type LiveTranslationTrayAction,
  type LiveTranslationProvider,
  type LiveTranslationProviderConfig,
} from "./types";
import {
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  LANGUAGE_BY_CODE,
  directionLabel,
} from "./language-options";

export function LiveTranslationPage() {
  const { t } = useTranslation();
  const { api, view } = useLiveTranslation();
  const { pathname } = useNavigation();
  const [permissions, setPermissions] = useState<LivePermissionStatus | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState("zh");
  // Entering via "/live-translation/transcribe" opens in transcription-only mode.
  const [targetLanguage, setTargetLanguage] = useState(
    pathname.endsWith("/transcribe") ? "none" : "en",
  );
  const [langOpen, setLangOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [subtitlesVisible, setSubtitlesVisible] = useState(false);
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);
  const [completed, setCompleted] = useState<CompletedLiveSession | null>(null);
  const [providerConfig, setProviderConfig] = useState<LiveTranslationProviderConfig>({
    provider: "lynse_backend",
    ilivedata: {
      endpoint: DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
      pid: "",
      secretKey: "",
    },
    qwen: {
      endpoint: DEFAULT_QWEN_ENDPOINT,
      apiKey: "",
    },
    volc: {
      endpoint: DEFAULT_VOLC_AST_ENDPOINT,
      apiKey: "",
    },
  });
  const [providerConfigLoaded, setProviderConfigLoaded] = useState(false);
  const [savingProviderConfig, setSavingProviderConfig] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const pendingTrayActionRef = useRef<LiveTranslationTrayAction | null>(null);
  const trayActionHandlerRef = useRef<(action: LiveTranslationTrayAction) => void>(
    () => undefined,
  );

  useEffect(() => {
    if (!api) {
      setPermissionError(t("live_translation.start_hint_desktop"));
      return;
    }
    setPermissionError(null);
    api.permissions()
      .then((status) => {
        setPermissions(status);
        setPermissionError(null);
      })
      .catch((error) => {
        const message = String(error);
        setPermissionError(message);
        toast.error(t("live_translation.permission_check_failed"), { description: message });
      });
  }, [api, t]);

  useEffect(() => {
    if (!api) return;
    api.getProviderConfig()
      .then(setProviderConfig)
      .catch((error) => toast.error(String(error)))
      .finally(() => setProviderConfigLoaded(true));
  }, [api]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [view.segments]);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    api.onTrayAction((action) => trayActionHandlerRef.current(action))
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else cleanup = unsubscribe;
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [api]);

  const transcriptOnly = targetLanguage === "none";
  const visibleSegments = useMemo(
    () =>
      view.segments.filter(
        (segment) => !segment.echoOf && (segment.recognizedText || (!transcriptOnly && segment.translatedText)),
      ),
    [transcriptOnly, view.segments],
  );
  const active = Boolean(view.sessionId) && view.state !== "idle";
  // Direct providers talk to the vendor from this machine, so their credentials
  // must be complete before a session can start. The Lynse backend relay needs
  // no local configuration.
  const directProviderReady = ((): boolean => {
    switch (providerConfig.provider) {
      case "ilivedata_direct":
        return Boolean(
          providerConfig.ilivedata.endpoint.trim()
          && providerConfig.ilivedata.pid.trim()
          && providerConfig.ilivedata.secretKey.trim(),
        );
      case "qwen":
        return Boolean(providerConfig.qwen.apiKey.trim());
      case "volc":
        return Boolean(providerConfig.volc.apiKey.trim());
      default:
        return true;
    }
  })();
  const canStart = !!api
    && providerConfigLoaded
    && directProviderReady
    && permissions?.microphone === "granted"
    && (!permissions.systemAudioRequired || permissions.systemAudio === "granted")
    && !permissions.restartRequired
    && (transcriptOnly || sourceLanguage !== targetLanguage)
    && !active;

  // Human-readable reason the start button is disabled, so the user isn't left
  // guessing why nothing is clickable.
  const startBlockedReason = ((): string | null => {
    if (active) return null;
    if (!api) return t("live_translation.start_hint_desktop");
    if (permissionError) return t("live_translation.start_hint_permission_error");
    if (!providerConfigLoaded || permissions === null) {
      return t("live_translation.start_hint_loading");
    }
    if (permissions.restartRequired) return t("live_translation.start_hint_restart");
    if (permissions.microphone !== "granted") return t("live_translation.start_hint_mic");
    if (permissions.systemAudioRequired && permissions.systemAudio !== "granted") {
      return t("live_translation.start_hint_system_audio");
    }
    if (!directProviderReady) return t("live_translation.start_hint_provider");
    if (!transcriptOnly && sourceLanguage === targetLanguage) {
      return t("live_translation.start_hint_same_lang");
    }
    return null;
  })();

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

  function updateQwenConfig(
    field: keyof LiveTranslationProviderConfig["qwen"],
    value: string,
  ) {
    setProviderConfig((current) => ({
      ...current,
      qwen: { ...current.qwen, [field]: value },
    }));
  }

  function updateVolcConfig(
    field: keyof LiveTranslationProviderConfig["volc"],
    value: string,
  ) {
    setProviderConfig((current) => ({
      ...current,
      volc: { ...current.volc, [field]: value },
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
    if (!api) {
      toast.error(t("live_translation.start_hint_desktop"));
      return;
    }
    setBusy(true);
    setCompleted(null);
    try {
      // Re-read credentials from the OS keychain so a key changed since the
      // page mounted (or edited outside the app) takes effect without a restart.
      const freshConfig = await api.getProviderConfig().catch(() => providerConfig);
      setProviderConfig(freshConfig);
      const savedProviderConfig = await api.saveProviderConfig(freshConfig);
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
      // Maximize the transcript area as soon as a session starts.
      setSettingsCollapsed(true);
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

  trayActionHandlerRef.current = (action) => {
    if (busy || !providerConfigLoaded || permissions === null) {
      pendingTrayActionRef.current = action;
      return;
    }
    if (action === "start") {
      if (canStart) {
        void start();
      } else if (active) {
        toast.info("实时录音已在进行");
      } else {
        toast.warning(t("live_translation.start_failed"), {
          description: permissions.systemAudioRequired && permissions.systemAudio !== "granted"
            ? t("live_translation.system_audio_permission_hint")
            : "请先授予麦克风权限并完成实时翻译配置",
        });
      }
      return;
    }
    if (view.state === "recording") {
      void pause();
    } else {
      toast.info("当前没有正在进行的实时录音");
    }
  };

  useEffect(() => {
    if (busy || !providerConfigLoaded || permissions === null) return;
    const pendingAction = pendingTrayActionRef.current;
    if (!pendingAction) return;
    pendingTrayActionRef.current = null;
    trayActionHandlerRef.current(pendingAction);
  }, [busy, permissions, providerConfigLoaded]);

  async function resume() {
    if (!api || !view.sessionId) return;
    setBusy(true);
    try {
      const epoch = view.epoch + 1;
      const freshConfig = await api.getProviderConfig().catch(() => providerConfig);
      setProviderConfig(freshConfig);
      const credentials = await requestRealtimeSession({
        sourceLanguage: view.sourceLanguage ?? sourceLanguage,
        targetLanguage: view.targetLanguage ?? targetLanguage,
        sessionId: view.sessionId,
        epoch,
      }, freshConfig);
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
    // End the session locally only — no cloud sync per product decision.
    await api.finalizeLocal(result.sessionId, true).catch(() => undefined);
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

      <main className={`relative grid min-h-0 flex-1 ${settingsCollapsed ? "grid-cols-1" : "grid-cols-[minmax(280px,360px)_1fr]"}`}>
        {!settingsCollapsed && (
        <aside className="relative border-r border-border">
          <button
            type="button"
            onClick={() => setSettingsCollapsed(true)}
            title="收起设置栏（最大化字幕区）"
            aria-label="收起设置栏"
            className="absolute right-0 top-1/2 z-20 flex size-8 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
          <div className="h-full overflow-y-auto p-5">
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
              <option value="qwen">{t("live_translation.provider_qwen")}</option>
              <option value="volc">{t("live_translation.provider_volc")}</option>
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
            {providerConfig.provider === "qwen" && (
              <div className="space-y-2 rounded-lg border border-border bg-card p-3">
                <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  {t("live_translation.qwen_hint")}
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="qwen-api-key" className="text-[11px]">
                    {t("live_translation.provider_qwen_api_key")}
                  </Label>
                  <Input
                    id="qwen-api-key"
                    type="password"
                    value={providerConfig.qwen.apiKey}
                    onChange={(event) => updateQwenConfig("apiKey", event.target.value)}
                    disabled={active}
                    className="h-8 text-xs"
                    autoComplete="off"
                    placeholder="sk-..."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qwen-endpoint" className="text-[11px]">
                    {t("live_translation.provider_qwen_endpoint")}
                  </Label>
                  <Input
                    id="qwen-endpoint"
                    value={providerConfig.qwen.endpoint}
                    onChange={(event) => updateQwenConfig("endpoint", event.target.value)}
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
            {providerConfig.provider === "volc" && (
              <div className="space-y-2 rounded-lg border border-border bg-card p-3">
                <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  {t("live_translation.volc_hint")}
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="volc-api-key" className="text-[11px]">
                    {t("live_translation.provider_volc_api_key")}
                  </Label>
                  <Input
                    id="volc-api-key"
                    type="password"
                    value={providerConfig.volc.apiKey}
                    onChange={(event) => updateVolcConfig("apiKey", event.target.value)}
                    disabled={active}
                    className="h-8 text-xs"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="volc-endpoint" className="text-[11px]">
                    {t("live_translation.provider_volc_endpoint")}
                  </Label>
                  <Input
                    id="volc-endpoint"
                    value={providerConfig.volc.endpoint}
                    onChange={(event) => updateVolcConfig("endpoint", event.target.value)}
                    disabled={active}
                    className="h-8 text-xs"
                    placeholder={DEFAULT_VOLC_AST_ENDPOINT}
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
            {permissions?.systemAudioRequired && permissions.systemAudio !== "granted" && (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                {t("live_translation.system_audio_permission_hint")}
              </p>
            )}
            {permissions?.microphone === "granted"
              && !permissions.systemAudioRequired
              && permissions.systemAudio !== "granted" && (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t("live_translation.mic_only_hint")}
              </p>
            )}
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
                <Check className="size-3.5 text-emerald-500" />
                {t("live_translation.local_complete")}
              </div>
            </div>
          )}
          </div>
        </aside>
        )}

        {settingsCollapsed && (
          <button
            type="button"
            onClick={() => setSettingsCollapsed(false)}
            title="展开设置栏"
            aria-label="展开设置栏"
            className="absolute left-0 top-1/2 z-20 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}

        <section className="flex min-h-0 flex-col bg-muted/10">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{t("live_translation.live_transcript")}</span>
              <span className="text-[11px] text-muted-foreground">
                {visibleSegments.length} {t("live_translation.segments")}
              </span>
            </div>
            <Popover open={langOpen} onOpenChange={setLangOpen}>
              <PopoverTrigger
                aria-label={t("live_translation.translation_direction")}
                className="group flex h-7 items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-3 text-[11px] font-medium text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Globe className="size-3.5 text-primary" />
                <span>{t("live_translation.record_title")}</span>
                <span className="text-muted-foreground/70">·</span>
                <span className="tabular-nums">{directionLabel(sourceLanguage, targetLanguage, t)}</span>
                <ChevronDown className={`size-3 opacity-60 transition-transform ${langOpen ? "rotate-180" : ""}`} />
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={8}
                className="w-72 overflow-hidden bg-popover/45 p-0 text-popover-foreground shadow-[var(--shadow-overlay)] backdrop-blur-2xl supports-[backdrop-filter]:backdrop-blur-2xl border border-white/15"
              >
                <LanguageDirectionMenu
                  sourceLanguage={sourceLanguage}
                  targetLanguage={targetLanguage}
                  disabled={active}
                  onSourceChange={(code) => setSourceLanguage(code)}
                  onTargetChange={(code) => setTargetLanguage(code)}
                  onSwap={() => {
                    if (sourceLanguage !== "auto" && targetLanguage !== "none") {
                      const current = sourceLanguage;
                      setSourceLanguage(targetLanguage);
                      setTargetLanguage(current);
                    }
                  }}
                />
              </PopoverContent>
            </Popover>
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
                {visibleSegments.map((segment, index) => {
                  const prevSpeaker = index > 0 ? visibleSegments[index - 1]?.speaker : undefined;
                  const showSpeaker = segment.speaker != null && segment.speaker !== prevSpeaker;
                  return (
                  <article key={segment.id} className="rounded-xl border border-border bg-background px-4 py-3 shadow-sm">
                    <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                        {segment.source === "mic" ? t("live_translation.me") : t("live_translation.remote")}
                      </Badge>
                      {showSpeaker && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {t("live_translation.speaker")} {segment.speaker}
                        </span>
                      )}
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
                );
                })}
              </div>
            )}
          </div>
          <footer className="shrink-0 border-t border-border bg-background/95 px-5 py-3 backdrop-blur">
            {startBlockedReason && !active && (
              <p className="mb-2 flex items-center gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                <span className="size-1.5 rounded-full bg-amber-500" />
                {startBlockedReason}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {view.state === "paused" ? (
                <Button className="flex-1 sm:flex-none" onClick={resume} disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <Play />}
                  {t("live_translation.resume")}
                </Button>
              ) : active ? (
                <Button className="flex-1 sm:flex-none" variant="secondary" onClick={pause} disabled={busy || view.state !== "recording"}>
                  <Pause /> {t("live_translation.pause")}
                </Button>
              ) : (
                <Button
                  className="flex-1 sm:flex-none"
                  onClick={() => {
                    if (busy) return;
                    if (!canStart) {
                      toast.warning(t("live_translation.start_blocked_title"), {
                        description:
                          startBlockedReason ?? t("live_translation.start_hint_loading"),
                      });
                      return;
                    }
                    void start();
                  }}
                  disabled={busy}
                  title={startBlockedReason ?? undefined}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Play />}
                  {permissions?.systemAudioRequired || permissions?.systemAudio === "granted"
                    ? t("live_translation.start")
                    : t("live_translation.start_mic_only")}
                </Button>
              )}
              {active && (
                <Button variant="destructive" onClick={stop} disabled={busy || view.state === "stopping"}>
                  <Square /> {t("live_translation.stop")}
                </Button>
              )}
              <Button variant="outline" className="ml-auto" onClick={toggleSubtitles} disabled={!active}>
                <Volume2 />
                {subtitlesVisible ? t("live_translation.hide_overlay") : t("live_translation.show_overlay")}
              </Button>
            </div>
          </footer>
        </section>
      </main>
    </div>
  );
}

// Single popover that exposes both the source and target language so the
// user can set the full translation direction in one place.
function LanguageDirectionMenu({
  sourceLanguage,
  targetLanguage,
  disabled,
  onSourceChange,
  onTargetChange,
  onSwap,
}: {
  sourceLanguage: string;
  targetLanguage: string;
  disabled: boolean;
  onSourceChange: (code: string) => void;
  onTargetChange: (code: string) => void;
  onSwap: () => void;
}) {
  const { t } = useTranslation();
  const canSwap = sourceLanguage !== "auto" && targetLanguage !== "none";
  return (
    <div className="flex flex-col">
      <div className="px-3 pb-1 pt-3">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t("live_translation.source_language")}</div>
        <LanguageList
          value={sourceLanguage}
          options={SOURCE_LANGUAGE_OPTIONS}
          disabled={disabled}
          onChange={onSourceChange}
          placeholder={t("live_translation.search_language")}
          t={t}
        />
      </div>
      <div className="flex justify-center py-0.5">
        <button
          type="button"
          onClick={onSwap}
          disabled={disabled || !canSwap}
          title={t("live_translation.swap_languages")}
          aria-label={t("live_translation.swap_languages")}
          className="flex size-6 items-center justify-center rounded-full border border-border/60 bg-background/60 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Repeat className="size-3.5" />
        </button>
      </div>
      <div className="px-3 pb-3 pt-0.5">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t("live_translation.target_language")}</div>
        <LanguageList
          value={targetLanguage}
          options={TARGET_LANGUAGE_OPTIONS}
          disabled={disabled}
          onChange={onTargetChange}
          placeholder={t("live_translation.search_language")}
          t={t}
        />
        {targetLanguage === "none" && (
          <p className="mt-1.5 px-1 text-[10px] leading-relaxed text-muted-foreground">
            {t("live_translation.transcript_only_hint")}
          </p>
        )}
      </div>
      {disabled && (
        <p className="border-t border-border/50 px-3 py-2 text-[10px] text-muted-foreground">
          {t("live_translation.locked_while_recording")}
        </p>
      )}
    </div>
  );
}

function LanguageList({
  value,
  options,
  disabled,
  onChange,
  placeholder,
  t,
}: {
  value: string;
  options: readonly { code: string; label: string }[];
  disabled: boolean;
  onChange: (code: string) => void;
  placeholder: string;
  t: (key: string) => string;
}) {
  const labelOf = (code: string) => {
    if (code === "auto") return t("live_translation.auto_detect");
    if (code === "none") return t("live_translation.no_translation");
    return LANGUAGE_BY_CODE[code]?.label ?? code;
  };
  return (
    <Command className="!rounded-none bg-transparent p-0">
      <CommandInput placeholder={placeholder} />
      <CommandList className="max-h-40">
        <CommandEmpty>{t("live_translation.no_language_results")}</CommandEmpty>
        {options.map((option) => (
          <CommandItem
            key={option.code}
            value={`${labelOf(option.code)} ${option.code}`}
            disabled={disabled}
            data-checked={option.code === value}
            onSelect={() => onChange(option.code)}
            className="mx-1 my-0.5 rounded-lg py-1.5 data-[checked=true]:bg-primary/[0.06]"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold uppercase text-muted-foreground">
              {option.code === "none" ? "—" : option.code === "auto" ? "A" : option.code.slice(0, 2)}
            </span>
            <span className="flex-1 text-[13px]">{labelOf(option.code)}</span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
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
