export type LiveAudioSource = "mic" | "system";

export const DEFAULT_ILIVEDATA_RTVT_ENDPOINT =
  "wss://rtvt-cn-app.ilivedata.com/gate/websocket";

export const DEFAULT_QWEN_ENDPOINT =
  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime";

export const DEFAULT_VOLC_AST_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";

export const DEFAULT_TENCENT_ASR_ENDPOINT =
  "wss://asr.cloud.tencent.com/asr/v2";

/**
 * Wire-protocol tag each provider plugin stamps onto its connection
 * descriptors; the Rust websocket loop dispatches on it. Plugin ids are
 * richer than protocols — the built-in Qwen plugin and the user-configured
 * custom plugin both speak the DashScope protocol ("qwen" is the legacy tag,
 * kept so persisted-record engine labels stay continuous; "dashscope" is the
 * generic name). Absent tag (backend-minted URLs) means the plain JSON
 * `method` protocol.
 */
export type LiveTranslationProtocol =
  | "direct"
  | "dashscope"
  | "qwen"
  | "volc"
  | "tencent";

/** Which capture streams the sidecar records. "both" keeps the legacy
 * dual-stream behaviour; "system" is the transcribe-a-playing-video case
 * (the mic would only duplicate the video audio as echo). */
export type LiveAudioSourceMode = "both" | "mic" | "system";

/**
 * Provider settings v2 — registry-driven. Non-secret field values are keyed
 * by plugin id and field key; secrets never live here (they are merged into
 * the runtime config by the bridge on read and split out again on save).
 */
export interface LiveTranslationProviderConfig {
  /** Plugin id of the provider sessions attach to ("lynse_backend", "qwen",
   * "tencent", "custom", ...). Unknown ids fall back to the backend relay. */
  activeProvider: string;
  /** Capture-source mode; persisted alongside the provider credentials so
   * the start request and the connection builder read the same setting. */
  audioSource?: LiveAudioSourceMode;
  /** Preferred translation direction. Persisted so every start entry point
   * (recording page, tray, float dock, meeting auto-record) honors the
   * user's chosen source language instead of hard-coding one. */
  sourceLanguage?: string;
  targetLanguage?: string;
  /** All field values (secrets included) per plugin id, keyed by field key. */
  values: Record<string, Record<string, string>>;
}

/**
 * What actually persists: the settings blob in localStorage. Identical to
 * the runtime config minus the secret values.
 */
export interface PersistedLiveTranslationSettings {
  version: 2;
  activeProvider: string;
  audioSource: LiveAudioSourceMode;
  sourceLanguage?: string;
  targetLanguage?: string;
  /** Non-secret field values per plugin id. */
  fields: Record<string, Record<string, string>>;
}

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

export interface RecordingMarker {
  sourceRef?: import("../workbench/types").SourceRef;
  id: string;
  kind: "highlight" | "decision" | "todo";
  note: string;
  startMs: number;
}

export interface LiveTranslationSnapshot {
  markers?: RecordingMarker[];
  state: LiveTranslationState;
  sessionId?: string;
  epoch: number;
  sourceLanguage?: string;
  targetLanguage?: string;
  startedAt?: string;
  elapsedMs: number;
  micLevel: number;
  systemLevel: number;
  recordingLevel?: number;
  audioSources?: LiveAudioSource[];
  sourceRevision?: number;
  aecActive?: boolean;
  aecDegraded?: boolean;
  sourceErrors?: Partial<Record<LiveAudioSource, string>>;
  segments: LiveTranslationSegment[];
}

export interface LivePermissionStatus {
  microphoneAvailable?: boolean | null;
  systemAudioAvailable?: boolean | null;
  microphone: "granted" | "denied" | "notDetermined";
  systemAudio: "granted" | "denied" | "notDetermined";
  /** EventKit calendar grant (macOS only). "unsupported" (Windows) or absent
   * (older desktop builds) hides the onboarding row — it is an optional
   * permission owned by the onboarding page, never the recording flow. */
  calendar?: "granted" | "denied" | "notDetermined" | "unsupported";
  systemAudioRequired: boolean;
  restartRequired: boolean;
}

