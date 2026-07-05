import type { ElectronAPI } from "@electron-toolkit/preload";

interface LocalTranscriptionSegment {
  id: string;
  text: string;
  startMs?: number;
  endMs?: number;
  speakerId?: string;
  speakerName?: string;
  rawSpeaker?: string;
  confidence?: number;
  voiceprintId?: string;
  speaker?: string;
}

type LocalTranscriptionStatus = "queued" | "transcribing" | "completed" | "failed";

interface LocalTranscriptionRecord {
  id: string;
  title: string;
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
  transcriptText: string;
  status: LocalTranscriptionStatus;
  progressPhase?: LocalTranscriptionStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  expectedSpeakers?: number;
  hotwordPackageId?: string;
  engine: "funasr";
  segments: LocalTranscriptionSegment[];
  error?: string;
}

interface LocalTranscriptionOptions {
  expectedSpeakers?: number;
  hotwordPackageId?: string;
}

interface LocalHotwordTerm {
  term: string;
  replacement?: string;
  enabled: boolean;
  weight?: number;
}

interface LocalHotwordPackage {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  terms: LocalHotwordTerm[];
}

interface LocalVoiceprint {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sampleRecordId: string;
  sampleSegmentIds: string[];
  embedding: number[];
  sampleText?: string;
}

interface LocalAsrModelStatus {
  status: "not_installed" | "installed" | "downloading";
  modelDir: string;
  modelName: string;
}

interface DesktopAPI {
  openExternal: (url: string) => Promise<void>;
  localTranscription: {
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
  };
  appInfo: {
    version: string;
    platform: string;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
    desktopAPI: DesktopAPI;
  }
}
