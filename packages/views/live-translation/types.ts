export type LiveAudioSource = "mic" | "system";

export const DEFAULT_ILIVEDATA_RTVT_ENDPOINT =
  "wss://rtvt-cn-app.ilivedata.com/gate/websocket";

export type LiveTranslationProvider = "lynse_backend" | "ilivedata_direct";

export interface LiveTranslationProviderConfig {
  provider: LiveTranslationProvider;
  ilivedata: {
    endpoint: string;
    pid: string;
    secretKey: string;
  };
}

export type LiveTranslationState =
  | "idle"
  | "requesting_permission"
  | "connecting"
  | "recording"
  | "paused"
  | "stopping"
  | "failed";

export interface LiveTranslationSegment {
  id: string;
  sessionId: string;
  epoch: number;
  source: LiveAudioSource;
  recognizedText: string;
  translatedText: string;
  startMs: number;
  endMs?: number;
  isFinal: boolean;
  providerStreamId?: string;
  taskId?: string;
  echoOf?: string;
}

export interface LiveTranslationSnapshot {
  state: LiveTranslationState;
  sessionId?: string;
  epoch: number;
  sourceLanguage?: string;
  targetLanguage?: string;
  startedAt?: string;
  elapsedMs: number;
  micLevel: number;
  systemLevel: number;
  segments: LiveTranslationSegment[];
}

export interface LivePermissionStatus {
  microphone: "granted" | "denied" | "notDetermined";
  systemAudio: "granted" | "denied" | "notDetermined";
  restartRequired: boolean;
}

export interface LiveConnectionDescriptor {
  source: LiveAudioSource;
  url: string;
}

export interface LiveStartRequest {
  sessionId: string;
  title: string;
  sourceLanguage: string;
  targetLanguage: string;
  epoch: number;
  connections: LiveConnectionDescriptor[];
}

export interface LiveResumeRequest {
  sessionId: string;
  epoch: number;
  connections: LiveConnectionDescriptor[];
}

export interface CompletedLiveSession {
  sessionId: string;
  recordId: string;
  playbackPath: string;
  playbackUrl: string;
  transcriptPath: string;
  durationMs: number;
  segments: LiveTranslationSegment[];
}

export interface LiveRecoverySummary {
  sessionId: string;
  title: string;
  startedAt: string;
}

export type LiveTranslationEvent =
  | { type: "state"; snapshot: LiveTranslationSnapshot }
  | { type: "segment"; segment: LiveTranslationSegment }
  | { type: "segments"; segments: LiveTranslationSegment[] }
  | { type: "levels"; mic: number; system: number; elapsedMs: number }
  | { type: "streamState"; source: LiveAudioSource; state: string; epoch: number }
  | { type: "error"; source?: LiveAudioSource; message: string }
  | { type: "completed"; session: CompletedLiveSession };

export interface DesktopLiveTranslationApi {
  getProviderConfig: () => Promise<LiveTranslationProviderConfig>;
  saveProviderConfig: (config: LiveTranslationProviderConfig) => Promise<LiveTranslationProviderConfig>;
  permissions: () => Promise<LivePermissionStatus>;
  requestPermission: (kind: "microphone" | "systemAudio") => Promise<LivePermissionStatus>;
  start: (request: LiveStartRequest) => Promise<LiveTranslationSnapshot>;
  pause: () => Promise<LiveTranslationSnapshot>;
  resume: (request: LiveResumeRequest) => Promise<LiveTranslationSnapshot>;
  stop: () => Promise<CompletedLiveSession>;
  getState: () => Promise<LiveTranslationSnapshot>;
  finalizeLocal: (sessionId: string, synced: boolean) => Promise<void>;
  listRecoveries: () => Promise<LiveRecoverySummary[]>;
  recover: (sessionId: string) => Promise<CompletedLiveSession>;
  showSubtitles: (show: boolean) => Promise<void>;
  onEvent: (callback: (event: LiveTranslationEvent) => void) => Promise<() => void>;
}
