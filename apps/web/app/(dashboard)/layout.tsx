import { DashboardLayout } from "@lynse/views/layout";
import { AuthGate } from "@lynse/views/auth";

export default function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  // Startup gate: splash while the session restores, login page when there
  // is none, otherwise the dashboard.
  return (
    <AuthGate>
      <DashboardLayout>{children}</DashboardLayout>
    </AuthGate>
  );
}
