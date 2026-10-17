"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Progress } from "@lynse/ui/components/ui/progress";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  type DesktopLocalTranscriptionApi,
  type SttDownloadProgress,
  type SttEngine,
  type SttModelInfo,
  type TranscribeConfig,
  FUNASR_MODEL_ID,
  FUNASR_NANO_MODEL_ID,
  WHISPERX_MODEL_ID,
  VIBEVOICE_MODEL_ID,
  getDesktopLocalTranscriptionApi,
  providerEngine,
  providerModelId,
  NON_MAC_ENGINES,
} from "../workspace/local-transcription";
import { isMacDesktop } from "../layout/use-maximized";
import { definePlugin, registerPlugin } from "./registry";
import type { PluginManifest } from "./types";

/**
 * Offline-transcription model plugins (PRD §5.3②): `kind: "model"` entries
 * mapped onto the Rust `STT_MODELS` catalog. Install = download, uninstall =
 * delete; the engine's runtime (venv/pip/shared binaries) is prepared by the
 * existing download pipeline on first use and is not user-visible.
 *
 * Community lineup (PRD v0.5): FunASR latest + WhisperX latest first, Qwen3
 * both tiers retained, plus the whisper.cpp tiers and VibeVoice-ASR-BitNet.
 * The sidecar engines (whisper on Metal/Vulkan, vibeasr on CPU) ship on both
 * desktop platforms; MOSS waits until quantization/adaptation lands; the
 * vibeasr/mlx tiers stay functional for existing installs but are not listed.
 *
 * Off macOS the catalog is filtered by `NON_MAC_ENGINES`: the three sidecar
 * engines (whisper + vibeasr + funasr), all statically-linked binaries in the
 * shared runtime. FunASR stopped being a Python engine when it moved to the
 * llama.cpp/GGUF runtime, so it now belongs in that set for the same reason
 * whisper does. The MLX-bound engines (Qwen3, MOSS, MLX-Whisper) stay hidden
 * because their backend does not exist off Apple Silicon; WhisperX is hidden
 * until its venv bootstrap learns the Windows interpreter layout.
 */

export interface TranscriptionModelEntry {
  pluginId: string;
  engine: SttEngine;
  modelId: string;
  nameKey: string;
  descriptionKey: string;
  badges: Array<"recommended" | "diarization" | "voiceprint">;
}

export const TRANSCRIPTION_MODEL_CATALOG: TranscriptionModelEntry[] = [
  {
    pluginId: "lynse.model.funasr-sensevoice",
    engine: "funasr",
    modelId: FUNASR_MODEL_ID,
    nameKey: "plugins.models.funasr.name",
    descriptionKey: "plugins.models.funasr.description",
    badges: ["recommended"],
  },
  {
    pluginId: "lynse.model.funasr-nano",
    engine: "funasr",
    modelId: FUNASR_NANO_MODEL_ID,
    nameKey: "plugins.models.funasrNano.name",
    descriptionKey: "plugins.models.funasrNano.description",
    badges: [],
  },
  {
    pluginId: "lynse.model.whisperx-latest",
    engine: "whisperx",
    modelId: WHISPERX_MODEL_ID,
    nameKey: "plugins.models.whisperx.name",
    descriptionKey: "plugins.models.whisperx.description",
    badges: ["recommended", "diarization"],
  },
  {
    pluginId: "lynse.model.qwen3-asr-1.7b-8bit",
    engine: "qwen3",
    modelId: "qwen3-asr-1.7b-8bit",
    nameKey: "plugins.models.qwen3Large.name",
    descriptionKey: "plugins.models.qwen3Large.description",
    badges: [],
  },
  {
    pluginId: "lynse.model.qwen3-asr-0.6b-4bit",
    engine: "qwen3",
    modelId: "qwen3-asr-0.6b-4bit",
    nameKey: "plugins.models.qwen3Small.name",
    descriptionKey: "plugins.models.qwen3Small.description",
    badges: [],
  },
  {
    pluginId: "lynse.model.vibevoice-bitnet-1.5b",
    engine: "vibeasr",
    modelId: VIBEVOICE_MODEL_ID,
    nameKey: "plugins.models.vibevoice.name",
    descriptionKey: "plugins.models.vibevoice.description",
    badges: ["recommended"],
  },
  {
    pluginId: "lynse.model.whisper-large-v3-turbo-q5_0",
    engine: "whisper",
    modelId: "large-v3-turbo-q5_0",
    nameKey: "plugins.models.whisperTurbo.name",
    descriptionKey: "plugins.models.whisperTurbo.description",
    badges: ["recommended"],
  },
  {
    pluginId: "lynse.model.whisper-medium-q5_0",
    engine: "whisper",
    modelId: "medium-q5_0",
    nameKey: "plugins.models.whisperMedium.name",
    descriptionKey: "plugins.models.whisperMedium.description",
    badges: [],
  },
  {
    pluginId: "lynse.model.whisper-small-q5_1",
    engine: "whisper",
    modelId: "small-q5_1",
    nameKey: "plugins.models.whisperSmall.name",
    descriptionKey: "plugins.models.whisperSmall.description",
    badges: [],
  },
];

