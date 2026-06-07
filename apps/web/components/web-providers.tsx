"use client";

import { useMemo } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { WebNavigationProvider } from "@/platform/navigation";
import packageJson from "../package.json";

const WEB_VERSION = packageJson.version || "dev";

export function WebProviders({ children }: { children: React.ReactNode }) {
  const identity = useMemo(
    () => ({ platform: "web", version: WEB_VERSION }),
    [],
  );

  return (
    <CoreProvider
      apiBaseUrl={process.env.NEXT_PUBLIC_API_URL}
      wsUrl={process.env.NEXT_PUBLIC_WS_URL}
      identity={identity}
      locale="en"
      resources={{}}
    >
      <WebNavigationProvider>{children}</WebNavigationProvider>
    </CoreProvider>
  );
}
