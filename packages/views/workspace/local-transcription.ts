import type {
  FileTranscription,
  LocalHotwordPackage,
  LocalTranscriptionOptions,
  LocalTranscriptionSegment,
  LocalTranscriptionRecord,
  LocalVoiceprint,
  WorkspaceItem,
} from "./types";

export const LOCAL_FILE_ID_PREFIX = "local:";
export const LOCAL_TRANSCRIPTION_FOLDER_ID = "__local_transcriptions__";
export const LOCAL_TRANSCRIPTION_TAG = "本地转写";
export const OFFLINE_TRANSCRIPTION_ENABLED_KEY = "lynse_offline_transcription_enabled";

export interface LocalAsrModelStatus {
  status: "not_installed" | "installed" | "downloading";
  modelDir: string;
  modelName: string;
}

export interface DesktopLocalTranscriptionApi {
  pickAudioFile: () => Promise<string | null>;
  transcribe: (audioPath: string, options?: LocalTranscriptionOptions) => Promise<LocalTranscriptionRecord>;
  list: () => Promise<LocalTranscriptionRecord[]>;
  get: (id: string) => Promise<LocalTranscriptionRecord | null>;
  retry: (id: string) => Promise<LocalTranscriptionRecord>;
  delete: (id: string) => Promise<void>;
  getAudioUrl: (id: string) => Promise<string | null>;
  getModelStatus: () => Promise<LocalAsrModelStatus>;
  downloadModel: () => Promise<LocalAsrModelStatus>;
  deleteModel: () => Promise<LocalAsrModelStatus>;
  listHotwordPackages: () => Promise<LocalHotwordPackage[]>;
  saveHotwordPackage: (pkg: LocalHotwordPackage) => Promise<LocalHotwordPackage>;
  deleteHotwordPackage: (id: string) => Promise<void>;
  listVoiceprints: () => Promise<LocalVoiceprint[]>;
  createVoiceprint: (input: { name: string; sampleRecordId: string; sampleSegmentIds: string[] }) => Promise<LocalVoiceprint>;
  updateVoiceprint: (voiceprint: LocalVoiceprint) => Promise<LocalVoiceprint>;
  deleteVoiceprint: (id: string) => Promise<void>;
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
    taskId: "local-funasr",
    content: transcriptText,
    records: segments.map((segment) => ({
      id: segment.id,
      speakerName: normalizeLocalSpeakerName(segment.speakerName ?? segment.speaker, segment.rawSpeaker),
      beginTimeStr: formatLocalTimestamp(segment.startMs ?? 0),
      beginTime: segment.startMs,
      endTime: segment.endMs,
      text: cleanLocalTranscriptText(segment.text),
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
