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

// Channel (official | debug) and the WeChat Open Platform appid are injected
// at build time; see apps/web/.env.example. Unset builds are OFFICIAL in
// production and DEBUG in dev.
configureBuildChannel(
  (process.env.NEXT_PUBLIC_BUILD_CHANNEL as BuildChannel | undefined) ??
    (process.env.NODE_ENV === "production" ? "official" : "debug"),
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
      resources={RESOURCES}
    >
      <WebNavigationProvider>{children}</WebNavigationProvider>
    </CoreProvider>
  );
}
