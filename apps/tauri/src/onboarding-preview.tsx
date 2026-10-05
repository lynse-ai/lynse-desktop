// Temporary preview harness for the compact login face, served by
// onboarding-preview.html under `vite dev` — not part of the app bundle.
// Renders the real LoginPage at the packaged compact-window size (690×450).
// Query params: ?lng=zh-Hans&theme=light
import { createRoot } from "react-dom/client";
import { ApiClient } from "@lynse/core/api/client";
import { registerAuthStore, createAuthStore } from "@lynse/core/auth";
import { initI18n } from "@lynse/core/i18n";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { RESOURCES } from "@lynse/views/locales";
import { configureBuildChannel, configureDevApiAuth } from "@lynse/views/feature-flags";
import { LoginPage } from "@lynse/views/auth";
import "./globals.css";

const params = new URLSearchParams(window.location.search);

initI18n({ locale: params.get("lng") ?? undefined, resources: RESOURCES });
// ?channel=debug renders the DEBUG-channel face (API-key form as the main
// sign-in surface, no phone/WeChat); default is official. The dev API entry
// under 更多登录方式 is also exposed for the official face.
configureBuildChannel(params.get("channel") === "debug" ? "debug" : "official");
configureDevApiAuth(true);

// The real app registers the auth store from CoreProvider; the preview has
// no provider, so register a sessionless stub backed by localStorage.
registerAuthStore(
  createAuthStore({
    api: new ApiClient("http://localhost:0"),
    storage: window.localStorage,
    cookieAuth: true,
  }),
);

createRoot(document.getElementById("root")!).render(
  <ThemeProvider
    defaultTheme={params.get("theme") === "dark" ? "dark" : "light"}
    enableSystem={false}
  >
    <LoginPage />
  </ThemeProvider>,
);
