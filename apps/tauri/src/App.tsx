import { lazy, Suspense } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { Toaster } from "@lynse/ui/components/ui/sonner";
import { AuthGate } from "@lynse/views/auth/auth-gate";
import { featureFlags, configureBuildChannel, type BuildChannel } from "@lynse/views/feature-flags";
import { useNavigation } from "@lynse/views/navigation";
import { WorkbenchSupervisor } from "@lynse/views/workbench/supervisor";
import { useWorkbench } from "@lynse/views/workbench/api";
import { InspirationPrivacySupervisor } from "@lynse/views/inspiration/privacy-supervisor";
import { ContextInboxNotifier } from "@lynse/views/notifications/context-inbox";
import { useWebdavAutoSync } from "@lynse/views/settings/webdav-sync";
import { BotAuthSupervisor } from "@lynse/views/bots/auth-supervisor";
import { RESOURCES } from "@lynse/views/locales";
import { DesktopNavigationProvider } from "./platform/navigation";
import { NativeThemeSync } from "./platform/native-theme";
import { AppThemeSync } from "@lynse/views/settings/app-theme";
import { useMaximized } from "@lynse/views/layout/use-maximized";
import { secureStorage } from "./secure-storage";
import { setReportChannel } from "@lynse/views/diagnostics";
import type { DesktopApi } from "./tauri-bridge";
import { Loading } from "./Loading";
import { withPrivatePluginLocales } from "./private-plugins";

const resources = withPrivatePluginLocales(RESOURCES);

// Legacy feature-exposure overrides do not select login methods or servers.
// Development and packaged apps share the standard default.
configureBuildChannel(
  (import.meta.env.VITE_BUILD_CHANNEL as BuildChannel | undefined) ??
    "official",
);
// Problem-report channel: submitted reports are filed as CNB issues by the
// CloudBase `cnb-report` function (the CNB token lives in the function's env
// config, never in the client). The deployed function URL is the default;
// VITE_CNB_REPORT_URL overrides it for dev/staging.
const DEFAULT_REPORT_ENDPOINT =
  "https://lynse-d8g49o1i956741f9e.service.tcloudbase.com/cnb-report";
setReportChannel({
  endpoint: import.meta.env.VITE_CNB_REPORT_URL || DEFAULT_REPORT_ENDPOINT,
});

const Dashboard = lazy(() => import("./Dashboard"));
const ApiConfigPage = lazy(() => import("@lynse/views/auth/api-config-page").then(({ ApiConfigPage }) => ({ default: ApiConfigPage })));
const WorkbenchDialog = lazy(() => import("@lynse/views/workbench/components").then(({ WorkbenchDialog }) => ({ default: WorkbenchDialog })));
const RecordingIslandWindow = lazy(() => import("@lynse/views/live-translation/recording-island-window").then(({ RecordingIslandWindow }) => ({ default: RecordingIslandWindow })));
const LiveSubtitleOverlay = lazy(() => import("@lynse/views/live-translation/subtitle-overlay").then(({ LiveSubtitleOverlay }) => ({ default: LiveSubtitleOverlay })));
const AboutWindow = lazy(() => import("@lynse/views/about/about-window").then(({ AboutWindow }) => ({ default: AboutWindow })));
const FeedbackWindow = lazy(() => import("@lynse/views/feedback/feedback-window").then(({ FeedbackWindow }) => ({ default: FeedbackWindow })));
const ReportProblemWindow = lazy(() => import("@lynse/views/report-problem-dialog").then(({ ReportProblemWindow }) => ({ default: ReportProblemWindow })));

function AppShell() {
  const { pathname } = useNavigation();
  if (pathname.startsWith("/api-config")) {
    return <Suspense fallback={<Loading />}><ApiConfigPage /></Suspense>;
  }
  return (
    <AuthGate>
      <Suspense fallback={<Loading />}><Dashboard /></Suspense>
    </AuthGate>
  );
}

function WorkbenchPanel() {
  const open = useWorkbench((state) => state.open);
  return open ? <Suspense><WorkbenchDialog /></Suspense> : null;
}

function MainWindow() {
  useWebdavAutoSync();
  useMaximized();
  return (
    <DesktopNavigationProvider>
      {/* Supervisors also handle logout, after the dashboard has unmounted. */}
      <BotAuthSupervisor />
      <WorkbenchSupervisor />
      {featureFlags.inspiration && <InspirationPrivacySupervisor />}
      <WorkbenchPanel />
      <ContextInboxNotifier />
      <AppShell />
    </DesktopNavigationProvider>
  );
}

function renderWindow(kind: string | null) {
  switch (kind) {
    case "recording-island": return <RecordingIslandWindow />;
    case "live-subtitles": return <LiveSubtitleOverlay />;
    case "about": return <AboutWindow />;
    case "feedback": return <FeedbackWindow getStoredValue={secureStorage.getItem} />;
    case "report": return <ReportProblemWindow />;
    default: {
      const desktop = (window as Window & { desktopAPI?: DesktopApi }).desktopAPI;
      return (
        <CoreProvider
          apiBaseUrl={import.meta.env.VITE_API_URL}
          wsUrl={import.meta.env.VITE_WS_URL}
          storage={secureStorage}
          identity={{ platform: "desktop", version: desktop?.appInfo?.version ?? "0.1.0" }}
          resources={resources}
        >
          <MainWindow />
        </CoreProvider>
      );
    }
  }
}

export default function App() {
  const kind = new URLSearchParams(window.location.search).get("window");
  return (
    <ThemeProvider>
      <NativeThemeSync />
      <AppThemeSync />
      <Suspense>{renderWindow(kind)}</Suspense>
      <Toaster />
    </ThemeProvider>
  );
}
