import type {
  FileTranscription,
  LocalHotwordPackage,
  LocalTranscriptionOptions,
  LocalTranscriptionSegment,
  LocalTranscriptionRecord,
  LocalTranscriptionStatus,
  LocalVoiceprint,
  WorkspaceItem,
} from "./types";

export type SttEngine = "qwen3" | "funasr" | "whisper" | "whisperx" | "vibeasr" | "mlx" | "moss" | "sherpa";

/** Engines selectable outside macOS. Defined once because the engine list and
 *  the model cards must agree — they used to each keep a private copy of this
 *  set, which is how an engine that works came to stay hidden.
 *
 *  `whisper` + `vibeasr` are sidecar binaries shipped in the shared runtime.
 *  `funasr` runs in its own pip venv, bootstrapped on first use with a
 *  Windows-aware interpreter layout and CPU torch wheels, so it is no longer
 *  the hard-erroring engine it used to be off macOS. MLX-family engines stay
 *  Apple-only by definition (their backend is MLX). */
export const NON_MAC_ENGINES: ReadonlySet<SttEngine> = new Set([
  "whisper",
  "vibeasr",
  "funasr",
]);

export type WhisperModel = "small-q5_1" | "medium-q5_0" | "large-v3-turbo-q5_0";

export const WHISPER_MODELS: WhisperModel[] = ["small-q5_1", "medium-q5_0", "large-v3-turbo-q5_0"];
export const WHISPER_MODEL_LABELS: Record<WhisperModel, string> = {
  "small-q5_1": "Whisper small (q5_1, ~190 MB)",
  "medium-q5_0": "Whisper medium (q5_0, ~539 MB)",
  "large-v3-turbo-q5_0": "Whisper large-v3-turbo (q5_0, ~574 MB)",
};
export const DEFAULT_WHISPER_MODEL: WhisperModel = "large-v3-turbo-q5_0";
export const VIBEVOICE_MODEL_ID = "vibeasr-bitnet-1.5b";
export const FUNASR_MODEL_ID = "funasr-paraformer";

/** WhisperX catalog ids (must mirror the Rust `STT_MODELS`). First cut runs
 * transcription + word alignment; diarization ships once the pyannote model
 * distribution is settled (PRD §12 Q7). */
export type WhisperXModel = "whisperx-latest";
export const WHISPERX_MODEL_ID: WhisperXModel = "whisperx-latest";

/** Qwen3-ASR model catalog ids (must mirror the Rust `STT_MODELS`). */
export type Qwen3Model = "qwen3-asr-1.7b-8bit" | "qwen3-asr-0.6b-4bit";
export const QWEN3_MODELS: Qwen3Model[] = ["qwen3-asr-1.7b-8bit", "qwen3-asr-0.6b-4bit"];
export const QWEN3_MODEL_LABELS: Record<Qwen3Model, string> = {
  "qwen3-asr-1.7b-8bit": "Qwen3-ASR 1.7B（MLX 8-bit，推荐，~2 GiB）",
  "qwen3-asr-0.6b-4bit": "Qwen3-ASR 0.6B（MLX 4-bit，极速，~0.6 GiB）",
};
export const DEFAULT_QWEN3_MODEL: Qwen3Model = "qwen3-asr-1.7b-8bit";

/** MOSS-Transcribe-Diarize catalog ids (must mirror the Rust `STT_MODELS`). */
export type MossModel = "moss-transcribe-8bit";
export const MOSS_MODELS: MossModel[] = ["moss-transcribe-8bit"];
export const MOSS_MODEL_LABELS: Record<MossModel, string> = {
  "moss-transcribe-8bit": "MOSS-Transcribe-Diarize 0.9B（说话人分离，MLX 8-bit，~1.1 GiB）",
};
export const DEFAULT_MOSS_MODEL: MossModel = "moss-transcribe-8bit";

