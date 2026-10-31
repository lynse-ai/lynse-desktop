import type { DesktopWorkbenchApi } from "@lynse/views/workbench";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

/** Window frame to restore when the permission onboarding closes. Captured
 * at enter time so a user-resized (or maximized — untouched) frame comes
 * back exactly as it was. */
let savedOnboardingFrame: { width: number; height: number } | null = null;
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { setApiTransportMode } from "@lynse/core/api/client";
import { normalizeReleaseNotesLocales, type ReleaseNotesLocales } from "@lynse/core/i18n";
import { installWorkBuddyBridge } from "./workbuddy-bridge";
import { desktopMcpApi, installDesktopMcpBridge, type DesktopMcpApi } from "./mcp-bridge";
import { hydrateSecrets, refreshSecret, registerSecretKeys, removeSecret, secureStorage, setSecret } from "./secure-storage";
import {
  collectLegacyLiveTranslationSnapshot,
  getProvider,
  LEGACY_VOLC_APP_KEY,
  listProviders,
  listSecretVaultKeys,
  migrateLegacyProviderSettings,
  parsePersistedSettings,
  secretVaultKey,
} from "@lynse/views/live-translation";
import type { PersistedLiveTranslationSettings } from "@lynse/views/live-translation";
import type {
  SttDownloadProgress,
  SttModelInfo,
  SttProviderConfig,
  LocalTranscriptionUpdate,
  TranscribeConfig,
  DesktopCloudSyncApi,
  DesktopVaultApi,
  VaultSyncProgress,
} from "@lynse/views/workspace";
import type {
  AudioDevicesSnapshot,
  CompletedLiveSession,
  DesktopLiveTranslationApi,
  LivePermissionStatus,
  LiveRecoverySummary,
  LiveResumeRequest,
  LiveSetModeRequest,
  LiveStartRequest,
  LiveTranslationEvent,
  LiveTranslationProviderConfig,
  LiveTranslationSnapshot,
  LiveTranslationTrayAction,
  VaultAccessReport,
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
} from "@lynse/views/inspiration";import type {
  DesktopWebdavSyncApi,
  DesktopStorageApi,
  WebdavSyncProgress,
} from "@lynse/views/settings";
import type {
  DesktopFeishuApi,
  FeishuChatSummary,
  FeishuConfig,
  FeishuRegistrationPoll,
  FeishuRegistrationStart,
  FeishuStatus,
} from "@lynse/views/feishu";
import type {
  BotChannelConfig,
  BotIncomingMessage,
  BotOutboundApi,
  DesktopBotsApi,
} from "@lynse/views/bots";
import type {
  AudioEditorProgress,
  DesktopAudioEditorApi,
} from "@lynse/views/audio-editor";

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  releaseNotesByLocale?: ReleaseNotesLocales;
  publishedAt?: string | null;
};

/** Serializable download/install progress handed to the UI. */
export type UpdateDownloadProgress = {
  event: "started" | "progress" | "finished";
  downloaded: number;
  total: number;
};

