"use client";

import { useState, useEffect } from "react";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";
import {
  type DesktopLocalTranscriptionApi,
  type SttEngine,
  type SttModelInfo,
  type SttProviderConfig,
  type TranscribeConfig,
  type WhisperModel,
  WHISPER_MODELS,
  WHISPER_MODEL_LABELS,
  DEFAULT_WHISPER_MODEL,
  QWEN3_MODELS,
  QWEN3_MODEL_LABELS,
  DEFAULT_QWEN3_MODEL,
  MOSS_MODELS,
  MOSS_MODEL_LABELS,
  DEFAULT_MOSS_MODEL,
  NON_MAC_ENGINES,
  findModelStatus,
} from "../workspace/local-transcription";
import type { LocalHotwordPackage } from "../workspace/types";
import { isMacDesktop } from "../layout/use-maximized";

/** Engine id -> translation key, resolved at render time so the labels follow the UI locale.
 *  Model download lives in the plugin community (Settings → Plugins) — this
 *  section only configures which engine runs and with what options. */
const ENGINE_OPTIONS: { value: SttEngine; labelKey: string }[] = [
  { value: "funasr", labelKey: "settings.stt_engine_funasr" },
  { value: "qwen3", labelKey: "settings.stt_engine_qwen3" },
  { value: "moss", labelKey: "settings.stt_engine_moss" },
  { value: "whisperx", labelKey: "settings.stt_engine_whisperx" },
  { value: "whisper", labelKey: "settings.stt_engine_whisper" },
  { value: "vibeasr", labelKey: "settings.stt_engine_vibeasr" },
  { value: "mlx", labelKey: "settings.stt_engine_mlx" },
];

const VISIBLE_ENGINE_OPTIONS = isMacDesktop
  ? ENGINE_OPTIONS
  : ENGINE_OPTIONS.filter((option) => NON_MAC_ENGINES.has(option.value));

/** Platform-aware stand-in for an unset `config.default` — mirrors the Rust
 *  `ProviderConfig::default()` (Qwen3 on Apple Silicon, whisper elsewhere). */
const defaultProviderConfig = (): SttProviderConfig =>
  isMacDesktop
    ? { provider: "qwen3", model: DEFAULT_QWEN3_MODEL }
    : { provider: "whisper", model: DEFAULT_WHISPER_MODEL };