export type SttProviderConfig =
  | { provider: "qwen3"; model?: Qwen3Model | string; hotword_package_id?: string | null }
  | { provider: "funasr"; expected_speakers?: number | null; hotword_package_id?: string | null }
  | { provider: "whisperx"; expected_speakers?: number | null; hotword_package_id?: string | null }
  | {
      provider: "whisper";
      model?: WhisperModel;
      campp_diarization?: boolean;
      expected_speakers?: number | null;
      hotword_package_id?: string | null;
    }
  | { provider: "vibeasr"; hotword_package_id?: string | null }
  | { provider: "mlx"; model?: string; hotword_package_id?: string | null }
  | { provider: "moss"; model?: MossModel | string; hotword_package_id?: string | null };

export type TranscribeConfig = {
  default?: SttProviderConfig | null;
  per_language: Record<string, SttProviderConfig>;
};

export const LOCAL_FILE_ID_PREFIX = "local:";
export const LOCAL_TRANSCRIPTION_FOLDER_ID = "__local_transcriptions__";
export const OFFLINE_TRANSCRIPTION_ENABLED_KEY = "lynse_offline_transcription_enabled";
export const OFFLINE_TRANSCRIPTION_DEFAULT_OFF = true;

export interface SttModelInfo {
  provider: SttEngine;
  id: string;
  label: string;
  sizeBytes: number;
  status: "installed" | "not_installed" | "downloading";
  modelDir: string;
}

/** Real-time progress of an offline STT model download, streamed from the
 *  Rust side via the `stt-download-progress` event. */
export interface SttDownloadProgress {
  provider: SttEngine;
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  /** 0–100, or null when the total size is unknown (e.g. FunASR). */
  percent: number | null;
  /** `preparing` is emitted right after the click, before file sizes are
   *  probed, so the UI never looks frozen during the HEAD requests. */
  phase:
    | "preparing"
    | "downloading"
    | "verifying"
    | "done"
    | "error"
    | "runtime_downloading"
    | "runtime_verifying"
    | "runtime_installing";
  error?: string | null;
}

/** A local transcription lifecycle transition, streamed from Rust on
 *  `local-transcription-updated`. A backgrounded job has no promise to await, so
 *  this is what tells the notes list to refetch. */
export interface LocalTranscriptionUpdate {
  id: string;
  /** Recording title, so a job that finishes after the dialog closed still
   *  names itself in the completion / failure notification. */
  title: string;
  status: "transcribing" | "completed" | "failed";
  error?: string | null;
}

export interface DesktopLocalTranscriptionApi {
  pickAudioFile: () => Promise<string | null>;
  transcribe: (audioPath: string, options?: LocalTranscriptionOptions) => Promise<LocalTranscriptionRecord>;
  /** Queue + start a transcription and return the queued record at once; the
   *  engine runs in the background and reports through `onTranscriptionUpdate`. */
  start: (audioPath: string, options?: LocalTranscriptionOptions) => Promise<LocalTranscriptionRecord>;
  list: () => Promise<LocalTranscriptionRecord[]>;
  get: (id: string) => Promise<LocalTranscriptionRecord | null>;
  retry: (id: string, options?: { track?: "mic" | "system" }) => Promise<unknown>;
  /** Audio URL for one track file of a dual-channel recording. */
  getTrackAudioUrl: (id: string, file: string) => Promise<string>;
  delete: (id: string) => Promise<void>;
  getAudioUrl: (id: string) => Promise<string | null>;
  listSttModels: () => Promise<{ models: SttModelInfo[] }>;
  downloadSttModel: (provider: SttEngine, modelId: string) => Promise<{ models: SttModelInfo[] }>;
  deleteSttModel: (provider: SttEngine, modelId: string) => Promise<{ models: SttModelInfo[] }>;
  /** Subscribe to `stt-download-progress` events; returns an unlisten fn. */
  onSttDownloadProgress: (callback: (progress: SttDownloadProgress) => void) => Promise<() => void>;
  /** Subscribe to `local-transcription-updated` events; returns an unlisten fn. */
  onTranscriptionUpdate: (callback: (update: LocalTranscriptionUpdate) => void) => Promise<() => void>;
  listHotwordPackages: () => Promise<LocalHotwordPackage[]>;
  saveHotwordPackage: (pkg: LocalHotwordPackage) => Promise<LocalHotwordPackage>;
  deleteHotwordPackage: (id: string) => Promise<void>;
  listVoiceprints: () => Promise<LocalVoiceprint[]>;
  createVoiceprint: (input: { name: string; sampleRecordId: string; sampleSegmentIds: string[] }) => Promise<LocalVoiceprint>;
  updateVoiceprint: (voiceprint: LocalVoiceprint) => Promise<LocalVoiceprint>;
  deleteVoiceprint: (id: string) => Promise<void>;
  /** Which embedding backend new voiceprints would use ("3dspeaker" | null). */
  getVoiceprintBackendStatus: () => Promise<{
    backend: string | null;
    modelInstalled: boolean;
  }>;
  getSttConfig: () => Promise<TranscribeConfig>;
  saveSttConfig: (config: TranscribeConfig) => Promise<TranscribeConfig>;
}

