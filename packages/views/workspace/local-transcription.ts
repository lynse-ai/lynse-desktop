import type {
  FileTranscription,
  LocalHotwordPackage,
  LocalTranscriptionOptions,
  LocalTranscriptionSegment,
  LocalTranscriptionRecord,
  LocalVoiceprint,
  WorkspaceItem,
} from "./types";

export type SttEngine = "funasr" | "whisper" | "moss_transcribe_diarize";

export type WhisperModel = "small-q5_1" | "medium-q5_0" | "large-v3-turbo-q5_0";

export const WHISPER_MODELS: WhisperModel[] = ["small-q5_1", "medium-q5_0", "large-v3-turbo-q5_0"];
export const WHISPER_MODEL_LABELS: Record<WhisperModel, string> = {
  "small-q5_1": "Whisper small (q5_1, ~190 MB)",
  "medium-q5_0": "Whisper medium (q5_0, ~539 MB)",
  "large-v3-turbo-q5_0": "Whisper large-v3-turbo (q5_0, ~574 MB)",
};
export const DEFAULT_WHISPER_MODEL: WhisperModel = "large-v3-turbo-q5_0";
export const MOSS_MODEL_ID = "moss-0.9b-q5";
export const FUNASR_MODEL_ID = "funasr-paraformer";

export type SttProviderConfig =
  | { provider: "funasr"; expected_speakers?: number | null; hotword_package_id?: string | null }
  | {
      provider: "whisper";
      model?: WhisperModel;
      campp_diarization?: boolean;
      expected_speakers?: number | null;
      hotword_package_id?: string | null;
    }
  | { provider: "moss_transcribe_diarize"; hotword_package_id?: string | null };

export type TranscribeConfig = {
  default?: SttProviderConfig | null;
  per_language: Record<string, SttProviderConfig>;
};

export const LOCAL_FILE_ID_PREFIX = "local:";
export const LOCAL_TRANSCRIPTION_FOLDER_ID = "__local_transcriptions__";
export const LOCAL_TRANSCRIPTION_TAG = "本地转写";
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
  phase: "downloading" | "verifying" | "done" | "error" | "runtime_downloading" | "runtime_verifying" | "runtime_installing";
  error?: string | null;
}

export interface DesktopLocalTranscriptionApi {
  pickAudioFile: () => Promise<string | null>;
  transcribe: (audioPath: string, options?: LocalTranscriptionOptions) => Promise<LocalTranscriptionRecord>;
  list: () => Promise<LocalTranscriptionRecord[]>;
  get: (id: string) => Promise<LocalTranscriptionRecord | null>;
  retry: (id: string) => Promise<LocalTranscriptionRecord>;
  delete: (id: string) => Promise<void>;
  getAudioUrl: (id: string) => Promise<string | null>;
  listSttModels: () => Promise<{ models: SttModelInfo[] }>;
  downloadSttModel: (provider: SttEngine, modelId: string) => Promise<{ models: SttModelInfo[] }>;
  deleteSttModel: (provider: SttEngine, modelId: string) => Promise<{ models: SttModelInfo[] }>;
  /** Subscribe to `stt-download-progress` events; returns an unlisten fn. */
  onSttDownloadProgress: (callback: (progress: SttDownloadProgress) => void) => Promise<() => void>;
  listHotwordPackages: () => Promise<LocalHotwordPackage[]>;
  saveHotwordPackage: (pkg: LocalHotwordPackage) => Promise<LocalHotwordPackage>;
  deleteHotwordPackage: (id: string) => Promise<void>;
  listVoiceprints: () => Promise<LocalVoiceprint[]>;
  createVoiceprint: (input: { name: string; sampleRecordId: string; sampleSegmentIds: string[] }) => Promise<LocalVoiceprint>;
  updateVoiceprint: (voiceprint: LocalVoiceprint) => Promise<LocalVoiceprint>;
  deleteVoiceprint: (id: string) => Promise<void>;
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
  return {
    id: record.id,
    type: "file",
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    folderId: LOCAL_TRANSCRIPTION_FOLDER_ID,
    tags: [LOCAL_TRANSCRIPTION_TAG, localStatusLabel(record.status)],
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

function localStatusLabel(status: LocalTranscriptionRecord["status"]): string {
  if (status === "queued") return "排队中";
  if (status === "transcribing") return "转写中";
  if (status === "failed") return "失败";
  return "已完成";
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
    ...localRecords.map(localRecordToWorkspaceItem),
    ...cloudFiles,
  ];
}

// ── Provider config resolution & migration ───────────────

/** Coerce legacy/loose shapes into a typed provider config. */
export function migrateSttProviderConfig(value: unknown): SttProviderConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
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
  if (provider === "moss_transcribe_diarize") {
    return {
      provider: "moss_transcribe_diarize",
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
  return { provider: "funasr" };
}

export function providerEngine(config: SttProviderConfig): SttEngine {
  return config.provider;
}

export function providerModelId(config: SttProviderConfig): string {
  switch (config.provider) {
    case "funasr":
      return FUNASR_MODEL_ID;
    case "whisper":
      return config.model ?? DEFAULT_WHISPER_MODEL;
    case "moss_transcribe_diarize":
      return MOSS_MODEL_ID;
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
