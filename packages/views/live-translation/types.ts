export type LiveAudioSource = "mic" | "system";

export const DEFAULT_ILIVEDATA_RTVT_ENDPOINT =
  "wss://rtvt-cn-app.ilivedata.com/gate/websocket";

export type LiveTranslationProvider =
  | "lynse_backend"
  | "ilivedata_direct"
  | "qwen"
  | "volc"
  | "tencent";

/** Which capture streams the sidecar records. "both" keeps the legacy
 * dual-stream behaviour; "system" is the transcribe-a-playing-video case
 * (the mic would only duplicate the video audio as echo). */
export type LiveAudioSourceMode = "both" | "mic" | "system";

export interface LiveTranslationProviderConfig {
  provider: LiveTranslationProvider;
  /** Capture-source mode; persisted alongside the provider credentials so
   * the start request and the connection builder read the same setting. */
  audioSource?: LiveAudioSourceMode;
  ilivedata: {
    endpoint: string;
    pid: string;
    secretKey: string;
    /**
     * Maximum speaker count for iLiveData RTVT diarization.
     * `0` (or undefined) disables speaker recognition entirely; when enabled
     * the valid range is 2..5 (the API requires a value greater than 1).
     */
    maxSpeakers?: number;
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
  tencent: {
    /** 腾讯云账号 AppID（拼接在 WebSocket 路径末尾）。 */
    appId: string;
    /** 腾讯云访问密钥 SecretId / SecretKey（控制台「访问管理 → API 密钥」）。 */
    secretId: string;
    secretKey: string;
    /** 识别引擎类型，如 16k_zh / 16k_en / 16k_ja / 16k_zh-PY；留空按源语言推导。 */
    engineType: string;
    endpoint: string;
  };
}

export const DEFAULT_QWEN_ENDPOINT =
  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime";

export const DEFAULT_VOLC_AST_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";

export const DEFAULT_TENCENT_ASR_ENDPOINT =
  "wss://asr.cloud.tencent.com/asr/v2";

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
  /** Provider-specific credentials that don't fit the single-key model.
   * Tencent ASR carries secretId/secretKey/engineType here so the Rust
   * connection loop can re-sign the URL on every (re)connect. */
  extra?: Record<string, string>;
}

export interface LiveStartRequest {
  sessionId: string;
  title: string;
  sourceLanguage: string;
  targetLanguage: string;
  epoch: number;
  connections: LiveConnectionDescriptor[];
  /** Capture sources for the sidecar; omitted/empty means both. */
  audioSources?: LiveAudioSource[];
  /** Windows: pin the microphone to this WASAPI endpoint id (stable device
   * identity, never just the name). Omitted follows the OS default. */
  micDeviceId?: string;
  /** Windows: pin the system mixdown to this render endpoint id. Omitted
   * follows the OS default. */
  systemDeviceId?: string;
  /** Speech enhancement on the microphone path (noise suppression + high-pass).
   * A capture-time decision: it applies to the recording that is about to
   * start, never retroactively. Raw tracks are archived unprocessed either way. */
  voiceEnhancement?: boolean;
}

/** One selectable WASAPI endpoint, as surfaced by the device pickers. */
export interface AudioDeviceOption {
  id: string;
  name: string;
  isDefault: boolean;
  /** Default communications endpoint — what conferencing apps pick. */
  isDefaultCommunications: boolean;
}

export interface AudioDevicesSnapshot {
  inputs: AudioDeviceOption[];
  outputs: AudioDeviceOption[];
  defaultInput?: string | null;
  defaultOutput?: string | null;
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
  /** Set when the silence watchdog (60s without mic voice) ended the session. */
  autoStoppedSilence?: boolean;
  /** Dual-channel track manifest; absent for legacy single-file recordings. */
  tracks?: import("../workspace/types").RecordingTrackManifest;
  /** True when any span of the recording could not be echo-cancelled. */
  aecDegraded?: boolean;
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
  | { type: "levels"; mic: number; system: number; elapsedMs: number; micSuppressed?: boolean }
  | { type: "streamState"; source: LiveAudioSource; state: string; epoch: number }
  | { type: "error"; source?: LiveAudioSource; message: string }
  | { type: "completed"; session: CompletedLiveSession };

export interface DesktopLiveTranslationApi {
  getProviderConfig: () => Promise<LiveTranslationProviderConfig>;
  saveProviderConfig: (config: LiveTranslationProviderConfig) => Promise<LiveTranslationProviderConfig>;
  permissions: () => Promise<LivePermissionStatus>;
  requestPermission: (kind: "microphone" | "systemAudio") => Promise<LivePermissionStatus>;
  /** List selectable capture/playback endpoints (Windows). Empty lists on
   * platforms without device pickers — the UI hides the selectors then. */
  audioDevices: () => Promise<AudioDevicesSnapshot>;
  start: (request: LiveStartRequest) => Promise<LiveTranslationSnapshot>;
  pause: () => Promise<LiveTranslationSnapshot>;
  resume: (request: LiveResumeRequest) => Promise<LiveTranslationSnapshot>;
  setMode: (request: LiveSetModeRequest) => Promise<LiveTranslationSnapshot>;
  /** Acks as soon as the stop is registered; the finished session arrives
   *  later via the `completed` event once the sidecar drain and local
   *  persistence finish. */
  stop: () => Promise<void>;
  getState: () => Promise<LiveTranslationSnapshot>;
  finalizeLocal: (sessionId: string, synced: boolean) => Promise<void>;
  /** Cancel the save of a finished recording: delete its local cache
   *  (transcriptions entry + session directory). Backs the completion
   *  dialog's 取消 button. */
  discard: (sessionId: string) => Promise<void>;
  listRecoveries: () => Promise<LiveRecoverySummary[]>;
  recover: (sessionId: string) => Promise<CompletedLiveSession>;
  /** Re-run echo cancellation over a recording's raw tracks (detail page's
   *  重新处理 entry). Resolves with the refreshed transcription record. */
  reprocess: (sessionId: string) => Promise<Record<string, unknown>>;
  showSubtitles: (show: boolean) => Promise<void>;
  minimizeToTray: () => Promise<void>;
  showMainWindow: () => Promise<void>;
  /** Hide the main window (close-to-tray); the recording island pops when a
   * session is running. Distinct from `minimizeToTray`, which hides whichever
   * webview window it is called from (the subtitle overlay uses it). */
  hideMainWindow: () => Promise<void>;
  /** Hide the recording-island mini window (recording keeps running). */
  hideIsland: () => Promise<void>;
  /** Show + focus the main window and open the recording page — the island's
   * "expand" affordance. No-op outside the desktop app. */
  openRecordingPage: () => Promise<void>;
  /** Toggle the recording-island window between the compact pill and the
   * expanded live-transcript drawer. No-op outside the desktop app. */
  setIslandExpanded: (expanded: boolean) => Promise<void>;
  updateTray: (payload: { recording: boolean; paused: boolean; elapsed_secs?: number }) => Promise<void>;
  onTrayAction: (callback: (action: LiveTranslationTrayAction) => void) => Promise<() => void>;
  onEvent: (callback: (event: LiveTranslationEvent) => void) => Promise<() => void>;
}
