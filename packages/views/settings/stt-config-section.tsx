"use client";

import { useState, useEffect } from "react";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { Progress, ProgressValue } from "@lynse/ui/components/ui/progress";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2, Plus, Trash2 } from "../icons";
import {
  type DesktopLocalTranscriptionApi,
  type SttDownloadProgress,
  type SttEngine,
  type SttModelInfo,
  type SttProviderConfig,
  type TranscribeConfig,
  type WhisperModel,
  WHISPER_MODELS,
  WHISPER_MODEL_LABELS,
  DEFAULT_WHISPER_MODEL,
  providerModelId,
} from "../workspace/local-transcription";
import type { LocalHotwordPackage } from "../workspace/types";

/** Engine id -> translation key, resolved at render time so the labels follow the UI locale. */
const ENGINE_OPTIONS: { value: SttEngine; labelKey: string }[] = [
  { value: "funasr", labelKey: "settings.stt_engine_funasr" },
  { value: "whisper", labelKey: "settings.stt_engine_whisper" },
  { value: "vibeasr", labelKey: "settings.stt_engine_vibeasr" },
  { value: "mlx", labelKey: "settings.stt_engine_mlx" },
];

function providerForEngine(engine: SttEngine, prev?: SttProviderConfig): SttProviderConfig {
  switch (engine) {
    case "funasr":
      return {
        provider: "funasr",
        expected_speakers: prev?.provider === "funasr" ? prev.expected_speakers ?? null : null,
        hotword_package_id: prev?.provider === "funasr" ? prev.hotword_package_id ?? null : null,
      };
    case "whisper":
      return {
        provider: "whisper",
        model: prev?.provider === "whisper" ? prev.model : DEFAULT_WHISPER_MODEL,
        campp_diarization: prev?.provider === "whisper" ? prev.campp_diarization ?? false : false,
        expected_speakers: prev?.provider === "whisper" ? prev.expected_speakers ?? null : null,
        hotword_package_id: prev?.provider === "whisper" ? prev.hotword_package_id ?? null : null,
      };
    case "vibeasr":
      return {
        provider: "vibeasr",
        hotword_package_id: prev?.provider === "vibeasr" ? prev.hotword_package_id ?? null : null,
      };
    case "mlx":
      return {
        provider: "mlx",
        model: prev?.provider === "mlx" ? prev.model ?? "whisper-large-v3-turbo" : "whisper-large-v3-turbo",
        hotword_package_id: prev?.provider === "mlx" ? prev.hotword_package_id ?? null : null,
      };
  }
}

function HotwordSelect({
  value,
  packages,
  onChange,
}: {
  value: string | null | undefined;
  packages: LocalHotwordPackage[];
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
      className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
    >
      <option value="">{t("settings.stt_hotword_none")}</option>
      {packages.map((pkg) => (
        <option key={pkg.id} value={pkg.id}>
          {t("settings.stt_hotword_terms", { name: pkg.name, terms: pkg.terms.length })}
        </option>
      ))}
    </select>
  );
}

