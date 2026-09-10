import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { setApiTransportMode } from "@lynse/core/api/client";
import { hydrateSecrets, refreshSecret, secureStorage } from "./secure-storage";
import type {
  SttDownloadProgress,
  SttModelInfo,
  TranscribeConfig,
  DesktopVaultApi,
  VaultSyncProgress,
} from "@lynse/views/workspace";
import type {
  CompletedLiveSession,
  DesktopLiveTranslationApi,
  LivePermissionStatus,
  LiveRecoverySummary,
  LiveResumeRequest,
  LiveSetModeRequest,
  LiveStartRequest,
  LiveTranslationEvent,
  LiveTranslationProvider,
  LiveTranslationProviderConfig,
  LiveTranslationSnapshot,
  LiveTranslationTrayAction,
} from "@lynse/views/live-translation";
import type {
  DesktopMeetingDetectorApi,
  DetectorConfigPayload,
  DetectorStatus,
  MeetingDetectorEvent,
} from "@lynse/views/live-translation";
import type {
  DesktopInspirationApi,
  InspirationVoiceEvent,
} from "@lynse/views/inspiration";
import type {
  DesktopWebdavSyncApi,
  WebdavSyncProgress,
} from "@lynse/views/settings";
import {
  DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
  normalizeMaxSpeakers,
} from "@lynse/views/live-translation";
import type {
  DesktopRecordingCardApi,
  RecordingCardEvent,
} from "@lynse/views/devices";

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  publishedAt?: string | null;
};

/** Serializable download/install progress handed to the UI. */
export type UpdateDownloadProgress = {
  event: "started" | "progress" | "finished";
  downloaded: number;
  total: number;
};

type DesktopApi = {
  openExternal: (url: string) => Promise<void>;
  localTranscription: Record<string, (...args: any[]) => Promise<unknown>>;
  liveTranslation: DesktopLiveTranslationApi;
  meetingDetector: DesktopMeetingDetectorApi;
  recordingCard: DesktopRecordingCardApi;
  vault: DesktopVaultApi;
  todo: Record<string, (...args: any[]) => Promise<unknown>>;
  inspiration: DesktopInspirationApi;
  webdavSync: DesktopWebdavSyncApi;
  appInfo: { version: string; platform: string };
  app: {
    getInfo: () => Promise<{ version: string; platform: string }>;
    openLogsFolder: () => Promise<void>;
    // Tail of the app log files for the bug report dialog. `truncated` marks
    // that older rotated archives were left out of the tail.
    readLogs: (maxBytes?: number) =>
      Promise<{ dir: string; tail: string; truncated: boolean; files: number }>;
    // Assemble the on-disk report bundle (markdown + screenshots + log copies)
    // and return its folder for reveal in the system file manager.
    prepareReport: (report: {
      markdown: string;
      attachments: string[];
      includeLogs: boolean;
    }) => Promise<{ dir: string }>;
    revealReportFolder: (path: string) => Promise<void>;
    checkForUpdate: () => Promise<AppUpdateInfo>;
    downloadAndInstallUpdate: (onProgress: (progress: UpdateDownloadProgress) => void) => Promise<void>;
    relaunchApp: () => Promise<void>;
  };
}

/** Human-facing fallback link (release page) for "view release" affordances. */
const RELEASES_PAGE_URL = "https://github.com/lynse-ai/lynse-desktop/releases/latest";

// The Update object carries the download/install methods, so it can't cross
// into the UI as a plain value. Keep it here; the UI only ever sees the
// serializable AppUpdateInfo snapshot.
let pendingUpdate: Update | null = null;

function command<T>(name: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, payload);
}

const LIVE_TRANSLATION_PROVIDER_KEY = "lynse_live_translation_provider";
const ILIVEDATA_ENDPOINT_KEY = "lynse_live_translation_ilivedata_endpoint";
const ILIVEDATA_PID_KEY = "lynse_live_translation_ilivedata_pid";
const ILIVEDATA_SECRET_KEY = "lynse_live_translation_ilivedata_secret_key";
const QWEN_ENDPOINT_KEY = "lynse_live_translation_qwen_endpoint";
const QWEN_API_KEY = "lynse_live_translation_qwen_api_key";
const VOLC_ENDPOINT_KEY = "lynse_live_translation_volc_endpoint";
const VOLC_API_KEY = "lynse_live_translation_volc_api_key";
/** iLiveData 说话人识别的最大说话人数；"0" 表示关闭说话人识别。 */
const ILIVEDATA_MAX_SPEAKERS_KEY = "lynse_live_translation_ilivedata_max_speakers";
/** 默认开启说话人识别，上限 2 人（自己 + 对方）。设为 0 则关闭。 */
const DEFAULT_ILIVEDATA_MAX_SPEAKERS = 2;
/** 录音采集来源模式：both（默认双流）/ mic（仅麦克风）/ system（仅系统音频）。 */
const AUDIO_SOURCE_KEY = "lynse_live_translation_audio_source";
type AudioSourceMode = "both" | "mic" | "system";

