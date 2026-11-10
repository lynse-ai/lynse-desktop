import { DashboardLayout } from "@lynse/views/layout";
import { AuthGate, AppleFragmentBootstrap } from "@lynse/views/auth";

export default function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  // Startup gate: splash while the session restores, login page when there
  // is none, otherwise the dashboard.
  return (
    <>
      <AppleFragmentBootstrap />
      <AuthGate>
        <DashboardLayout>{children}</DashboardLayout>
      </AuthGate>
    </>
  );
}