export interface LiveConnectionDescriptor {
  source: LiveAudioSource;
  url: string;
  /** Wire-protocol tag for the Rust connection loop (see
   * `LiveTranslationProtocol`). Absent means the plain JSON protocol the
   * Lynse backend relay mints URLs for. */
  provider?: LiveTranslationProtocol;
  apiKey?: string;
  /** Provider-specific credentials that don't fit the single-key model.
   * Tencent ASR carries secretId/secretKey/engineType here so the Rust
   * connection loop can re-sign the URL on every (re)connect. */
  extra?: Record<string, string>;
}

export interface LiveStartRequest {
  /** Only detector-started sessions retain the silence auto-stop policy. */
  automatic?: boolean;
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
  markers?: RecordingMarker[];
  sessionId: string;
  recordId: string;
  /** RFC3339 recording start time; the cloud sync sends it as
   *  `recordStartTime` so the backend aligns the file's create time. */
  startedAt?: string;
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
  | { type: "levels"; mic: number; system: number; elapsedMs: number; micSuppressed?: boolean; recordingLevel?: number; sourceRevision?: number; sessionId?: string; aecDegraded?: boolean }
  | { type: "streamState"; source: LiveAudioSource; state: string; epoch: number }
  | { type: "error"; source?: LiveAudioSource; message: string }
  | { type: "completed"; session: CompletedLiveSession };

export interface DesktopLiveTranslationApi {
  getProviderConfig: () => Promise<LiveTranslationProviderConfig>;
  saveProviderConfig: (config: LiveTranslationProviderConfig) => Promise<LiveTranslationProviderConfig>;
  permissions: () => Promise<LivePermissionStatus>;
  requestPermission: (kind: "microphone" | "systemAudio" | "calendar") => Promise<LivePermissionStatus>;
  /** Open the OS privacy pane for one permission kind (System Settings on
   * macOS). Backs the onboarding toggles: a request that still ends
   * ungranted lands the user where the grant actually lives. */
  openPrivacyPane: (kind: "microphone" | "systemAudio" | "calendar") => Promise<void>;
  /** List selectable capture/playback endpoints (Windows). Empty lists on
   * platforms without device pickers — the UI hides the selectors then. */
  audioDevices: () => Promise<AudioDevicesSnapshot>;
  start: (request: LiveStartRequest) => Promise<LiveTranslationSnapshot>;
  pause: () => Promise<LiveTranslationSnapshot>;
  resume: (request: LiveResumeRequest) => Promise<LiveTranslationSnapshot>;
  setMode: (request: LiveSetModeRequest) => Promise<LiveTranslationSnapshot>;
  setSources?: (request: { sessionId: string; audioSources: LiveAudioSource[]; sourceRevision: number }) => Promise<LiveTranslationSnapshot>;
  waveformPeaks?: (src: string, recordId?: string | null) => Promise<{ peaks: number[]; durationMs: number }>;
  /** Acks as soon as the stop is registered; the finished session arrives
   *  later via the `completed` event once the sidecar drain and local
   *  persistence finish. */
  marker?: (kind: RecordingMarker["kind"], note?: string, id?: string, remove?: boolean) => Promise<LiveTranslationSnapshot>;
  stop: () => Promise<void>;
  getState: () => Promise<LiveTranslationSnapshot>;
  finalizeLocal: (sessionId: string, synced: boolean) => Promise<void>;
  /** Remember the client-generated cloud fileId for a finished recording so
   *  a retried cloud sync reuses the same server-side placeholder. */
  setCloudFileId: (sessionId: string, cloudFileId: string) => Promise<void>;
  /** Cancel the save of a finished recording: delete its local cache
   *  (transcriptions entry + session directory). Backs the completion
   *  dialog's 取消 button. */
  discard: (sessionId: string) => Promise<void>;
  listRecoveries: () => Promise<LiveRecoverySummary[]>;
  recover: (sessionId: string) => Promise<CompletedLiveSession>;
  /** Delete one stranded crash-recovery session without saving it. Backs
   *  the recovery prompt's 丢弃 button; refuses saved or active sessions. */
  discardRecovery: (sessionId: string) => Promise<void>;
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