type DesktopApi = {
  mcp: DesktopMcpApi;
  openExternal: (url: string) => Promise<void>;
  // Asks where to save with a native dialog, then Rust fetches the remote
  // attachment (the webview can't — no CORS for the app origin) and writes
  // it to the picked path. Resolves null when the user cancels the dialog.
  attachment: {
    save: (url: string, fileName: string) => Promise<{ path: string } | null>;
    saveBytes: (bytes: number[], fileName: string) => Promise<{ path: string } | null>;
    // Fetch an attachment's body for the in-app preview, over the same Rust
    // route as `save` — the renderer cannot reach the signed hosts itself.
    text: (url: string) => Promise<string>;
  };
  localTranscription: Record<string, (...args: any[]) => Promise<unknown>>;
  cloudSync: DesktopCloudSyncApi;
  liveTranslation: DesktopLiveTranslationApi;
  workbench: DesktopWorkbenchApi;
  memory: DesktopWorkbenchApi;
  meetingDetector: DesktopMeetingDetectorApi;
  vault: DesktopVaultApi;
  todo: Record<string, (...args: any[]) => Promise<unknown>>;
  inspiration: DesktopInspirationApi;
  webdavSync: DesktopWebdavSyncApi;
  storage: DesktopStorageApi;
  audioEditor: DesktopAudioEditorApi;
  feishu: DesktopFeishuApi;
  bots: DesktopBotsApi;
  appInfo: {
    version: string;
    build?: string | null;
    platform: string;
    /** macOS App Sandbox (TestFlight/App Store) build — updater must not install in place. */
    sandboxed: boolean;
  };
  app: {
    enterOnboardingWindowSize?: () => Promise<void>;
    exitOnboardingWindowSize?: () => Promise<void>;
    getInfo: () => Promise<{
      version: string;
      platform: string;
      sandboxed: boolean;
    }>;
    openAboutWindow: (title?: string) => Promise<void>;
    openFeedbackWindow: (title?: string) => Promise<void>;
    // Opens (or focuses) the standalone problem-report window (macOS; other
    // platforms use the in-app dialog).
    openReportWindow: (title?: string) => Promise<void>;
    // Capture the main window as JPEG, with a platform-compatible preview URL.
    captureScreenshot: () => Promise<{ path: string; url: string }>;
    // File the report through the CloudBase cnb-report function (which owns
    // the CNB token server-side); returns the created issue number.
    submitCnbIssue: (req: {
      endpoint: string;
      title: string;
      body: string;
      screenshotPath?: string | null;
    }) => Promise<{ number: number }>;
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
    setCompactWindowSize: (active: boolean) => Promise<void>;
    // WeChat OAuth sign-in window: the authorize page opens in an embedded
    // window and the code+state redirect is relayed back as a URL event.
    wechat: {
      openAuthWindow: (url: string) => Promise<void>;
      closeAuthWindow: () => Promise<void>;
      onAuthCallback: (
        callback: (callbackUrl: string) => void,
      ) => Promise<() => void>;
    };
  };
}

/** Human-facing link for "view release" affordances — the website download
 * page (keep in sync with packages/views/about/links.ts DOWNLOAD_URL). */
const RELEASES_PAGE_URL = "https://www.lynse.cn/download";

// The Update object carries the download/install methods, so it can't cross
// into the UI as a plain value. Keep it here; the UI only ever sees the
// serializable AppUpdateInfo snapshot.
let pendingUpdate: Update | null = null;

function command<T>(name: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, payload);
}

/**
 * Live-translation provider settings v2 — registry-driven storage.
 *
 * Non-secret field values persist as one JSON blob in localStorage; secrets
 * go to the OS-keychain vault under `lynse_live_translation_<provider>_<field>`
 * (the same keys the pre-registry layout used, so existing credentials keep
 * resolving). Which fields exist and which of them are secrets is derived
 * from the provider plugin registry — adding a provider adds storage paths
 * without touching this file.
 */
const LIVE_TRANSLATION_SETTINGS_V2_KEY = "lynse_live_translation_settings_v2";

// Register the providers' vault key paths before any read/write so a plugin
// secret is never silently downgraded to localStorage by secure-storage.
registerSecretKeys(listSecretVaultKeys());

/** Read the v2 blob, migrating the legacy per-field localStorage keys into it
 * on the first launch after this refactor. Legacy keys stay on disk for one
 * version as a rollback path; the blob is authoritative from here on. */
function loadPersistedLiveTranslationSettings(): PersistedLiveTranslationSettings {
  const parsed = parsePersistedSettings(
    window.localStorage.getItem(LIVE_TRANSLATION_SETTINGS_V2_KEY),
  );
  if (parsed) return parsed;
  const migrated = migrateLegacyProviderSettings(
    collectLegacyLiveTranslationSnapshot((key) => window.localStorage.getItem(key)),
  );
  window.localStorage.setItem(LIVE_TRANSLATION_SETTINGS_V2_KEY, JSON.stringify(migrated));
  return migrated;
}

