"use client";

import { useMemo } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { configureLynseSso } from "@lynse/core/auth/lynse-sso";
import {
  configureBuildChannel,
  type BuildChannel,
} from "@lynse/views/feature-flags";
import { WebNavigationProvider } from "@/platform/navigation";
import { RESOURCES } from "@lynse/views/locales";
import packageJson from "../package.json";

const WEB_VERSION = packageJson.version || "dev";

// Channel (official | debug) is injected at build time; see apps/web/.env.example.
// Unset builds are OFFICIAL in production and DEBUG in dev.
configureBuildChannel(
  (process.env.NEXT_PUBLIC_BUILD_CHANNEL as BuildChannel | undefined) ??
    (process.env.NODE_ENV === "production" ? "official" : "debug"),
);

// Account-center SSO (public OAuth client, PKCE only). Both vars must be set
// for the "Sign in with Lynse" entry to appear; the flow returns to
// /auth/sso, which completes the exchange. See apps/web/.env.example.
configureLynseSso(
  process.env.NEXT_PUBLIC_LYNSE_SSO_URL && process.env.NEXT_PUBLIC_LYNSE_SSO_CLIENT_ID
    ? {
        origin: process.env.NEXT_PUBLIC_LYNSE_SSO_URL,
        clientId: process.env.NEXT_PUBLIC_LYNSE_SSO_CLIENT_ID,
        redirectUri:
          process.env.NEXT_PUBLIC_LYNSE_SSO_REDIRECT_URI ||
          `${new URL(process.env.NEXT_PUBLIC_LYNSE_SSO_URL).origin}/auth/sso`,
      }
    : null,
);

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
      analyticsConfig={{
        apiKey: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_KEY,
        apiHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
        platform: "web",
        appVersion: WEB_VERSION,
        enabled: Boolean(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_KEY),
        debug: process.env.NODE_ENV !== "production",
      }}
      telemetryConfig={{
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        release: `lynse-web@${WEB_VERSION}`,
        environment: process.env.NODE_ENV ?? "production",
        enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
        debug: process.env.NODE_ENV !== "production",
      }}
    >
      <WebNavigationProvider>{children}</WebNavigationProvider>
    </CoreProvider>
  );
}
