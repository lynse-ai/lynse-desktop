import type { LiveTranslationProviderPlugin } from "./types";

/**
 * Apple on-device live transcription (SpeechAnalyzer/SpeechTranscriber, macOS
 * 26+). Recognition runs INSIDE the capture sidecar — no websocket, no API
 * key, no translation leg (pair with the translation service layer). The
 * protocol tag routes Rust to the local path: the capture process is started
 * with `--analyzer` and its results ride stdout control lines.
 */
export const applePlugin: LiveTranslationProviderPlugin = {
  id: "apple",
  nameKey: "live_translation.provider_apple",
  name: "Apple 原生语音识别（本地）",
  hintKey: "live_translation.apple_hint",
  protocol: "applespeech_local",
  capabilities: { translation: false },
  fields: [
    {
      key: "lingKey",
      kind: "password",
      labelKey: "live_translation.apple_ling_key",
      secret: true,
      required: false,
      placeholder: "sk-...",
    },
  ],
  isConfigured: () => true,
  async buildConnections(ctx) {
    return ctx.sources.map((source) => ({
      source,
      // No websocket URL: Rust skips the connection loop for this protocol.
      url: "",
      provider: "applespeech_local",
      extra: { locale: ctx.sourceLanguage },
    }));
  },
};
