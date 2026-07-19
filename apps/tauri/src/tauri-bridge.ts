import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { setApiTransportMode } from "@lynse/core/api/client";
import { hydrateSecrets } from "./secure-storage";
import type { SttDownloadProgress, SttModelInfo, TranscribeConfig } from "@lynse/views/workspace";

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