/** Read the persisted capture-source mode; anything unexpected falls back to
 * the legacy dual-stream behaviour. */
function readAudioSourceMode(): AudioSourceMode {
  const saved = window.localStorage.getItem(AUDIO_SOURCE_KEY);
  return saved === "mic" || saved === "system" ? saved : "both";
}
/** Written by builds that still supported the legacy (App Key) console. */
const LEGACY_VOLC_APP_KEY = "lynse_live_translation_volc_app_key";
const DEFAULT_QWEN_ENDPOINT =
  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime";
const DEFAULT_VOLC_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
const DIRECT_LIVE_TRANSLATION_PROVIDERS = new Set<LiveTranslationProvider>([
  "ilivedata_direct",
  "qwen",
  "volc",
]);
const LEGACY_ILIVEDATA_RTVT_ENDPOINT =
  "wss://rtvt-bj-test.ilivedata.com/gate/websocket";
const LIVE_TRANSLATION_TRAY_EVENT = "live-translation-tray-action";
const LIVE_TRANSLATION_TRAY_NAVIGATE_EVENT = "lynse:live-translation-tray-action";
const pendingLiveTranslationTrayActions: LiveTranslationTrayAction[] = [];
const liveTranslationTrayListeners = new Set<
  (action: LiveTranslationTrayAction) => void
>();