/** Merge the persisted blob with the vault's secret values into the flat
 * value map the UI edits and the connection builders consume. */
function toProviderConfig(settings: PersistedLiveTranslationSettings): LiveTranslationProviderConfig {
  const values: Record<string, Record<string, string>> = {};
  for (const plugin of listProviders()) {
    const entry: Record<string, string> = {};
    for (const field of plugin.fields) {
      entry[field.key] = field.secret
        ? secureStorage.getItem(secretVaultKey(plugin, field)) ?? ""
        : settings.fields[plugin.id]?.[field.key] ?? "";
    }
    values[plugin.id] = entry;
  }
  return {
    activeProvider: getProvider(settings.activeProvider)
      ? settings.activeProvider
      : "lynse_backend",
    audioSource: settings.audioSource,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    values,
  };
}

async function getLiveTranslationProviderConfig(): Promise<LiveTranslationProviderConfig> {
  // Re-read secrets from the OS keychain on every fetch so a key changed
  // outside the app (or after startup) takes effect without a restart.
  await Promise.all(listSecretVaultKeys().map((key) => refreshSecret(key)));
  return toProviderConfig(loadPersistedLiveTranslationSettings());
}

async function saveLiveTranslationProviderConfig(
  config: LiveTranslationProviderConfig,
): Promise<LiveTranslationProviderConfig> {
  const fields: PersistedLiveTranslationSettings["fields"] = {};
  for (const plugin of listProviders()) {
    const stored: Record<string, string> = {};
    for (const field of plugin.fields) {
      const value = config.values[plugin.id]?.[field.key]?.trim() ?? "";
      if (field.secret) {
        // An emptied secret field removes the vault entry — clearing a key
        // in the form really unsets it.
        if (value) {
          await setSecret(secretVaultKey(plugin, field), value);
        } else {
          await removeSecret(secretVaultKey(plugin, field));
        }
      } else {
        stored[field.key] = value;
      }
    }
    fields[plugin.id] = stored;
  }
  const normalized: PersistedLiveTranslationSettings = {
    version: 2,
    activeProvider: getProvider(config.activeProvider)
      ? config.activeProvider
      : "lynse_backend",
    audioSource:
      config.audioSource === "mic" || config.audioSource === "system"
        ? config.audioSource
        : "both",
    sourceLanguage: config.sourceLanguage?.trim() || undefined,
    targetLanguage: config.targetLanguage?.trim() || undefined,
    fields,
  };
  window.localStorage.setItem(LIVE_TRANSLATION_SETTINGS_V2_KEY, JSON.stringify(normalized));
  // The legacy console is no longer supported; drop any App Key left behind.
  window.localStorage.removeItem(LEGACY_VOLC_APP_KEY);
  return toProviderConfig(normalized);
}

const LIVE_TRANSLATION_TRAY_EVENT = "live-translation-tray-action";
const LIVE_TRANSLATION_TRAY_NAVIGATE_EVENT = "lynse:live-translation-tray-action";
const pendingLiveTranslationTrayActions: LiveTranslationTrayAction[] = [];
const liveTranslationTrayListeners = new Set<
  (action: LiveTranslationTrayAction) => void
>();

