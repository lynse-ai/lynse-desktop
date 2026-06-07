import { DashboardLayout } from "@lynse/views/layout";

export default function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
