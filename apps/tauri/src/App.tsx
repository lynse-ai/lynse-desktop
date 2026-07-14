import { useMemo } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { Toaster } from "@lynse/ui/components/ui/sonner";
import { DashboardLayout, SidebarToolbar } from "@lynse/views/layout";
import { useNavigation } from "@lynse/views/navigation";
import { WorkspaceLayout } from "@lynse/views/workspace";
import { ChatPage } from "@lynse/views/chat";
import { TodoPage } from "@lynse/views/todo";
import { RESOURCES } from "@lynse/views/locales";
import { DesktopNavigationProvider } from "./platform/navigation";
import lynseWordmark from "./assets/lynse-wordmark.png";

function PageRouter() {
  const { pathname } = useNavigation();
  if (pathname.startsWith("/chat")) return <ChatPage />;
  if (pathname.startsWith("/todo")) return <TodoPage />;
  return <WorkspaceLayout />;
}

function AppContent() {
  return (
    <DesktopNavigationProvider>
      <DashboardLayout
        topSlot={
          <div className="bg-sidebar" data-tauri-drag-region>
            <SidebarToolbar />
            <div className="flex h-7 items-center px-3">
              <img
                src={lynseWordmark}
                alt="Lynse"
                className="h-3.5 w-auto select-none opacity-80 dark:invert"
                draggable={false}
              />
            </div>
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
