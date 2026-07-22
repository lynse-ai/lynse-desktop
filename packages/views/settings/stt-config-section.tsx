"use client";

import { useState, useEffect } from "react";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { Progress, ProgressValue } from "@lynse/ui/components/ui/progress";
import { cn } from "@lynse/ui/lib/utils";
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

const ENGINE_OPTIONS: { value: SttEngine; label: string }[] = [
  { value: "funasr", label: "FunASR（本地）" },
  { value: "whisper", label: "Whisper（本地）" },
  { value: "moss_transcribe_diarize", label: "MOSS-Transcribe-Diarize（本地）" },
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
    case "moss_transcribe_diarize":
      return {
        provider: "moss_transcribe_diarize",
        hotword_package_id:
          prev?.provider === "moss_transcribe_diarize" ? prev.hotword_package_id ?? null : null,
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
  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
      className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
    >
      <option value="">不使用</option>
      {packages.map((pkg) => (
        <option key={pkg.id} value={pkg.id}>
          {pkg.name}（{pkg.terms.length}词）
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
  if (!model) {
    return <p className="text-[11px] text-muted-foreground">该引擎暂无可下载模型。</p>;
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
    ? "下载失败"
    : isThisDownloading
      ? isRuntimePhase
        ? phase === "runtime_downloading"
          ? "正在下载离线转写组件"
          : phase === "runtime_verifying"
            ? "正在校验离线转写组件"
            : "正在安装离线转写组件"
        : phase === "verifying"
          ? "校验中…"
          : "下载中…"
      : installed
        ? "已安装"
        : "未安装";
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
          下载模型
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
          删除模型
        </Button>
      </div>
    </div>
  );
}

/** Live download progress for a single model. Shows a determinate bar with a
 *  percentage when the total size is known, or an indeterminate sweep for
 *  unknown-size downloads (e.g. FunASR). */
function DownloadProgress({ progress }: { progress: SttDownloadProgress | null }) {
  if (!progress) return null;
  if (progress.percent === null) {
    return (
      <div className="relative mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 h-full w-1/3 rounded-full bg-primary animate-[stt-download-sweep_1.4s_ease-in-out_infinite]" />
      </div>
    );
  }
  return (
    <Progress value={progress.percent} className="mt-2 flex-col items-stretch gap-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {progress.phase === "verifying"
            ? "校验中…"
            : progress.phase === "runtime_downloading"
              ? "正在下载离线转写组件"
              : progress.phase === "runtime_verifying"
                ? "正在校验离线转写组件"
                : progress.phase === "runtime_installing"
                  ? "正在安装离线转写组件"
                  : "下载中…"}
        </span>
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
  const speakers = config.provider === "funasr" || config.provider === "whisper"
    ? config.expected_speakers ?? null
    : null;
  return (
    <div className="mt-2 space-y-2 rounded bg-background p-2">
      {config.provider === "whisper" && (
        <>
          <div className="space-y-1">
            <Label className="text-[11px]">Whisper 模型</Label>
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
            CAM++ 说话人分离
          </label>
        </>
      )}
      {(config.provider === "funasr" || config.provider === "whisper") && (
        <div className="space-y-1">
          <Label className="text-[11px]">预期说话人数</Label>
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
            placeholder="自动"
          />
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-[11px]">热词包</Label>
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
        active && setError(e instanceof Error ? e.message : "加载 STT 配置失败"),
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
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return (
      <div className="rounded-md border bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
        正在加载 STT 路由配置…
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
        <Label className="text-[11px]">默认离线引擎</Label>
        <select
          value={defaultConfig.provider}
          onChange={(event) => changeDefaultEngine(event.target.value as SttEngine)}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        >
          {ENGINE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
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
          <Label className="text-[11px]">按语言路由</Label>
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
            添加语言
          </Button>
        </div>

        {langEntries.length === 0 && (
          <p className="text-[11px] text-muted-foreground">暂无按语言覆盖，全部使用默认引擎。</p>
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
                  placeholder="语言代码，如 zh / en"
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
                  删除
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
                    {option.label}
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
        保存配置
      </Button>
    </div>
  );
}
