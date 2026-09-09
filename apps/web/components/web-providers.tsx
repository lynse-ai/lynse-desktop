"use client";

import { useMemo } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { configureWechatLogin } from "@lynse/core/auth/wechat";
import {
  configureBuildChannel,
  type BuildChannel,
} from "@lynse/views/feature-flags";
import { WebNavigationProvider } from "@/platform/navigation";
import { RESOURCES } from "@lynse/views/locales";
import packageJson from "../package.json";

const WEB_VERSION = packageJson.version || "dev";

// Channel (github | testflight) and the WeChat Open Platform appid are
// injected at build time; see apps/web/.env.example.
configureBuildChannel(
  (process.env.NEXT_PUBLIC_BUILD_CHANNEL as BuildChannel | undefined) ?? "github",
);
configureWechatLogin({
  appId: process.env.NEXT_PUBLIC_WECHAT_APP_ID ?? "",
});

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
      resources={RESOURCES}
    >
      <WebNavigationProvider>{children}</WebNavigationProvider>
    </CoreProvider>
  );
}
