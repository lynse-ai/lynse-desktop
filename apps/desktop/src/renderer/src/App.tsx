import { useMemo } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { Toaster } from "@lynse/ui/components/ui/sonner";
import { DashboardLayout } from "@lynse/views/layout";
import { useNavigation } from "@lynse/views/navigation";
import { WorkspaceLayout } from "@lynse/views/workspace";
import { ChatPage } from "@lynse/views/chat";
import { RESOURCES } from "@lynse/views/locales";
import { DesktopNavigationProvider } from "./platform/navigation";

/**
 * Routes pages based on the current navigation pathname.
 * Workspace routes (recordings, meetings, knowledge, files) all share
 * the same three-panel WorkspaceLayout — matching the web app exactly.
 * Settings and Chat remain standalone pages.
 */
function PageRouter() {
  const { pathname } = useNavigation();

  if (pathname.startsWith("/chat")) return <ChatPage />;

  // All workspace routes share the same three-panel layout
  return <WorkspaceLayout />;
}

function AppContent() {
  return (
    <DesktopNavigationProvider>
      <DashboardLayout
        topSlot={
          <div
            className="w-full shrink-0"
            style={{ height: 38, WebkitAppRegion: "drag" } as React.CSSProperties}
          />
        }
      >
        <PageRouter />
      </DashboardLayout>
    </DesktopNavigationProvider>
  );
}

export default function App() {
  const identity = useMemo(
    () => ({ platform: "desktop" as const, version: "0.1.0" }),
    [],
  );

  return (
    <ThemeProvider>
      <CoreProvider
        apiBaseUrl={import.meta.env.VITE_API_URL}
        wsUrl={import.meta.env.VITE_WS_URL}
        identity={identity}
        locale="en"
        resources={RESOURCES}
      >
        <AppContent />
      </CoreProvider>
      <Toaster />
    </ThemeProvider>
  );
}
