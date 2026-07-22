import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { setApiTransportMode } from "@lynse/core/api/client";
import { hydrateSecrets, secureStorage } from "./secure-storage";
import type { SttDownloadProgress, SttModelInfo, TranscribeConfig } from "@lynse/views/workspace";
import type {
  CompletedLiveSession,
  DesktopLiveTranslationApi,
  LivePermissionStatus,
  LiveRecoverySummary,
  LiveResumeRequest,
  LiveStartRequest,
  LiveTranslationEvent,
  LiveTranslationProviderConfig,
  LiveTranslationSnapshot,
} from "@lynse/views/live-translation";
import { DEFAULT_ILIVEDATA_RTVT_ENDPOINT } from "@lynse/views/live-translation";

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  publishedAt?: string | null;
};

type DesktopApi = {
  openExternal: (url: string) => Promise<void>;
  localTranscription: Record<string, (...args: any[]) => Promise<unknown>>;
  liveTranslation: DesktopLiveTranslationApi;
  todo: Record<string, (...args: any[]) => Promise<unknown>>;
  appInfo: { version: string; platform: string };
  app: {
    getInfo: () => Promise<{ version: string; platform: string }>;
    checkForUpdate: () => Promise<AppUpdateInfo>;
  };
}

function command<T>(name: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, payload);
}

const LIVE_TRANSLATION_PROVIDER_KEY = "lynse_live_translation_provider";
const ILIVEDATA_ENDPOINT_KEY = "lynse_live_translation_ilivedata_endpoint";
const ILIVEDATA_PID_KEY = "lynse_live_translation_ilivedata_pid";
const ILIVEDATA_SECRET_KEY = "lynse_live_translation_ilivedata_secret_key";

function getLiveTranslationProviderConfig(): LiveTranslationProviderConfig {
  const savedProvider = window.localStorage.getItem(LIVE_TRANSLATION_PROVIDER_KEY);
  return {
    provider: savedProvider === "ilivedata_direct" ? "ilivedata_direct" : "lynse_backend",
    ilivedata: {
      endpoint: window.localStorage.getItem(ILIVEDATA_ENDPOINT_KEY) ?? DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
      pid: window.localStorage.getItem(ILIVEDATA_PID_KEY) ?? "",
      secretKey: secureStorage.getItem(ILIVEDATA_SECRET_KEY) ?? "",
    },
  };
}

function saveLiveTranslationProviderConfig(
  config: LiveTranslationProviderConfig,
): LiveTranslationProviderConfig {
  const normalized: LiveTranslationProviderConfig = {
    provider: config.provider,
    ilivedata: {
      endpoint: config.ilivedata.endpoint.trim() || DEFAULT_ILIVEDATA_RTVT_ENDPOINT,
      pid: config.ilivedata.pid.trim(),
      secretKey: config.ilivedata.secretKey.trim(),
    },
  };
  window.localStorage.setItem(LIVE_TRANSLATION_PROVIDER_KEY, normalized.provider);
  window.localStorage.setItem(ILIVEDATA_ENDPOINT_KEY, normalized.ilivedata.endpoint);
  window.localStorage.setItem(ILIVEDATA_PID_KEY, normalized.ilivedata.pid);
  if (normalized.ilivedata.secretKey) {
    secureStorage.setItem(ILIVEDATA_SECRET_KEY, normalized.ilivedata.secretKey);
  } else {
    secureStorage.removeItem(ILIVEDATA_SECRET_KEY);
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
      stop: () => command<CompletedLiveSession>("live_translation_stop"),
      getState: () => command<LiveTranslationSnapshot>("live_translation_state"),
      finalizeLocal: (sessionId, synced) => command<void>("live_translation_finalize_local", { sessionId, synced }),
      listRecoveries: () => command<LiveRecoverySummary[]>("live_translation_recoveries"),
      recover: (sessionId) => command<CompletedLiveSession>("live_translation_recover", { sessionId }),
      showSubtitles: (show) => command<void>("live_translation_show_subtitles", { show }),
      onEvent: (callback: (event: LiveTranslationEvent) => void) =>
        getCurrentWebview().listen<LiveTranslationEvent>("live-translation-event", (event) => callback(event.payload)),
    },
    appInfo: { version: "0.1.0", platform: "darwin" },
    app: {
      getInfo: () => command<{ version: string; platform: string }>("get_app_info"),
      checkForUpdate: () => command<AppUpdateInfo>("check_app_update"),
    },
    todo: {
      list: () => command("todo_list"),
      save: (todo: unknown) => command("todo_save", { todo }),
      delete: (id: string) => command("todo_delete", { id }),
      addToCalendar: (id: string, startAt: string, endAt: string, confirmed: boolean) =>
        command("todo_add_to_calendar", { todo_id: id, start_at: startAt, end_at: endAt, confirmed }),
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