export function getDesktopLocalTranscriptionApi(): DesktopLocalTranscriptionApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { localTranscription?: DesktopLocalTranscriptionApi };
  };
  return desktopWindow.desktopAPI?.localTranscription ?? null;
}

export function isLocalFileId(fileId: string | null | undefined): boolean {
  return typeof fileId === "string" && fileId.startsWith(LOCAL_FILE_ID_PREFIX);
}

export function localRecordToWorkspaceItem(record: LocalTranscriptionRecord): WorkspaceItem {
  // Legacy pure recordings were persisted as `completed` with an empty
  // transcript; normalize them so the UI never badges audio-only records as
  // transcribed (the store itself is not migrated).
  const status: LocalTranscriptionStatus =
    record.status === "completed" && !record.transcriptText.trim() ? "recorded" : record.status;
  return {
    id: record.id,
    type: "file",
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    folderId: LOCAL_TRANSCRIPTION_FOLDER_ID,
    // Cards identify local recordings via `isLocalFileId` (badge), not via a
    // tag; the status lives here for the detail panel's progress pill.
    localStatus: status,
    transcriptionCompleted: status === "completed",
    ...(record.durationMs !== undefined ? { durationSeconds: record.durationMs / 1000 } : {}),
  };
}

export function localRecordToTranscription(record: LocalTranscriptionRecord): FileTranscription {
  const transcriptText = cleanLocalTranscriptText(record.transcriptText);
  const segments = record.segments.length > 0
    ? record.segments
    : emptyLocalSegmentsFromText(transcriptText);

  return {
    id: record.id,
    fileId: record.id,
    taskId: `local-${record.engine}`,
    content: transcriptText,
    // Dual-channel metadata surfaces in the detail panel (per-track
    // listening, degraded banner, targeted retries).
    trackManifest: record.trackManifest,
    aecDegraded: record.aecDegraded,
    trackStatuses: record.trackStatuses,
    liveSessionId: record.liveSessionId,
    records: segments.map((segment) => ({
      id: segment.id,
      speakerName: normalizeLocalSpeakerName(segment.speakerName ?? segment.speaker, segment.rawSpeaker),
      beginTimeStr: formatLocalTimestamp(segment.startMs ?? 0),
      beginTime: segment.startMs,
      endTime: segment.endMs,
      text: cleanLocalTranscriptText(segment.text),
      translatedText: segment.translatedText ? cleanLocalTranscriptText(segment.translatedText) : undefined,
      source: segment.source,
    })),
  };
}

export function emptyLocalSegmentsFromText(text: string): LocalTranscriptionSegment[] {
  const trimmed = cleanLocalTranscriptText(text);
  if (!trimmed) return [];
  return [{ id: "seg-1", text: trimmed, startMs: 0, speakerId: "spk-1", speakerName: "发言人1" }];
}

