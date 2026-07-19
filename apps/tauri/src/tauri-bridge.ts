import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setApiTransportMode } from "@lynse/core/api/client";
import { hydrateSecrets } from "./secure-storage";
import type { TranscribeConfig } from "@lynse/views/workspace";

type DesktopApi = {
  openExternal: (url: string) => Promise<void>;
  localTranscription: Record<string, (...args: any[]) => Promise<unknown>>;
  todo: Record<string, (...args: any[]) => Promise<unknown>>;
  appInfo: { version: string; platform: string };
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
      getModelStatus: () => command("local_transcription_model_status"),
      downloadModel: () => command("local_transcription_download_model"),
      deleteModel: () => command("local_transcription_delete_model"),
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
    todo: {
      list: () => command("todo_list"),
      save: (todo: unknown) => command("todo_save", { todo }),
      delete: (id: string) => command("todo_delete", { id }),
      addToCalendar: (id: string, startAt: string, endAt: string, confirmed: boolean) =>
        command("todo_add_to_calendar", { todo_id: id, start_at: startAt, end_at: endAt, confirmed }),
    },
  };

  (window as Window & { desktopAPI?: DesktopApi }).desktopAPI = desktopAPI;
}
