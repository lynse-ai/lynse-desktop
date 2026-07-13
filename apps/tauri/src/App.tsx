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

function PageRouter() {
  const { pathname } = useNavigation();
  return pathname.startsWith("/chat") ? <ChatPage /> : <WorkspaceLayout />;
}

function AppContent() {
  return (
    <DesktopNavigationProvider>
      <DashboardLayout
        topSlot={
          <div className="flex items-center gap-2 px-3 pt-10 pb-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <span className="text-xs font-bold">L</span>
            </div>
            <span className="text-sm font-semibold tracking-tight">Lynse</span>
          </div>
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
