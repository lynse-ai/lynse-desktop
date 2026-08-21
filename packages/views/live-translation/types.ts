export type LiveAudioSource = "mic" | "system";

export const DEFAULT_ILIVEDATA_RTVT_ENDPOINT =
  "wss://rtvt-cn-app.ilivedata.com/gate/websocket";

export type LiveTranslationProvider =
  | "lynse_backend"
  | "ilivedata_direct"
  | "qwen"
  | "volc";

export interface LiveTranslationProviderConfig {
  provider: LiveTranslationProvider;
  ilivedata: {
    endpoint: string;
    pid: string;
    secretKey: string;
  };
  qwen: {
    apiKey: string;
    endpoint: string;
  };
  volc: {
    /** 火山引擎控制台获取的 API Key，作为 X-Api-Key 发送。 */
    apiKey: string;
    endpoint: string;
  };
}

export const DEFAULT_QWEN_ENDPOINT =
  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime";

export const DEFAULT_VOLC_AST_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";

export type LiveTranslationState =
  | "idle"
  | "requesting_permission"
  | "connecting"
  | "recording"
  | "paused"
  | "stopping"
  | "failed";

export type LiveTranslationTrayAction = "start" | "pause" | "stop";

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
  /** 1-based speaker index from Volcengine AST `spk_chg` (undefined for providers without diarization). */
  speaker?: number;
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
  systemAudioRequired: boolean;
  restartRequired: boolean;
}

export interface LiveConnectionDescriptor {
  source: LiveAudioSource;
  url: string;
  provider?: LiveTranslationProvider;
  apiKey?: string;
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

/** Reconfigure a running session: switch between pure recording and live
 * transcription/translation without interrupting the audio capture. */
export interface LiveSetModeRequest {
  sessionId: string;
  sourceLanguage: string;
  targetLanguage: string;
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
  setMode: (request: LiveSetModeRequest) => Promise<LiveTranslationSnapshot>;
  stop: () => Promise<CompletedLiveSession>;
  getState: () => Promise<LiveTranslationSnapshot>;
  finalizeLocal: (sessionId: string, synced: boolean) => Promise<void>;
  listRecoveries: () => Promise<LiveRecoverySummary[]>;
  recover: (sessionId: string) => Promise<CompletedLiveSession>;
  showSubtitles: (show: boolean) => Promise<void>;
  minimizeToTray: () => Promise<void>;
  showMainWindow: () => Promise<void>;
  /** Hide the recording-island mini window (recording keeps running). */
  hideIsland: () => Promise<void>;
  updateTray: (payload: { recording: boolean; paused: boolean; elapsed_secs?: number }) => Promise<void>;
  onTrayAction: (callback: (action: LiveTranslationTrayAction) => void) => Promise<() => void>;
  onEvent: (callback: (event: LiveTranslationEvent) => void) => Promise<() => void>;
}