export async function installTauriBridge(): Promise<void> {
  // Load credentials from the OS keychain into the in-memory cache before the
  // app renders, so the auth store can read them synchronously.
  await hydrateSecrets();

  // Keep WKWebView's fetch implementation. Routing every fetch through the
  // Tauri HTTP IPC bridge can monopolize the renderer on macOS.
  setApiTransportMode("direct");

  // WorkBuddy OpenAPI calls must leave the WebView: the WorkBuddy API serves
  // no CORS headers for the tauri origin, so renderer fetch dies as "Load
  // failed". Relay them through the reqwest-backed Rust command; the token
  // and its refresh flow stay in core.
  installWorkBuddyBridge();

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

  const workbenchApi: DesktopWorkbenchApi = {
    bind: (request) => command("workbench_bind", { request }),
    setTextModel: (modelOverride) => command("workbench_set_text_model", { modelOverride }),
    unbind: () => command("workbench_unbind"),
    status: () => command("workbench_status"),
    wiki: (request) => command("workbench_wiki", { request }),
    configure: (enabled, allowAi, automation) => command("workbench_configure", { enabled, allowAi, ...(automation ? { automation } : {}) }),
    sync: (retryFailed, refreshExisting) => command("workbench_sync", { retryFailed, refreshExisting }),
    search: (query, aiOnly) => command("workbench_search", { query, aiOnly }),
    read: (id) => command("workbench_read", { id }),
    review: (query) => command("workbench_review", { query }),
    exclude: (id, excluded) => command("workbench_exclude", { id, excluded }),
    editMemory: (id, text, pinned, excluded) => command("workbench_memory_edit", { id, text, pinned, excluded }),
    knowledgePolicy: (request) => command("workbench_knowledge_policy", { request }),
    memoryFiles: (scope) => command("workbench_memory_files", { scope, request: { action: "list" } }),
    readMemoryFile: (scope, path) => command("workbench_memory_files", { scope, request: { action: "read", path } }),
    reloadMemoryFile: (scope, path) => command("workbench_memory_files", { scope, request: { action: "reload", path } }),
    saveMemoryFile: (scope, path, markdown, revision) => command("workbench_memory_files", { scope, request: { action: "save", path, markdown, revision } }),
    createMemoryFile: (scope, title) => command("workbench_memory_files", { scope, request: { action: "create", title } }),
    clear: () => command("workbench_clear"),
    confirmTodos: (id, suggestions) => command("workbench_confirm_todos", { id, suggestions }),
    syncMemorySource: (id) => command("workbench_sync_memory_source", { id }),
    readForAi: (id) => command("workbench_read_for_ai", { id }),
    context: (query) => command("workbench_context", { query }),
    saveSummary: (id, summaryId, markdown) => command("workbench_summary_save", { id, summaryId, markdown }),
    regenerate: (id) => command("workbench_regenerate", { id }),
    removeSource: (id) => command("workbench_remove_source", { id }),
    resolveConflict: (id, keepLocal) => command("workbench_resolve_conflict", { id, keepLocal }),
    onUpdate: async (callback) => getCurrentWebview().listen("workbench-updated", (event) => callback(event.payload as Parameters<typeof callback>[0])),
  };
  const desktopAPI: DesktopApi = {
    workbench: workbenchApi,
    memory: workbenchApi,
    mcp: desktopMcpApi,
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
      start: (audioPath: string, options?: unknown) => command("local_transcription_start", { audioPath, options }),
      list: () => command("local_transcription_list"),
      get: (id: string) => command("local_transcription_get", { id }),
      retry: (id: string, options?: { track?: "mic" | "system" }) =>
        command("local_transcription_retry", { id, options }),
      getTrackAudioUrl: (id: string, file: string) =>
        command<string>("local_transcription_track_audio_url", { id, file }),
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
      onTranscriptionUpdate: (callback: (update: LocalTranscriptionUpdate) => void) =>
        getCurrentWebview().listen<LocalTranscriptionUpdate>("local-transcription-updated", (event) =>
          callback(event.payload),
        ),
      listHotwordPackages: () => command("local_transcription_list_hotword_packages"),
      saveHotwordPackage: (pkg: unknown) => command("local_transcription_save_hotword_package", { pkg }),
      deleteHotwordPackage: (id: string) => command("local_transcription_delete_hotword_package", { id }),
      listVoiceprints: () => command("local_transcription_list_voiceprints"),
      createVoiceprint: (input: unknown) => command("local_transcription_create_voiceprint", { input }),
      updateVoiceprint: (voiceprint: unknown) => command("local_transcription_update_voiceprint", { voiceprint }),
      deleteVoiceprint: (id: string) => command("local_transcription_delete_voiceprint", { id }),
      getVoiceprintBackendStatus: () =>
        command<{ backend: string | null; modelInstalled: boolean }>(
          "local_voiceprint_backend_status",
        ),
      getSttConfig: () => command<TranscribeConfig>("local_stt_config_get"),
      saveSttConfig: (config: TranscribeConfig) => command<TranscribeConfig>("local_stt_config_save", { config }),
      setSttLocale: (locale: string) => command<TranscribeConfig>("local_stt_set_locale", { locale }),
      getDefaultSttProvider: (locale: string | null) =>
        command<SttProviderConfig>("local_stt_default_provider", { locale }),
    },
    cloudSync: {
      audioSize: (recordId) => command<number>("sync_upload_audio_size", { recordId }),
      putSignedFile: (put) =>
        command<{ sizeBytes: number }>("sync_upload_put_signed_file", { put }),
    },
    audioEditor: {
      status: () => command<{ ffmpegAvailable: boolean }>("audio_editor_status"),
      ensureRuntime: () => command<{ ffmpegAvailable: boolean }>("audio_editor_ensure_runtime"),
      trim: (source: string, startSec: number, endSec: number, outName?: string, overwrite?: boolean) =>
        command("audio_editor_trim", { source, startSec, endSec, outName, overwrite }),
      merge: (sources: string[], outName?: string) =>
        command("audio_editor_merge", { sources, outName }),
      removeSilence: (
        source: string,
        options?: { thresholdDb?: number; minSilenceSec?: number; paddingSec?: number },
        outName?: string,
        overwrite?: boolean,
      ) => command("audio_editor_remove_silence", { source, ...options, outName, overwrite }),
      enhanceVoice: (source: string, outName?: string, overwrite?: boolean) =>
        command("audio_editor_enhance_voice", { source, outName, overwrite }),
      cancel: () => command<void>("audio_editor_cancel"),
      onProgress: (callback: (progress: AudioEditorProgress) => void) =>
        getCurrentWebview().listen<AudioEditorProgress>("audio-editor-progress", (event) =>
          callback(event.payload),
        ),
    },
    liveTranslation: {
      getProviderConfig: async () => getLiveTranslationProviderConfig(),
      saveProviderConfig: async (config) => saveLiveTranslationProviderConfig(config),
      permissions: () => command<LivePermissionStatus>("live_translation_permissions"),
      requestPermission: (kind) => command<LivePermissionStatus>("live_translation_request_permission", { kind }),
      openPrivacyPane: (kind) => command<void>("live_translation_open_privacy_pane", { kind }),
      vaultAccessCheck: () => command<VaultAccessReport>("vault_access_check"),
      vaultRepairConsent: () => command<boolean>("vault_repair_folder_consent"),
      audioDevices: () => command<AudioDevicesSnapshot>("live_translation_audio_devices"),
      start: (request: LiveStartRequest) => command<LiveTranslationSnapshot>("live_translation_start", { request }),
      pause: () => command<LiveTranslationSnapshot>("live_translation_pause"),
      resume: (request: LiveResumeRequest) => command<LiveTranslationSnapshot>("live_translation_resume", { request }),
      setMode: (request: LiveSetModeRequest) => command<LiveTranslationSnapshot>("live_translation_set_mode", { request }),
      setSources: (request) => command<LiveTranslationSnapshot>("live_translation_set_sources", { request }),
      waveformPeaks: (src, recordId) => command<{ peaks: number[]; durationMs: number }>("local_audio_waveform", { src, recordId }),
      marker: (kind, note, id, remove) => command<LiveTranslationSnapshot>("live_translation_marker", { kind, note, id, remove }),
      stop: () => command<void>("live_translation_stop"),
      getState: () => command<LiveTranslationSnapshot>("live_translation_state"),
      finalizeLocal: (sessionId, synced) => command<void>("live_translation_finalize_local", { sessionId, synced }),
      setCloudFileId: (sessionId, cloudFileId) =>
        command<void>("live_translation_set_cloud_file_id", { sessionId, cloudFileId }),
      discard: (sessionId) => command<void>("live_translation_discard", { sessionId }),
      listRecoveries: () => command<LiveRecoverySummary[]>("live_translation_recoveries"),
      recover: (sessionId) => command<CompletedLiveSession>("live_translation_recover", { sessionId }),
      discardRecovery: (sessionId) => command<void>("live_translation_discard_recovery", { sessionId }),
      reprocess: (sessionId: string) =>
        command<Record<string, unknown>>("live_translation_reprocess", { sessionId }),
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
    appInfo: { version: "0.1.0", build: null, platform: "darwin", sandboxed: false },
    app: {
      // The permission onboarding carries one more row than the dashboard
      // face was sized for, so it opens with the window enlarged and hands
      // the exact previous frame back on exit. A maximized/fullscreen window
      // is left alone; an already-roomy frame is not shrunk either.
      enterOnboardingWindowSize: async () => {
        const win = getCurrentWindow();
        try {
          if (await win.isMaximized().catch(() => false)) return;
          if (await win.isFullscreen().catch(() => false)) return;
          const scale = await win.scaleFactor();
          const outer = await win.outerSize();
          const frame = { width: outer.width / scale, height: outer.height / scale };
          if (frame.width >= 1100 && frame.height >= 800) return;
          savedOnboardingFrame = frame;
          await win.setSize(new LogicalSize(1100, 800));
          await win.center();
        } catch {
          savedOnboardingFrame = null;
        }
      },
      exitOnboardingWindowSize: async () => {
        const saved = savedOnboardingFrame;
        savedOnboardingFrame = null;
        if (!saved) return;
        const win = getCurrentWindow();
        try {
          await win.setSize(new LogicalSize(saved.width, saved.height));
          await win.center();
        } catch {
          // Window gone (quit mid-onboarding) — nothing to restore.
        }
      },
      getInfo: () =>
        command<{
          version: string;
          build: string | null;
          platform: string;
          sandboxed: boolean;
        }>("get_app_info"),
      // Opens (or focuses) the standalone About window. The localized title
      // is passed in because only the frontend knows the active locale.
      openAboutWindow: (title?: string) =>
        command<void>("open_about_window", { title: title ?? null }),
      // Opens (or focuses) the standalone feature-request window hosting the
      // FeedLog widget. Same localized-title convention as openAboutWindow.
      openFeedbackWindow: (title?: string) =>
        command<void>("open_feedback_window", { title: title ?? null }),
      openReportWindow: (title?: string) =>
        command<void>("open_report_window", { title: title ?? null }),
      captureScreenshot: async () => {
        const screenshot = await command<{ path: string; url: string }>("report_capture_main_screenshot");
        const prefix = "local-media://localhost/";
        // WebView2 serves custom protocols through http(s)://<scheme>.localhost.
        // Convert the decoded asset ID, not the on-disk path or an encoded URL.
        return {
          ...screenshot,
          url: screenshot.url.startsWith(prefix)
            ? convertFileSrc(decodeURIComponent(screenshot.url.slice(prefix.length)), "local-media")
            : screenshot.url,
        };
      },
      submitCnbIssue: (req: {
        endpoint: string;
        title: string;
        body: string;
        screenshotPath?: string | null;
      }) =>
        command<{ number: number }>("report_submit_cnb_issue", {
          req: {
            endpoint: req.endpoint,
            title: req.title,
            body: req.body,
            screenshotPath: req.screenshotPath ?? null,
          },
        }),
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
      // tauri.conf.json; releases are published to CloudBase by
      // scripts/publish-cloudbase.sh. `check()`
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
          releaseNotesByLocale: normalizeReleaseNotesLocales(update.rawJson.notes_i18n),
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
    // Pre-auth compact welcome window (690×450) vs dashboard size — see
    // the Rust command for the shape table.
    setCompactWindowSize: (active: boolean) =>
      command<void>("set_compact_window_mode", { active }),
    // WeChat OAuth sign-in window: the authorize page opens in an embedded
    // window and the code+state redirect is relayed back as a URL event.
    wechat: {
      openAuthWindow: (url: string) => command<void>("wechat_auth_window", { url }),
      closeAuthWindow: () => command<void>("wechat_auth_window_close"),
      onAuthCallback: (callback: (callbackUrl: string) => void) =>
        getCurrentWebview().listen<string>("wechat-auth-callback", (event) =>
          callback(event.payload),
        ),
    },
  },
    attachment: {
      saveBytes: async (bytes, fileName) => {
        const target = await save({ defaultPath: fileName });
        if (!target) return null;
        await command("workbuddy_cloud_save_bytes", { bytes, path: target });
        await revealItemInDir(target);
        return { path: target };
      },
      // Native "where to save" dialog first; the picked path goes to Rust
      // for the fetch + write, then the file is revealed in the manager.
      save: async (url, fileName) => {
        const target = await save({ defaultPath: fileName });
        if (!target) return null;
        const { path } = await command<{ path: string }>("attachment_save", {
          url,
          path: target,
        });
        await revealItemInDir(path);
        return { path };
      },
      text: (url) => command<string>("attachment_text", { url }),
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
      openVaultFolder: () => command("vault_open_folder"),
      onSyncProgress: (callback) =>
        getCurrentWebview().listen<VaultSyncProgress>("vault-sync-progress", (event) =>
          callback(event.payload),
        ),
    },
    todo: {
      list: () => command("todo_list"),
      capabilities: () => command("todo_capabilities"),
      statusAction: (id: string, request: unknown) => command("todo_status_action", { id, request }),
      save: (todo: unknown) => command("todo_save", { todo }),
      delete: (id: string) => command("todo_delete", { id }),
      addToCalendar: (id: string, title: string, sourceTitle: string | null, startAt: string, endAt: string, confirmed: boolean) =>
        command("todo_add_to_calendar", { todoId: id, title, sourceTitle, startAt, endAt, confirmed }),
    },
    inspiration: {
      list: () => command("inspiration_list"),
      read: (id: string) => command("inspiration_private_read", { id }),
      pickFiles: async () => { const selected = await open({ multiple: true, directory: false }); return Array.isArray(selected) ? selected : selected ? [selected] : []; },
      stageFile: (path: string) => command("inspiration_stage_file", { path }),
      exportFile: async (id: string, file: string, name: string) => {
        const destination = await save({ defaultPath: name });
        if (!destination) return false;
        await command("inspiration_export_file", { id, file, destination });
        return true;
      },
      privacy: {
        status: () => command("inspiration_vault_status"),
        confirmRecovery: () => command<void>("inspiration_vault_confirm_recovery"),
        initialize: (password: string) => command("inspiration_vault_initialize", { password }),
        unlock: async (password: string) => {
          const result = await command("inspiration_vault_unlock", { password });
          try { await command("inspiration_vault_refresh", { password }); }
          catch (error) { if (String(error) !== "cloud_offline") { await command("inspiration_vault_lock"); throw error; } }
          return result;
        },
        lock: () => command<void>("inspiration_vault_lock"),
        touch: () => command<void>("inspiration_vault_touch"),
        changePassword: (password: string) => command<void>("inspiration_vault_change_password", { password }),
        recover: (password: string, recoveryCode: string) => command("inspiration_vault_recover", { password, recoveryCode }),
        toggle: (id: string) => command("inspiration_toggle_protection", { id }),
        requestDevice: (password: string) => command("inspiration_vault_pair_request", { password }),
        approveDevice: (requestId: string, expectedFingerprint: string) => command("inspiration_vault_pair_approve", { requestId, expectedFingerprint }),
        finishDevice: (requestId: string, password: string) => command("inspiration_vault_pair_finish", { requestId, password }),
        devices: () => command("inspiration_vault_devices"),
        rotate: (revoke: string[], password: string, fullReencrypt: boolean) => command("inspiration_vault_rotate", { revoke, password, fullReencrypt }),
        legacy: () => command("inspiration_legacy_status"),
        claimLegacy: () => command("inspiration_claim_legacy", { acknowledge: true }),
        onLocked: (callback: () => void) => getCurrentWebview().listen("inspiration-vault-locked", () => callback()),
      },
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
      cloudBind: (userId: string, apiBase: string, token: string, backendHost: string) =>
        command("inspiration_cloud_bind", { userId, apiBase, token, backendHost }),
      cloudUnbind: () => command<void>("inspiration_cloud_unbind"),
      cloudStatus: () => command("inspiration_cloud_status"),
      cloudSync: (token: string) => command("inspiration_cloud_sync", { token }),
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
    storage: {
      usage: () => command("storage_usage"),
      reveal: (category: string) => command("storage_reveal", { category }),
      clear: (category: string) => command("storage_clear", { category }),
    },
    feishu: {
      getConfig: () => command<FeishuConfig>("feishu_config_get"),
      saveConfig: (config: FeishuConfig, secret?: string | null) =>
        command<FeishuConfig>("feishu_config_save", { config, secret: secret ?? null }),
      start: () => command<FeishuStatus>("feishu_bot_start"),
      stop: () => command<FeishuStatus>("feishu_bot_stop"),
      state: () => command<FeishuStatus>("feishu_state"),
      testConnection: () =>
        command<{ ok: boolean; botName: string; openId: string }>("feishu_test_connection"),
      listChats: () => command<FeishuChatSummary[]>("feishu_list_chats"),
      sendText: (text: string, chatId?: string) =>
        command("feishu_send_text", { text, chatId: chatId ?? null }),
      sendSummaryCard: (payload: { title: string; summary: string; fileId?: string }) =>
        command("feishu_send_summary_card", {
          title: payload.title,
          summary: payload.summary,
          fileId: payload.fileId ?? null,
        }),
      registerBegin: (options?: { name?: string; desc?: string }) =>
        command<FeishuRegistrationStart>("feishu_register_begin", {
          name: options?.name ?? null,
          desc: options?.desc ?? null,
        }),
      registerPoll: () => command<FeishuRegistrationPoll>("feishu_register_poll"),
      registerCancel: () => command("feishu_register_cancel"),
      onState: (callback: (status: FeishuStatus) => void) =>
        getCurrentWebview().listen<FeishuStatus>("feishu-state", (event) =>
          callback(event.payload),
        ),
    },
    bots: {
      config: (channel: string) => command("bot_config_get", { channel }),
      save: (channel: string, config: BotChannelConfig, secret?: string | null) =>
        command("bot_config_save", { channel, config, secret: secret ?? null }),
      reset: (channel: string) => command("bot_reset", { channel }),
      start: (channel: string) => command("bot_start", { channel }),
      stop: (channel: string, reason?: string) =>
        command("bot_stop", { channel, reason: reason ?? null }),
      state: (channel: string) => command("bot_state", { channel }),
      outbound: (channel: string): BotOutboundApi | null =>
        channel === "feishu"
          ? {
              replyText: (messageId: string, text: string) =>
                command("feishu_reply_text", { messageId, text }),
              replyMarkdown: (messageId: string, markdown: string) =>
                command("feishu_reply_markdown", { messageId, markdown }),
              updateMarkdownCard: (messageId: string, markdown: string) =>
                command("feishu_update_markdown_card", { messageId, markdown }),
              streamStart: (replyTo: string, markdown: string) =>
                command<{ cardId: string; messageId: string }>("feishu_stream_start", {
                  replyTo,
                  markdown,
                }),
              streamPush: (cardId: string, markdown: string, sequence: number) =>
                command("feishu_stream_push", { cardId, markdown, sequence }),
              streamFinish: (cardId: string, markdown: string, sequence: number) =>
                command("feishu_stream_finish", { cardId, markdown, sequence }),
            }
          : null,
      onEvent: (callback: (event: BotIncomingMessage) => void) =>
        getCurrentWebview().listen<BotIncomingMessage>("bot-event", (event) =>
          callback(event.payload),
        ),
    },
  };

  (window as Window & { desktopAPI?: DesktopApi }).desktopAPI = desktopAPI;
  await installDesktopMcpBridge();

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