/** The shared-runtime phases that precede a model download, keyed to the label
 *  each one shows. Rust reports them under the card the user clicked so the
 *  runtime and the model read as one flow — without these, verify + install
 *  look like a download stuck at 100%. */
const RUNTIME_PHASE_LABELS: Partial<Record<SttDownloadProgress["phase"], string>> = {
  runtime_downloading: "settings.stt_status_runtime_downloading",
  runtime_verifying: "settings.stt_status_runtime_verifying",
  runtime_installing: "settings.stt_status_runtime_installing",
};

/** Model cards listed on this desktop, filtered by the shared `NON_MAC_ENGINES`
 *  set so the engine list in settings and the cards here can no longer drift
 *  apart. Resolved at render time (not module scope) so tests can flip the
 *  platform. */
function visibleModelCatalog(): TranscriptionModelEntry[] {
  return isMacDesktop
    ? TRANSCRIPTION_MODEL_CATALOG
    : TRANSCRIPTION_MODEL_CATALOG.filter((entry) => NON_MAC_ENGINES.has(entry.engine));
}

function modelManifest(entry: TranscriptionModelEntry): PluginManifest {
  return definePlugin({
    id: entry.pluginId,
    kind: "model",
    version: "1.0.0",
    minAppVersion: "1.0.4",
    nameKey: entry.nameKey,
    descriptionKey: entry.descriptionKey,
    icon: (() => null) as unknown as PluginManifest["icon"],
    category: "transcription",
    platforms: ["desktop"],
    permissions: ["storage:plugin-scope"],
    availability: () => !!getDesktopLocalTranscriptionApi(),
    // A model counts as installed when its files are on disk — the download
    // pipeline owns everything else (runtime, verification).
    migrate: async () => {
      const api = getDesktopLocalTranscriptionApi();
      if (!api) return false;
      try {
        const { models } = await api.listSttModels();
        return models.some(
          (model) =>
            model.provider === entry.engine &&
            model.id === entry.modelId &&
            model.status === "installed",
        );
      } catch {
        return false;
      }
    },
  });
}

/** Register the catalog as community-listable model plugins. */
export function registerTranscriptionModelPlugins(): void {
  for (const entry of TRANSCRIPTION_MODEL_CATALOG) {
    registerPlugin(modelManifest(entry));
  }
}

/** Whether a saved TranscribeConfig still routes to this model (default or
 *  any per-language override) — the uninstall-protection check. */
function isModelReferenced(
  config: TranscribeConfig,
  engine: SttEngine,
  modelId: string,
): boolean {
  const references = [config.default, ...Object.values(config.per_language ?? {})];
  return references.some(
    (providerConfig) =>
      !!providerConfig &&
      providerEngine(providerConfig) === engine &&
      providerModelId(providerConfig) === modelId,
  );
}

const BADGE_LABEL_KEYS: Record<TranscriptionModelEntry["badges"][number], string> = {
  recommended: "plugins.models.badge_recommended",
  diarization: "plugins.models.badge_diarization",
  voiceprint: "plugins.models.badge_voiceprint",
};

/** Human-readable download byte counts: GiB for model-scale artifacts,
 * MB for the smaller whisper tiers. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * The 转写模型 category of the plugin community: download / delete offline
 * models with live progress and the two-reference uninstall guard (default
 * engine + per_language routing, PRD §5.3②).
 */
