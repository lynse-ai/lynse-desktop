import { DeviceAuthorizationView } from "@lynse/views/mcp-authorizations";

export default function Page() {
  return (
    <DeviceAuthorizationView
      codeLength={6}
      logoSrc={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/lynse-device-mark.png`}
    />
  );
}