/** Read the persisted max-speaker setting; absent or corrupt values fall back safely. */
function readMaxSpeakers(): number {
  const saved = window.localStorage.getItem(ILIVEDATA_MAX_SPEAKERS_KEY);
  if (saved == null) return DEFAULT_ILIVEDATA_MAX_SPEAKERS;
  const parsed = Number.parseInt(saved, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function getLiveTranslationProviderConfig(): Promise<LiveTranslationProviderConfig> {
  const savedProvider = window.localStorage.getItem(LIVE_TRANSLATION_PROVIDER_KEY);
  const savedEndpoint = window.localStorage.getItem(ILIVEDATA_ENDPOINT_KEY);
  const savedQwenEndpoint = window.localStorage.getItem(QWEN_ENDPOINT_KEY);
  const savedVolcEndpoint = window.localStorage.getItem(VOLC_ENDPOINT_KEY);
  // Re-read secrets from the OS keychain on every fetch so a key changed
  // outside the app (or after startup) takes effect without a restart.
  await Promise.all([
    refreshSecret(ILIVEDATA_SECRET_KEY),
    refreshSecret(QWEN_API_KEY),
    refreshSecret(VOLC_API_KEY),
  ]);
  return {
    provider: DIRECT_LIVE_TRANSLATION_PROVIDERS.has(
      savedProvider as LiveTranslationProvider,
    )
      ? (savedProvider as LiveTranslationProvider)
      : "lynse_backend",
    audioSource: readAudioSourceMode(),
    ilivedata: {
      endpoint: savedEndpoint && savedEndpoint !== LEGACY_ILIVEDATA_RTVT_ENDPOINT
        ? savedEndpoint
        : DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
      pid: window.localStorage.getItem(ILIVEDATA_PID_KEY) ?? "",
      secretKey: secureStorage.getItem(ILIVEDATA_SECRET_KEY) ?? "",
      maxSpeakers: normalizeMaxSpeakers(readMaxSpeakers()),
    },
    qwen: {
      endpoint: savedQwenEndpoint?.trim() || DEFAULT_QWEN_ENDPOINT,
      apiKey: secureStorage.getItem(QWEN_API_KEY) ?? "",
    },
    volc: {
      endpoint: savedVolcEndpoint?.trim() || DEFAULT_VOLC_ENDPOINT,
      apiKey: secureStorage.getItem(VOLC_API_KEY) ?? "",
    },
  };
}

function saveLiveTranslationProviderConfig(
  config: LiveTranslationProviderConfig,
): LiveTranslationProviderConfig {
  const normalized: LiveTranslationProviderConfig = {
    provider: config.provider,
    audioSource:
      config.audioSource === "mic" || config.audioSource === "system"
        ? config.audioSource
        : "both",
    ilivedata: {
      endpoint: config.ilivedata.endpoint.trim() || DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
      pid: config.ilivedata.pid.trim(),
      secretKey: config.ilivedata.secretKey.trim(),
      maxSpeakers: normalizeMaxSpeakers(config.ilivedata.maxSpeakers),
    },
    qwen: {
      endpoint: config.qwen.endpoint.trim() || DEFAULT_QWEN_ENDPOINT,
      apiKey: config.qwen.apiKey.trim(),
    },
    volc: {
      endpoint: config.volc.endpoint.trim() || DEFAULT_VOLC_ENDPOINT,
      apiKey: config.volc.apiKey.trim(),
    },
  };
  window.localStorage.setItem(LIVE_TRANSLATION_PROVIDER_KEY, normalized.provider);
  window.localStorage.setItem(AUDIO_SOURCE_KEY, normalized.audioSource ?? "both");
  window.localStorage.setItem(ILIVEDATA_ENDPOINT_KEY, normalized.ilivedata.endpoint);
  window.localStorage.setItem(ILIVEDATA_PID_KEY, normalized.ilivedata.pid);
  window.localStorage.setItem(
    ILIVEDATA_MAX_SPEAKERS_KEY,
    String(normalized.ilivedata.maxSpeakers ?? 0),
  );
  if (normalized.ilivedata.secretKey) {
    secureStorage.setItem(ILIVEDATA_SECRET_KEY, normalized.ilivedata.secretKey);
  } else {
    secureStorage.removeItem(ILIVEDATA_SECRET_KEY);
  }
  window.localStorage.setItem(QWEN_ENDPOINT_KEY, normalized.qwen.endpoint);
  if (normalized.qwen.apiKey) {
    secureStorage.setItem(QWEN_API_KEY, normalized.qwen.apiKey);
  } else {
    secureStorage.removeItem(QWEN_API_KEY);
  }
  window.localStorage.setItem(VOLC_ENDPOINT_KEY, normalized.volc.endpoint);
  // The legacy console is no longer supported; drop any App Key left behind.
  window.localStorage.removeItem(LEGACY_VOLC_APP_KEY);
  if (normalized.volc.apiKey) {
    secureStorage.setItem(VOLC_API_KEY, normalized.volc.apiKey);
  } else {
    secureStorage.removeItem(VOLC_API_KEY);
  }
  return normalized;
}

export async function installTauriBridge(): Promise<void> {
  // Load credentials from the OS keychain into the in-memory cache before the
  // app renders, so the auth store can read them synchronously.
  await hydrateSecrets();

  // Keep WKWebView's fetch implementation. Routing every fetch through the
  // Tauri HTTP IPC bridge can monopolize the renderer on macOS.
  setApiTransportMode("direct");

  await getCurrentWebview().listen<LiveTranslationTrayAction>(
    LIVE_TRANSLATION_TRAY_EVENT,
    (event) => {
      if (event.payload !== "start" && event.payload !== "pause" && event.payload !== "stop") return;
      if (liveTranslationTrayListeners.size === 0) {
        pendingLiveTranslationTrayActions.push(event.payload);
      } else {
        liveTranslationTrayListeners.forEach((listener) => listener(event.payload));
      }
      window.dispatchEvent(
        new CustomEvent(LIVE_TRANSLATION_TRAY_NAVIGATE_EVENT, {
          detail: event.payload,
        }),
      );
    },
  );

  const desktopAPI: DesktopApi = {
    openExternal: async (url) => {
      await openUrl(url);
    },
    localTranscription: {
      pickAudioFile: async () => {
        const selected = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "Audio and video", extensions: ["mp3", "wav", "m4a", "mp4", "flac", "aac", "ogg", "webm", "mov"] }],
        });
        return typeof selected === "string" ? selected : null;
      },
      transcribe: (audioPath: string, options?: unknown) => command("local_transcription_transcribe", { audioPath, options }),
      list: () => command("local_transcription_list"),
      get: (id: string) => command("local_transcription_get", { id }),
      retry: (id: string) => command("local_transcription_retry", { id }),
      delete: (id: string) => command("local_transcription_delete", { id }),
      getAudioUrl: (id: string) => command("local_transcription_audio_url", { id }),
      listSttModels: () => command<{ models: SttModelInfo[] }>("local_stt_model_status"),
      downloadSttModel: (provider: string, modelId: string) =>
        command<{ models: SttModelInfo[] }>("local_stt_download_model", { provider, modelId }),
      deleteSttModel: (provider: string, modelId: string) =>
        command<{ models: SttModelInfo[] }>("local_stt_delete_model", { provider, modelId }),
      onSttDownloadProgress: (callback: (progress: SttDownloadProgress) => void) =>
        getCurrentWebview().listen<SttDownloadProgress>("stt-download-progress", (event) =>
          callback(event.payload),
        ),
      listHotwordPackages: () => command("local_transcription_list_hotword_packages"),
      saveHotwordPackage: (pkg: unknown) => command("local_transcription_save_hotword_package", { pkg }),
      deleteHotwordPackage: (id: string) => command("local_transcription_delete_hotword_package", { id }),
      listVoiceprints: () => command("local_transcription_list_voiceprints"),
      createVoiceprint: (input: unknown) => command("local_transcription_create_voiceprint", { input }),
      updateVoiceprint: (voiceprint: unknown) => command("local_transcription_update_voiceprint", { voiceprint }),
      deleteVoiceprint: (id: string) => command("local_transcription_delete_voiceprint", { id }),
      getSttConfig: () => command<TranscribeConfig>("local_stt_config_get"),
      saveSttConfig: (config: TranscribeConfig) => command<TranscribeConfig>("local_stt_config_save", { config }),
    },
    liveTranslation: {
      getProviderConfig: async () => getLiveTranslationProviderConfig(),
      saveProviderConfig: async (config) => saveLiveTranslationProviderConfig(config),
      permissions: () => command<LivePermissionStatus>("live_translation_permissions"),
      requestPermission: (kind) => command<LivePermissionStatus>("live_translation_request_permission", { kind }),
      start: (request: LiveStartRequest) => command<LiveTranslationSnapshot>("live_translation_start", { request }),
      pause: () => command<LiveTranslationSnapshot>("live_translation_pause"),
      resume: (request: LiveResumeRequest) => command<LiveTranslationSnapshot>("live_translation_resume", { request }),
      setMode: (request: LiveSetModeRequest) => command<LiveTranslationSnapshot>("live_translation_set_mode", { request }),
      stop: () => command<void>("live_translation_stop"),
      getState: () => command<LiveTranslationSnapshot>("live_translation_state"),
      finalizeLocal: (sessionId, synced) => command<void>("live_translation_finalize_local", { sessionId, synced }),
      listRecoveries: () => command<LiveRecoverySummary[]>("live_translation_recoveries"),
      recover: (sessionId) => command<CompletedLiveSession>("live_translation_recover", { sessionId }),
      showSubtitles: (show) => command<void>("live_translation_show_subtitles", { show }),
      showMainWindow: () => command<void>("live_translation_show_main"),
      // Hide the main window (close-to-tray). Rust shows the recording island
      // when a session is running, so the session stays reachable without the
      // main window.
      hideMainWindow: () => command<void>("live_translation_hide_main"),
      // Focus the main window, then broadcast a plain Tauri event that the
      // desktop navigation provider listens for — the island's "expand" must
      // land the user on the recording page, not just un-minimize the window.
      openRecordingPage: async () => {
        await command<void>("live_translation_show_main");
        await emit("lynse:open-recording-page");
      },
      hideIsland: () => command<void>("live_translation_hide_island"),
      // Payload key must match the Rust command's `expand` parameter exactly;
      // a mismatch makes the invoke reject and the island silently never grows.
      setIslandExpanded: (expanded) => command<void>("live_translation_expand_island", { expand: expanded }),
      updateTray: (payload) => command<void>("live_translation_update_tray", { payload }),
      minimizeToTray: () => getCurrentWindow().hide(),
      onTrayAction: async (callback) => {
        liveTranslationTrayListeners.add(callback);
        const pending = pendingLiveTranslationTrayActions.splice(0);
        pending.forEach(callback);
        return () => liveTranslationTrayListeners.delete(callback);
      },
      onEvent: (callback: (event: LiveTranslationEvent) => void) =>
        getCurrentWebview().listen<LiveTranslationEvent>("live-translation-event", (event) => callback(event.payload)),
    },
    meetingDetector: {
      setConfig: (config: DetectorConfigPayload) =>
        command<DetectorStatus>("meeting_detector_set_config", { config }),
      getState: () => command<DetectorStatus>("meeting_detector_get_state"),
      onEvent: (callback: (event: MeetingDetectorEvent) => void) =>
        getCurrentWebview().listen<MeetingDetectorEvent>("meeting-detector-event", (event) =>
          callback(event.payload),
        ),
    },
    recordingCard: {
      state: () => command("recording_card_state"),
      scanStart: () => command<void>("recording_card_scan_start"),
      scanStop: () => command<void>("recording_card_scan_stop"),
      setManufacturerCode: (code: string) =>
        command<void>("recording_card_set_manufacturer_code", { code }),
      setLiveFeed: (enabled: boolean) =>
        command<void>("recording_card_set_live_feed", { enabled }),
      connect: (device: unknown) =>
        command("recording_card_connect", { device }),
      disconnect: () => command<void>("recording_card_disconnect"),
      query: (kind: "battery" | "version" | "memory") =>
        command<void>("recording_card_query", { kind }),
      record: (action: string, mode?: string) =>
        command<void>("recording_card_record", { action, mode }),
      listFiles: () => command("recording_card_list_files"),
      download: (
        file: { sn: number; name: string; size: number; frameBytes: number },
        autoDelete: boolean,
      ) => command<void>("recording_card_download", { ...file, autoDelete }),
      cancelDownload: () => command<void>("recording_card_cancel_download"),
      deleteFile: (sn: number, name: string) =>
        command<void>("recording_card_delete_file", { sn, name }),
      transcribeSource: (name: string, sn: number, frameBytes: number) =>
        command<string>("recording_card_transcribe_source", { name, sn, frameBytes }),
      onEvent: async (callback: (event: RecordingCardEvent) => void) => {
        const unlisten = await getCurrentWebview().listen<RecordingCardEvent>(
          "recording-card-event",
          (event) => callback(event.payload),
        );
        return unlisten;
      },
    },
    appInfo: { version: "0.1.0", platform: "darwin" },
    app: {
      getInfo: () => command<{ version: string; platform: string }>("get_app_info"),
      openLogsFolder: () => command<void>("open_logs_folder"),
      readLogs: (maxBytes?: number) =>
        command<{ dir: string; tail: string; truncated: boolean; files: number }>(
          "diagnostics_read_logs",
          { maxBytes },
        ),
      // Assemble the on-disk report bundle (markdown + screenshots + log copies)
      // and return its folder for reveal in the system file manager.
      prepareReport: (report: {
        markdown: string;
        attachments: string[];
        includeLogs: boolean;
      }) =>
        command<{ dir: string }>("diagnostics_prepare_report", {
          markdown: report.markdown,
          attachments: report.attachments,
          includeLogs: report.includeLogs,
        }),
      revealReportFolder: (path: string) => openPath(path),
      // Talks to the tauri-plugin-updater, whose endpoints/pubkey live in
      // tauri.conf.json; releases are published by release.yml. `check()`
      // returns null when the running version is the latest.
      checkForUpdate: async () => {
        const update = await check();
        pendingUpdate = update;
        if (!update) {
          return {
            currentVersion: desktopAPI.appInfo.version,
            latestVersion: desktopAPI.appInfo.version,
            hasUpdate: false,
            releaseUrl: RELEASES_PAGE_URL,
            releaseNotes: null,
            publishedAt: null,
          };
        }
        return {
          currentVersion: update.currentVersion,
          latestVersion: update.version,
          hasUpdate: true,
          releaseUrl: RELEASES_PAGE_URL,
          releaseNotes: update.body ?? null,
          publishedAt: update.date ?? null,
        };
      },
      // Downloads, verifies the minisign signature, and installs the update.
      // On macOS the bundle is replaced in place; on Windows the installer
      // runs (passive mode) — the app then relaunches into the new version.
      downloadAndInstallUpdate: async (onProgress) => {
        const update = pendingUpdate ?? (await check().then((next) => (pendingUpdate = next)));
        if (!update) throw new Error("no update available");
        let downloaded = 0;
        let total = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? 0;
            onProgress({ event: "started", downloaded: 0, total });
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            onProgress({ event: "progress", downloaded, total });
          } else {
            onProgress({ event: "finished", downloaded, total });
          }
        });
      },
      relaunchApp: () => relaunch(),
    },
    vault: {
      getConfig: () => command("vault_config_get"),
      saveConfig: (config) => command("vault_config_save", { config }),
      getDefaultPath: () => command("vault_default_path"),
      pickDirectory: async () => {
        const selected = await open({ multiple: false, directory: true });
        return typeof selected === "string" ? selected : null;
      },
      writeNote: (note) => command("vault_write_note", { note }),
      writeNotes: (notes) => command("vault_write_notes", { notes }),
      readNote: (fileId) => command("vault_read_note", { fileId }),
      removeNote: (fileId) => command("vault_remove_note", { fileId }),
      openVaultFolder: async (path) => {
        await openPath(path);
      },
      onSyncProgress: (callback) =>
        getCurrentWebview().listen<VaultSyncProgress>("vault-sync-progress", (event) =>
          callback(event.payload),
        ),
    },
    todo: {
      list: () => command("todo_list"),
      save: (todo: unknown) => command("todo_save", { todo }),
      delete: (id: string) => command("todo_delete", { id }),
      addToCalendar: (id: string, title: string, sourceTitle: string | null, startAt: string, endAt: string, confirmed: boolean) =>
        command("todo_add_to_calendar", { todo_id: id, title, source_title: sourceTitle, start_at: startAt, end_at: endAt, confirmed }),
    },
    inspiration: {
      list: () => command("inspiration_list"),
      save: (inspiration: unknown) => command("inspiration_save", { inspiration }),
      delete: (id: string) => command("inspiration_delete", { id }),
      transcribe: (id: string) => command("inspiration_transcribe", { id }),
      getAudioUrl: (id: string) => command("inspiration_audio_url", { id }),
      getImageUrl: (id: string, file: string) => command("inspiration_image_url", { id, file }),
      pickImages: async () => {
        const selected = await open({
          multiple: true,
          directory: false,
          filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "heic", "webp", "gif", "bmp", "tiff", "tif"] }],
        });
        return Array.isArray(selected) ? selected : [];
      },
      // Raw IPC: the Uint8Array is sent as the invoke body, not JSON.
      stageImage: (data: Uint8Array) => invoke<{ path: string; url: string }>("inspiration_stage_image", data),
      stageImageFromClipboard: () =>
        command<{ path: string; url: string }>("inspiration_stage_image_from_clipboard"),
      stageImageFromPath: (path: string) =>
        command<{ path: string; url: string }>("inspiration_stage_image_from_path", { path }),
      captureFromIPhone: () => command<void>("inspiration_capture_from_iphone"),
      voiceStart: () => command("inspiration_voice_start"),
      voiceStop: () => command("inspiration_voice_stop"),
      voiceCancel: () => command("inspiration_voice_cancel"),
      voiceState: () => command("inspiration_voice_state"),
      onVoiceEvent: (callback: (event: InspirationVoiceEvent) => void) =>
        getCurrentWebview().listen<InspirationVoiceEvent>("inspiration-voice-event", (event) =>
          callback(event.payload),
        ),
    },
    webdavSync: {
      getConfig: () => command("webdav_config_get"),
      saveConfig: (config) => command("webdav_config_save", { config }),
      setPassword: (password: string) => command("webdav_set_password", { password }),
      testConnection: (config, password) =>
        command("webdav_test_connection", { config, password: password ?? null }),
      syncNow: (settingsBundle) => command("webdav_sync_now", { settingsBundle }),
      putNotes: (notes) => command("webdav_put_notes", { notes }),
      onSyncProgress: (callback) =>
        getCurrentWebview().listen<WebdavSyncProgress>("webdav-sync-progress", (event) =>
          callback(event.payload),
        ),
    },
  };

  (window as Window & { desktopAPI?: DesktopApi }).desktopAPI = desktopAPI;

  // Replace the hardcoded fallback with the authoritative version reported by
  // the Rust host (package_info), so the UI version stays correct across
  // releases without manual edits. Failures keep the static fallback so the
  // app still boots.
  try {
    desktopAPI.appInfo = await desktopAPI.app.getInfo();
  } catch {
    /* keep fallback */
  }
}