function ModelManager({
  model,
  busy,
  progress,
  onDownload,
  onDelete,
}: {
  model: SttModelInfo | undefined;
  busy: boolean;
  progress: SttDownloadProgress | null;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  if (!model) {
    return <p className="text-[11px] text-muted-foreground">{t("settings.stt_no_models")}</p>;
  }
  const installed = model.status === "installed";
  const isThisDownloading =
    !!progress && progress.provider === model.provider && progress.modelId === model.id;
  const phase = progress?.phase;
  const isError = phase === "error";
  const isDone = phase === "done";
  const isRuntimePhase =
    phase === "runtime_downloading" || phase === "runtime_verifying" || phase === "runtime_installing";
  const statusText = isError
    ? t("settings.stt_status_download_failed")
    : isThisDownloading
      ? isRuntimePhase
        ? phase === "runtime_downloading"
          ? t("settings.stt_status_runtime_downloading")
          : phase === "runtime_verifying"
            ? t("settings.stt_status_runtime_verifying")
            : t("settings.stt_status_runtime_installing")
        : phase === "verifying"
          ? t("settings.stt_status_verifying")
          : t("settings.stt_status_downloading")
      : installed
        ? t("settings.stt_status_installed")
        : t("settings.stt_status_not_installed");
  return (
    <div className="mt-2 rounded bg-background p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium">{model.label}</p>
          <p className="truncate text-[11px] text-muted-foreground">{model.modelDir}</p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
            isError ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
          )}
        >
          {statusText}
        </span>
      </div>

      {isThisDownloading && !isError && !isDone ? <DownloadProgress progress={progress} /> : null}

      {isError && progress?.error ? (
        <p className="mt-2 text-[11px] text-destructive">{progress.error}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={onDownload}
          disabled={busy || installed || isThisDownloading}
        >
          {busy && !isThisDownloading ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
          {t("settings.stt_download_model")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={onDelete}
          disabled={busy || !installed || isThisDownloading}
        >
          <Trash2 className="mr-1.5 size-3" />
          {t("settings.stt_delete_model")}
        </Button>
      </div>
    </div>
  );
}

const DOWNLOAD_PHASE_KEYS: Partial<Record<SttDownloadProgress["phase"], string>> = {
  preparing: "settings.stt_status_preparing",
  verifying: "settings.stt_status_verifying",
  runtime_downloading: "settings.stt_status_runtime_downloading",
  runtime_verifying: "settings.stt_status_runtime_verifying",
  runtime_installing: "settings.stt_status_runtime_installing",
};

/** Translation key for the current download phase. */
function downloadPhaseKey(phase: SttDownloadProgress["phase"]): string {
  return DOWNLOAD_PHASE_KEYS[phase] ?? "settings.stt_status_downloading";
}

/** Live download progress for a single model. Shows a determinate bar with a
 *  percentage when the total size is known, or an indeterminate sweep for
 *  unknown-size downloads (e.g. FunASR). */
function DownloadProgress({ progress }: { progress: SttDownloadProgress | null }) {
  const { t } = useTranslation();
  if (!progress) return null;
  if (progress.percent === null) {
    // Indeterminate: the sweep by itself reads as "working", and the label
    // keeps the `preparing` phase from looking like a frozen click.
    return (
      <div className="mt-2">
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="absolute inset-y-0 left-0 h-full w-1/3 rounded-full bg-primary animate-[stt-download-sweep_1.4s_ease-in-out_infinite]" />
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t(downloadPhaseKey(progress.phase))}
        </div>
      </div>
    );
  }
  return (
    <Progress value={progress.percent} className="mt-2 flex-col items-stretch gap-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{t(downloadPhaseKey(progress.phase))}</span>
        <ProgressValue className="text-[11px]" />
      </div>
    </Progress>
  );
}

function EngineFields({
  config,
  hotwordPackages,
  onChange,
}: {
  config: SttProviderConfig;
  hotwordPackages: LocalHotwordPackage[];
  onChange: (next: SttProviderConfig) => void;
}) {
  const { t } = useTranslation();
  const speakers = config.provider === "funasr" || config.provider === "whisper"
    ? config.expected_speakers ?? null
    : null;
  return (
    <div className="mt-2 space-y-2 rounded bg-background p-2">
      {config.provider === "mlx" && (
        <p className="text-[11px] text-muted-foreground">{t("settings.stt_mlx_hint")}</p>
      )}
      {config.provider === "vibeasr" && (
        <p className="text-[11px] text-muted-foreground">{t("settings.stt_vibeasr_hint")}</p>
      )}
      {config.provider === "whisper" && (
        <>
          <div className="space-y-1">
            <Label className="text-[11px]">{t("settings.stt_whisper_model")}</Label>
            <select
              value={config.model ?? DEFAULT_WHISPER_MODEL}
              onChange={(event) => onChange({ ...config, model: event.target.value as WhisperModel })}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
            >
              {WHISPER_MODELS.map((id) => (
                <option key={id} value={id}>
                  {WHISPER_MODEL_LABELS[id]}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={config.campp_diarization ?? false}
              onChange={(event) => onChange({ ...config, campp_diarization: event.target.checked })}
            />
            {t("settings.stt_campp_diarization")}
          </label>
        </>
      )}
      {(config.provider === "funasr" || config.provider === "whisper") && (
        <div className="space-y-1">
          <Label className="text-[11px]">{t("settings.stt_expected_speakers")}</Label>
          <Input
            type="number"
            min={0}
            value={speakers ?? ""}
            onChange={(event) => {
              const raw = event.target.value.trim();
              const num = raw === "" ? null : Number.isFinite(Number(raw)) ? Number(raw) : null;
              onChange({ ...config, expected_speakers: num });
            }}
            className="h-8 text-xs"
            placeholder={t("settings.stt_auto")}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-[11px]">{t("settings.stt_hotword_package")}</Label>
        <HotwordSelect
          value={config.hotword_package_id}
          packages={hotwordPackages}
          onChange={(id) => onChange({ ...config, hotword_package_id: id })}
        />
      </div>
    </div>
  );
}

type LangEntry = { language: string; config: SttProviderConfig };

export function SttConfigSection({
  api,
  models,
  modelBusy,
  modelError,
  downloadProgress,
  onDownloadModel,
  onDeleteModel,
  hotwordPackages,
}: {
  api: DesktopLocalTranscriptionApi;
  models: SttModelInfo[];
  modelBusy: boolean;
  modelError: string | null;
  downloadProgress: SttDownloadProgress | null;
  onDownloadModel: (provider: SttEngine, modelId: string) => void;
  onDeleteModel: (provider: SttEngine, modelId: string) => void;
  hotwordPackages: LocalHotwordPackage[];
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<TranscribeConfig | null>(null);
  const [langEntries, setLangEntries] = useState<LangEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getSttConfig()
      .then((loaded) => {
        if (!active) return;
        setConfig(loaded);
        setLangEntries(
          Object.entries(loaded.per_language ?? {}).map(([language, cfg]) => ({
            language,
            config: cfg,
          })),
        );
      })
      .catch((e: unknown) =>
        active && setError(e instanceof Error ? e.message : t("settings.stt_load_failed")),
      );
    return () => {
      active = false;
    };
  }, [api]);

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const next: TranscribeConfig = {
        default: config.default ?? null,
        per_language: Object.fromEntries(
          langEntries
            .filter((entry) => entry.language.trim())
            .map((entry) => [entry.language.trim(), entry.config]),
        ),
      };
      await api.saveSttConfig(next);
      setConfig(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("settings.stt_save_failed"));
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return (
      <div className="rounded-md border bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
        {t("settings.stt_loading")}
      </div>
    );
  }

  const defaultConfig: SttProviderConfig = config.default ?? { provider: "funasr" };
  const defaultModelId = providerModelId(defaultConfig);
  const defaultModel = models.find((m) => m.provider === defaultConfig.provider && m.id === defaultModelId);

  function updateDefault(next: SttProviderConfig) {
    setConfig((current) => (current ? { ...current, default: next } : current));
  }

  function changeDefaultEngine(engine: SttEngine) {
    updateDefault(providerForEngine(engine, defaultConfig));
  }

  return (
    <div className="space-y-3">
      <style>{`@keyframes stt-download-sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }`}</style>
      <div className="space-y-1">
        <Label className="text-[11px]">{t("settings.stt_engine_default")}</Label>
        <select
          value={defaultConfig.provider}
          onChange={(event) => changeDefaultEngine(event.target.value as SttEngine)}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        >
          {ENGINE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
        <EngineFields config={defaultConfig} hotwordPackages={hotwordPackages} onChange={updateDefault} />
        <ModelManager
          model={defaultModel}
          busy={modelBusy}
          progress={downloadProgress}
          onDownload={() => onDownloadModel(defaultConfig.provider, defaultModelId)}
          onDelete={() => onDeleteModel(defaultConfig.provider, defaultModelId)}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">{t("settings.stt_per_language")}</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() =>
              setLangEntries((list) => [...list, { language: "", config: { provider: "funasr" } }])
            }
          >
            <Plus className="mr-1 size-3" />
            {t("settings.stt_add_language")}
          </Button>
        </div>

        {langEntries.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            {t("settings.stt_no_language_override")}
          </p>
        )}

        {langEntries.map((entry, index) => {
          const modelId = providerModelId(entry.config);
          const model = models.find((m) => m.provider === entry.config.provider && m.id === modelId);
          return (
            <div key={index} className="space-y-2 rounded bg-background p-2">
              <div className="flex items-center gap-2">
                <Input
                  value={entry.language}
                  onChange={(event) =>
                    setLangEntries((list) =>
                      list.map((item, i) => (i === index ? { ...item, language: event.target.value } : item)),
                    )
                  }
                  placeholder={t("settings.stt_language_placeholder")}
                  className="h-8 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => setLangEntries((list) => list.filter((_, i) => i !== index))}
                >
                  <Trash2 className="mr-1 size-3" />
                  {t("settings.delete")}
                </Button>
              </div>
              <select
                value={entry.config.provider}
                onChange={(event) =>
                  setLangEntries((list) =>
                    list.map((item, i) =>
                      i === index ? { ...item, config: providerForEngine(event.target.value as SttEngine, item.config) } : item,
                    ),
                  )
                }
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
              >
                {ENGINE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
              <EngineFields
                config={entry.config}
                hotwordPackages={hotwordPackages}
                onChange={(next) =>
                  setLangEntries((list) => list.map((item, i) => (i === index ? { ...item, config: next } : item)))
                }
              />
              <ModelManager
                model={model}
                busy={modelBusy}
                progress={downloadProgress}
                onDownload={() => onDownloadModel(entry.config.provider, modelId)}
                onDelete={() => onDeleteModel(entry.config.provider, modelId)}
              />
            </div>
          );
        })}
      </div>

      {modelError && <p className="text-[11px] text-destructive">{modelError}</p>}
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}

      <Button type="button" size="sm" className="mt-1 h-7 text-xs" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
        {t("settings.stt_save_config")}
      </Button>
    </div>
  );
}
