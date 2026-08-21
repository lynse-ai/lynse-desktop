import { useMemo } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { Toaster } from "@lynse/ui/components/ui/sonner";
import { DashboardLayout } from "@lynse/views/layout";
import { useNavigation } from "@lynse/views/navigation";
import { WorkspaceLayout } from "@lynse/views/workspace";
import { ChatPage } from "@lynse/views/chat";
import { TodoPage } from "@lynse/views/todo";
import { NotesPage } from "@lynse/views/notes";
import { InspirationPage } from "@lynse/views/inspiration";
import { NotificationsPage } from "@lynse/views/notifications";
import { SettingsDialog } from "@lynse/views/settings";
import {
  LiveSubtitleOverlay,
  RecordingIslandWindow,
  TranscriptDetailPage,
} from "@lynse/views/live-translation";
import { RESOURCES } from "@lynse/views/locales";
import { DesktopNavigationProvider } from "./platform/navigation";
import { secureStorage } from "./secure-storage";

function PageRouter() {
  const { pathname, push } = useNavigation();
  if (pathname.startsWith("/chat")) return <ChatPage />;
  if (pathname.startsWith("/todo")) return <TodoPage />;
  if (pathname.startsWith("/recording")) return <TranscriptDetailPage />;
  // Settings is shown in a popup dialog, not an inline page. Visiting the
  // /settings route pops the dialog (closing it navigates back to the workspace).
  if (pathname.startsWith("/settings")) {
    return <SettingsDialog open onOpenChange={() => push("/")} />;
  }
  if (pathname.startsWith("/inspiration")) return <InspirationPage />;
  if (pathname.startsWith("/notifications")) return <NotificationsPage />;
  if (pathname.startsWith("/notes")) return <NotesPage />;
  return <WorkspaceLayout />;
}

function AppContent() {
  return (
    <DesktopNavigationProvider>
      <DashboardLayout>
        <PageRouter />
      </DashboardLayout>
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
