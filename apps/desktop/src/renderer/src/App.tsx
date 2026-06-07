import { useMemo } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { Toaster } from "@lynse/ui/components/ui/sonner";
import { DashboardLayout } from "@lynse/views/layout";
import { RecordingsPage } from "@lynse/views/recordings";
import { DesktopNavigationProvider } from "./platform/navigation";

function AppContent() {
  return (
    <DesktopNavigationProvider>
      <DashboardLayout>
        <RecordingsPage />
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
        resources={{}}
      >
        <AppContent />
      </CoreProvider>
      <Toaster />
    </ThemeProvider>
  );
}