export function TranscriptionModelsSection({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const api: DesktopLocalTranscriptionApi | null = getDesktopLocalTranscriptionApi();
  const [models, setModels] = useState<SttModelInfo[]>([]);
  const [progress, setProgress] = useState<SttDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    api
      .listSttModels()
      .then((loaded) => {
        if (!cancelled) setModels(loaded.models);
      })
      .catch(() => undefined);
    api
      .onSttDownloadProgress((event) => {
        setProgress(event);
        // Snapshot the settled result into the list so statuses stay honest
        // between the command's own return and the next manual refresh.
        if (event.phase === "done" || event.phase === "error") {
          api
            .listSttModels()
            .then((loaded) => {
              if (!cancelled) setModels(loaded.models);
            })
            .catch(() => undefined);
        }
      })
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [api]);

  if (!api) return null;

  // Arrow consts (not hoisted declarations) so the `api` narrowing above
  // holds inside the closures.
  const handleDownload = async (entry: TranscriptionModelEntry) => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const loaded = await api.downloadSttModel(entry.engine, entry.modelId);
      setModels(loaded.models);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const handleDelete = async (entry: TranscriptionModelEntry) => {
    if (confirmingId !== entry.pluginId) {
      setConfirmingId(entry.pluginId);
      return;
    }
    setConfirmingId(null);
    // Uninstall protection (PRD §5.3②): block while the default engine or a
    // per-language routing rule still points at this model.
    try {
      const config = await api.getSttConfig();
      if (isModelReferenced(config, entry.engine, entry.modelId)) {
        toast.error(t("plugins.models.uninstall_blocked"));
        return;
      }
    } catch {
      // Config unavailable — fall through to the plain delete path.
    }
    setBusy(true);
    setError(null);
    try {
      const loaded = await api.deleteSttModel(entry.engine, entry.modelId);
      setModels(loaded.models);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("plugins.models.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t("plugins.models.hint")}
        </p>
        {visibleModelCatalog().map((entry) => {
          const model = models.find(
            (candidate) => candidate.provider === entry.engine && candidate.id === entry.modelId,
          );
          const installed = model?.status === "installed";
          const isThisDownloading =
            !!progress &&
            progress.provider === entry.engine &&
            progress.modelId === entry.modelId &&
            progress.phase !== "error" &&
            progress.phase !== "done";
          const busyHere = busy || isThisDownloading;
          const percent = isThisDownloading && progress ? progress.percent : null;
          const bytesLabel =
            isThisDownloading && progress && progress.totalBytes > 0
              ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
              : null;
          return (
            <div key={entry.pluginId} className="flex items-start gap-3 rounded-md border bg-background p-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{t(entry.nameKey)}</span>
                  {entry.badges.map((badge) => (
                    <span
                      key={badge}
                      className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground"
                    >
                      {t(BADGE_LABEL_KEYS[badge])}
                    </span>
                  ))}
                  <span
                    className={
                      installed
                        ? "rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary"
                        : "rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground"
                    }
                  >
                    {installed
                      ? t("settings.stt_status_installed")
                      : t("settings.stt_status_not_installed")}
                  </span>
                </div>
                <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                  {t(entry.descriptionKey)}
                </p>
                {isThisDownloading && (
                  <div className="mt-1.5">
                    {/* Indeterminate (null percent) pulses until the first
                        real progress tick from the download pipeline. */}
                    <Progress
                      value={percent ?? 0}
                      className={cn("h-1.5", percent === null && "animate-pulse")}
                    />
                    <p className="mt-1 text-2xs text-muted-foreground">
                      {t("settings.stt_status_downloading")}
                      {percent !== null ? ` · ${Math.round(percent)}%` : ""}
                      {bytesLabel ? ` · ${bytesLabel}` : ""}
                    </p>
                  </div>
                )}
                {isThisDownloading && RUNTIME_PHASE_LABELS[progress.phase] && (
                  <p className="text-2xs text-muted-foreground">
                    {t(RUNTIME_PHASE_LABELS[progress.phase]!)}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busyHere || installed}
                    onClick={() => void handleDownload(entry)}
                  >
                    {t("settings.stt_download_model")}
                  </Button>
                  <Button
                    size="sm"
                    variant={confirmingId === entry.pluginId ? "destructive" : "ghost"}
                    className="h-7 text-xs"
                    disabled={busyHere || !installed}
                    onBlur={() => setConfirmingId((current) => (current === entry.pluginId ? null : current))}
                    onClick={() => void handleDelete(entry)}
                  >
                    {confirmingId === entry.pluginId
                      ? t("plugins.action.uninstall_confirm")
                      : t("settings.stt_delete_model")}
                  </Button>
                  {onOpenSettings && installed && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={onOpenSettings}
                    >
                      {t("plugins.action.settings")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {error && <p className="text-2xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
