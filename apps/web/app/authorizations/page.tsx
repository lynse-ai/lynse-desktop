import { AuthorizationsView, DeviceAuthorizationView } from "@lynse/views/mcp-authorizations";
import DashboardShell from "../(dashboard)/layout";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ device?: string | string[]; user_code?: string | string[] }>;
}) {
  const { device, user_code } = await searchParams;
  if (device === "1" || typeof user_code === "string") {
    return (
      <DeviceAuthorizationView
        codeLength={8}
        logoSrc={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/lynse-device-mark.png`}
      />
    );
  }
  return (
    <DashboardShell>
      <AuthorizationsView />
    </DashboardShell>
  );
}
