import { useMemo, type ReactNode } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { Toaster } from "@lynse/ui/components/ui/sonner";
import { DashboardLayout } from "@lynse/views/layout";
import { useNavigation } from "@lynse/views/navigation";
import { WorkspaceLayout } from "@lynse/views/workspace";
import { ChatPage } from "@lynse/views/chat";
import { TodoPage } from "@lynse/views/todo";
import { NotesPage } from "@lynse/views/notes";
import { InspirationCaptureSheet, InspirationPage } from "@lynse/views/inspiration";
import { NotificationsPage, AppUpdateNotifier } from "@lynse/views/notifications";
import { DevicesPage } from "@lynse/views/devices";
import { SettingsDialog, useWebdavAutoSync } from "@lynse/views/settings";
import {
  LiveSubtitleOverlay,
  RecordingIslandWindow,
  RecordingTrayAgent,
  TranscriptDetailPage,
} from "@lynse/views/live-translation";
import { RESOURCES } from "@lynse/views/locales";
import { featureFlags } from "@lynse/views/feature-flags";
import { useMaximized } from "@lynse/views/layout";
import { DesktopNavigationProvider } from "./platform/navigation";
import { secureStorage } from "./secure-storage";

function PageRouter() {
  const { pathname, push } = useNavigation();

  let page: ReactNode = <WorkspaceLayout />;
  let route = "workspace";
  if (pathname.startsWith("/chat")) {
    page = <ChatPage />;
    route = "chat";
  } else if (pathname.startsWith("/todo")) {
    page = <TodoPage />;
    route = "todo";
  } else if (pathname.startsWith("/recording")) {
    page = <TranscriptDetailPage />;
    route = "recording";
  } else if (pathname.startsWith("/settings")) {
    // Settings is shown in a popup dialog, not an inline page. Visiting the
    // /settings route pops the dialog (closing it navigates back to the workspace).
    page = <SettingsDialog open onOpenChange={() => push("/")} />;
    route = "settings";
  } else if (featureFlags.inspiration && pathname.startsWith("/inspiration")) {
    page = <InspirationPage />;
    route = "inspiration";
  } else if (pathname.startsWith("/notifications")) {
    page = <NotificationsPage />;
    route = "notifications";
  } else if (featureFlags.devices && pathname.startsWith("/devices")) {
    page = <DevicesPage />;
    route = "devices";
  } else if (pathname.startsWith("/notes")) {
    page = <NotesPage />;
    route = "notes";
  }
  // Flag-gated WIP features fall through to the workspace above, so a stale
  // link can't reach the unfinished page.

  // Keyed by top-level route so switching sidebar destinations (待办 / 笔记 /
  // AI 助手 / …) replays the page-enter animation; sub-navigation within a
  // page (e.g. /chat/<id>) keeps the key and doesn't re-animate.
  return (
    <div key={route} className="animate-page-in flex min-h-0 flex-1 flex-col">
      {page}
    </div>
  );
}

function AppContent() {
  // Launch-time + periodic WebDAV sync of records and settings (no-op unless
  // enabled in settings; main window only).
  useWebdavAutoSync();
  return (
      <DesktopNavigationProvider>
        <DashboardLayout>
          <PageRouter />
        </DashboardLayout>
        {/* Answers the tray menu's "start live recording" no matter which page
            is open; the island answers tray pause/stop while a session runs. */}
        <RecordingTrayAgent />
        {/* Pops the flomo-style capture panel over any page (sidebar icon). */}
        {featureFlags.inspiration && <InspirationCaptureSheet />}
        <AppUpdateNotifier />
      </DesktopNavigationProvider>
  );
}

export default function App() {
  const windowKind = new URLSearchParams(window.location.search).get("window");
  const subtitleWindow = windowKind === "live-subtitles";
  const recordingIslandWindow = windowKind === "recording-island";
  const identity = useMemo(() => {
    const appInfo = (window as unknown as { desktopAPI?: { appInfo?: { version: string } } })
      .desktopAPI?.appInfo;
    return { platform: "desktop" as const, version: appInfo?.version ?? "0.1.0" };
  }, []);

  // Reflect the main window's maximized state on <html> so layout CSS can keep
  // a comfortable reading column when the window is maximized.
  useMaximized();

  return (
    <ThemeProvider>
      {recordingIslandWindow ? (
        <RecordingIslandWindow />
      ) : subtitleWindow ? (
        <LiveSubtitleOverlay />
      ) : (
        <CoreProvider
          apiBaseUrl={import.meta.env.VITE_API_URL}
          wsUrl={import.meta.env.VITE_WS_URL}
          storage={secureStorage}
          identity={identity}
          locale="en"
          resources={RESOURCES}
        >
          <AppContent />
        </CoreProvider>
      )}
      <Toaster />
    </ThemeProvider>
  );
}
