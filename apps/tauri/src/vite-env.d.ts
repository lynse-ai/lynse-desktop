/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build channel: "official" | "debug" (see .env.example). */
  readonly VITE_BUILD_CHANNEL?: string;
  /** 微信开放平台「网站应用」appid — enables the PC QR-login authorize URL. */
  readonly VITE_WECHAT_APP_ID?: string;
  /** OAuth redirect_uri under the app's configured 授权回调域. */
  readonly VITE_WECHAT_REDIRECT_URI?: string;
  /** CloudBase cnb-report function URL (defaults to the deployed prod one). */
  readonly VITE_CNB_REPORT_URL?: string;
}