function providerForEngine(engine: SttEngine, prev?: SttProviderConfig): SttProviderConfig {
  switch (engine) {
    case "qwen3":
      return {
        provider: "qwen3",
        model: prev?.provider === "qwen3" ? prev.model ?? DEFAULT_QWEN3_MODEL : DEFAULT_QWEN3_MODEL,
        hotword_package_id: prev?.provider === "qwen3" ? prev.hotword_package_id ?? null : null,
      };
    case "funasr":
      return {
        provider: "funasr",
        expected_speakers: prev?.provider === "funasr" ? prev.expected_speakers ?? null : null,
        hotword_package_id: prev?.provider === "funasr" ? prev.hotword_package_id ?? null : null,
      };
    case "whisperx":
      return {
        provider: "whisperx",
        expected_speakers: prev?.provider === "whisperx" ? prev.expected_speakers ?? null : null,
        hotword_package_id: prev?.provider === "whisperx" ? prev.hotword_package_id ?? null : null,
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
    case "moss":
      return {
        provider: "moss",
        model: prev?.provider === "moss" ? prev.model ?? DEFAULT_MOSS_MODEL : DEFAULT_MOSS_MODEL,
        hotword_package_id: prev?.provider === "moss" ? prev.hotword_package_id ?? null : null,
      };
    case "sherpa":
      // Voiceprint-model provider, not a transcription engine — absent from
      // ENGINE_OPTIONS, so this branch is unreachable in the UI.
      return defaultProviderConfig();
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

/** One-line install status for the model backing the selected engine config.
 *  Download/uninstall lives in the plugin community — this either confirms
 *  "installed" or offers the deep link over. */
function ModelStatusHint({
  config,
  models,
  onBrowseModels,
}: {
  config: SttProviderConfig;
  models: SttModelInfo[];
  onBrowseModels?: () => void;
}) {
  const { t } = useTranslation();
  const model = findModelStatus(models, config);
  if (model?.status === "installed") {
    return (
      <p className="text-2xs leading-relaxed text-muted-foreground">
        ✓ {t("settings.stt_status_installed")}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-2xs text-muted-foreground">
        {t("settings.stt_status_not_installed")}
      </span>
      {onBrowseModels && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-2xs"
          onClick={onBrowseModels}
        >
          {t("settings.stt_browse_models")}
        </Button>
      )}
    </div>
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
  const speakers = config.provider === "funasr" || config.provider === "whisper" || config.provider === "whisperx"
    ? config.expected_speakers ?? null
    : null;
  return (
    <div className="mt-2 space-y-2 rounded bg-background p-2">
      {config.provider === "qwen3" && (
        <>
          <p className="text-2xs text-muted-foreground">{t("settings.stt_qwen3_hint")}</p>
          <div className="space-y-1">
            <Label className="text-2xs">{t("settings.stt_qwen3_model")}</Label>
            <select
              value={config.model ?? DEFAULT_QWEN3_MODEL}
              onChange={(event) => onChange({ ...config, model: event.target.value })}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
            >
              {QWEN3_MODELS.map((id) => (
                <option key={id} value={id}>
                  {QWEN3_MODEL_LABELS[id]}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {config.provider === "moss" && (
        <>
          <p className="text-2xs text-muted-foreground">{t("settings.stt_moss_hint")}</p>
          <div className="space-y-1">
            <Label className="text-2xs">{t("settings.stt_moss_model")}</Label>
            <select
              value={config.model ?? DEFAULT_MOSS_MODEL}
              onChange={(event) => onChange({ ...config, model: event.target.value })}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
            >
              {MOSS_MODELS.map((id) => (
                <option key={id} value={id}>
                  {MOSS_MODEL_LABELS[id]}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {config.provider === "mlx" && (
        <p className="text-2xs text-muted-foreground">{t("settings.stt_mlx_hint")}</p>
      )}
      {config.provider === "vibeasr" && (
        <p className="text-2xs text-muted-foreground">{t("settings.stt_vibeasr_hint")}</p>
      )}
      {config.provider === "whisperx" && (
        <p className="text-2xs text-muted-foreground">{t("settings.stt_whisperx_hint")}</p>
      )}
      {config.provider === "whisper" && (
        <>
          <div className="space-y-1">
            <Label className="text-2xs">{t("settings.stt_whisper_model")}</Label>
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
          <label className="flex items-center gap-2 text-2xs">
            <input
              type="checkbox"
              checked={config.campp_diarization ?? false}
              onChange={(event) => onChange({ ...config, campp_diarization: event.target.checked })}
            />
            {t("settings.stt_campp_diarization")}
          </label>
        </>
      )}
      {(config.provider === "funasr" || config.provider === "whisper" || config.provider === "whisperx") && (
        <div className="space-y-1">
          <Label className="text-2xs">{t("settings.stt_expected_speakers")}</Label>
          <Input
            type="number"
            min={0}
            step={1}
            value={speakers ?? ""}
            onChange={(event) => {
              // The Rust side stores this as u64: clamp negatives/fractions to
              // null ("auto") so an out-of-range value can't invalidate the
              // whole saved config.
              const raw = event.target.value.trim();
              const num = raw === "" ? null : Number(raw);
              const safe = num !== null && Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
              onChange({ ...config, expected_speakers: safe });
            }}
            className="h-8 text-xs"
            placeholder={t("settings.stt_auto")}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-2xs">{t("settings.stt_hotword_package")}</Label>
        <HotwordSelect
          value={config.hotword_package_id}
          packages={hotwordPackages}
          onChange={(id) => onChange({ ...config, hotword_package_id: id })}
        />
      </div>
    </div>
  );
}

export function SttConfigSection({
  api,
  hotwordPackages,
  onBrowseModels,
}: {
  api: DesktopLocalTranscriptionApi;
  hotwordPackages: LocalHotwordPackage[];
  onBrowseModels?: () => void;
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<TranscribeConfig | null>(null);
  const [models, setModels] = useState<SttModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    // Config + model statuses load together; statuses only feed the inline
    // "installed?" hints (download/uninstall lives in the plugin community).
    api.getSttConfig().then((loaded) => {
      if (!active) return;
      setConfig(loaded);
    }).catch((e: unknown) =>
      active && setError(e instanceof Error ? e.message : t("settings.stt_load_failed")),
    );
    api.listSttModels().then((loaded) => {
      if (active) setModels(loaded.models);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, t]);

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      // `per_language` has no UI anymore (task creation never passes a
      // language, so the Rust-side routing can't fire); pass the loaded map
      // through untouched so existing configs are not wiped by a save.
      const next: TranscribeConfig = {
        default: config.default ?? null,
        per_language: config.per_language ?? {},
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
      <div className="rounded-md border bg-muted/30 p-2.5 text-2xs text-muted-foreground">
        {t("settings.stt_loading")}
      </div>
    );
  }

  const defaultConfig: SttProviderConfig = config.default ?? defaultProviderConfig();

  function updateDefault(next: SttProviderConfig) {
    setConfig((current) => (current ? { ...current, default: next } : current));
  }

  function changeDefaultEngine(engine: SttEngine) {
    updateDefault(providerForEngine(engine, defaultConfig));
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-2xs">{t("settings.stt_engine_default")}</Label>
        <select
          value={defaultConfig.provider}
          onChange={(event) => changeDefaultEngine(event.target.value as SttEngine)}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        >
          {VISIBLE_ENGINE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
        <EngineFields config={defaultConfig} hotwordPackages={hotwordPackages} onChange={updateDefault} />
        <ModelStatusHint
          config={defaultConfig}
          models={models}
          onBrowseModels={onBrowseModels}
        />
      </div>

      {error && <p className="mt-2 text-2xs text-destructive">{error}</p>}

      <Button type="button" size="sm" className="mt-1 h-7 text-xs" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
        {t("settings.stt_save_config")}
      </Button>
    </div>
  );
}