function cleanLocalTranscriptText(text: string): string {
  return text
    .replace(/<\|[^|>]+\|>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocalSpeakerName(speaker: string | undefined, rawSpeaker?: string): string {
  if (!speaker) return "发言人1";
  const match = speaker.match(/^speaker\s*(\d+)$/i);
  if (match?.[1]) return `发言人${match[1]}`;
  if (speaker === rawSpeaker && rawSpeaker) return `发言人${rawSpeaker}`;
  return speaker;
}

function formatLocalTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function mergeCloudAndLocalFiles(
  cloudFiles: WorkspaceItem[],
  localRecords: LocalTranscriptionRecord[],
): WorkspaceItem[] {
  return [
    // Records already synced to the cloud are represented by their cloud
    // counterpart — hide the local copy to avoid showing duplicates.
    ...localRecords
      .filter((record) => record.syncStatus !== "synced")
      .map(localRecordToWorkspaceItem),
    ...cloudFiles,
  ];
}

// ── Provider config resolution & migration ───────────────

/** Coerce legacy/loose shapes into a typed provider config. */
export function migrateSttProviderConfig(value: unknown): SttProviderConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (provider === "qwen3") {
    return {
      provider: "qwen3",
      model: (record.model as Qwen3Model | string | undefined) ?? DEFAULT_QWEN3_MODEL,
      hotword_package_id: (record.hotword_package_id as string | null | undefined) ?? null,
    };
  }
  if (provider === "whisper") {
    const model = (record.model as WhisperModel) ?? DEFAULT_WHISPER_MODEL;
    return {
      provider: "whisper",
      model,
      campp_diarization: Boolean(record.campp_diarization),
      expected_speakers: (record.expected_speakers as number | null | undefined) ?? null,
      hotword_package_id: (record.hotword_package_id as string | null | undefined) ?? null,
    };
  }
  if (provider === "vibeasr") {
    return {
      provider: "vibeasr",
      hotword_package_id: (record.hotword_package_id as string | null | undefined) ?? null,
    };
  }
  if (provider === "mlx") {
    return {
      provider: "mlx",
      model: (record.model as string | undefined) ?? "whisper-large-v3-turbo",
      hotword_package_id: (record.hotword_package_id as string | null | undefined) ?? null,
    };
  }
  if (provider === "moss") {
    return {
      provider: "moss",
      model: (record.model as MossModel | string | undefined) ?? DEFAULT_MOSS_MODEL,
      hotword_package_id: (record.hotword_package_id as string | null | undefined) ?? null,
    };
  }
  if (provider === "whisperx") {
    return {
      provider: "whisperx",
      expected_speakers: (record.expected_speakers as number | null | undefined) ?? null,
      hotword_package_id: (record.hotword_package_id as string | null | undefined) ?? null,
    };
  }
  // Legacy: a bare funasr object (or a config without a `provider` tag) maps to FunASR.
  return {
    provider: "funasr",
    expected_speakers: (record.expected_speakers as number | null | undefined) ?? null,
    hotword_package_id: (record.hotword_package_id as string | null | undefined) ?? null,
  };
}

/** Resolve the effective provider, mirroring the Rust `TranscribeConfig::resolve`. */
export function resolveSttProvider(
  config: TranscribeConfig,
  language: string | null | undefined,
  perNote?: SttProviderConfig | null,
): SttProviderConfig {
  const fromNote = perNote ? migrateSttProviderConfig(perNote) : null;
  if (fromNote) return fromNote;
  if (language && config.per_language[language]) {
    const migrated = migrateSttProviderConfig(config.per_language[language]);
    if (migrated) return migrated;
  }
  if (config.default) {
    const migrated = migrateSttProviderConfig(config.default);
    if (migrated) return migrated;
  }
  return { provider: "qwen3", model: DEFAULT_QWEN3_MODEL };
}

export function providerEngine(config: SttProviderConfig): SttEngine {
  return config.provider;
}

export function providerModelId(config: SttProviderConfig): string {
  switch (config.provider) {
    case "qwen3":
      return config.model ?? DEFAULT_QWEN3_MODEL;
    case "funasr":
      return FUNASR_MODEL_ID;
    case "whisperx":
      return WHISPERX_MODEL_ID;
    case "whisper":
      return config.model ?? DEFAULT_WHISPER_MODEL;
    case "vibeasr":
      return VIBEVOICE_MODEL_ID;
    case "mlx":
      return config.model ?? "whisper-large-v3-turbo";
    case "moss":
      return config.model ?? DEFAULT_MOSS_MODEL;
  }
}

/** Find the install status of the model backing a given provider config. */
export function findModelStatus(
  models: SttModelInfo[],
  config: SttProviderConfig,
): SttModelInfo | undefined {
  const engine = providerEngine(config);
  const modelId = providerModelId(config);
  return models.find((model) => model.provider === engine && model.id === modelId);
}
