/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build channel: "official" | "debug" (see .env.example). */
  readonly VITE_BUILD_CHANNEL?: string;
  /** CloudBase cnb-report function URL (defaults to the deployed prod one). */
  readonly VITE_CNB_REPORT_URL?: string;
}
