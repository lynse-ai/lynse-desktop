export { LiveTranslationPage } from "./live-translation-page";
export { TranscriptDetailPage } from "./transcript-detail-page";
export { LiveSubtitleOverlay } from "./subtitle-overlay";
export { RecordingIslandWindow } from "./recording-island-window";
export { RecordingTrayAgent } from "./recording-tray-agent";
export { MeetingAutoRecordAgent } from "./meeting-auto-record-agent";
export { useQuickRecording } from "./quick-recording";
export type {
  CompletedLiveSession,
  DesktopLiveTranslationApi,
  LiveAudioSource,
  LiveConnectionDescriptor,
  LivePermissionStatus,
  LiveResumeRequest,
  LiveSetModeRequest,
  LiveRecoverySummary,
  LiveStartRequest,
  LiveTranslationEvent,
  LiveTranslationProvider,
  LiveTranslationProviderConfig,
  LiveTranslationSegment,
  LiveTranslationSnapshot,
  LiveTranslationState,
  LiveTranslationTrayAction,
} from "./types";
export { DEFAULT_ILIVEDATA_RTVT_ENDPOINT } from "./types";
export { normalizeMaxSpeakers } from "./api";
export {
  DEFAULT_END_GRACE_SECS,
  DEFAULT_START_DEBOUNCE_SECS,
  KNOWN_MEETING_APPS,
  MEETING_AUTO_RECORD_CONFIG_KEY,
  defaultMeetingAutoRecordConfig,
  getDesktopMeetingDetectorApi,
  loadMeetingAutoRecordConfig,
  parseMeetingAutoRecordConfig,
  saveMeetingAutoRecordConfig,
  toDetectorConfigPayload,
} from "./meeting-auto-record";
export type {
  DetectorConfigPayload,
  DetectorStatus,
  DesktopMeetingDetectorApi,
  MeetingAppEntry,
  MeetingAutoRecordConfig,
  MeetingDetectorEvent,
} from "./meeting-auto-record";
