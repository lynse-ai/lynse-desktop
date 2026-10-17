// Temporary preview harness for the permission onboarding face, served by
// permission-preview.html under `vite dev` — not part of the app bundle.
// Renders the real PermissionOnboarding against a stubbed desktop bridge so
// the optional calendar row can be checked without the Rust host.
// Query params: ?lng=zh-Hans&theme=light&calendar=notDetermined|granted|denied|unsupported
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { initI18n } from "@lynse/core/i18n";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { RESOURCES } from "@lynse/views/locales";
import type { LivePermissionStatus } from "@lynse/views/live-translation";
import { PermissionOnboarding } from "@lynse/views/onboarding";
import "./globals.css";

const params = new URLSearchParams(window.location.search);
const calendarState = params.get("calendar") ?? "notDetermined";

type Perm = LivePermissionStatus;

function makeStatus(calendar: Perm["calendar"]): Perm {
  return {
    microphone: "granted",
    systemAudio: "granted",
    systemAudioRequired: true,
    restartRequired: false,
    calendar,
  };
}

// Mutable stub state the fake requestPermission mutates, mirroring how the
// real command re-reads the OS status after the TCC prompt resolves.
let current = makeStatus(
  calendarState === "unsupported"
    ? undefined
    : (calendarState as NonNullable<Perm["calendar"]>),
);
if (calendarState === "unsupported") current = { ...current, calendar: "unsupported" };

(window as unknown as { desktopAPI: unknown }).desktopAPI = {
  appInfo: { version: "1.1.7", platform: "darwin" },
  liveTranslation: {
    permissions: () => Promise.resolve({ ...current }),
    // Simulate the native prompt: calendar grants on first ask (unless the
    // param says denied), mic/systemAudio are already granted no-ops.
    requestPermission: (kind: string) => {
      if (kind === "calendar" && current.calendar === "notDetermined") {
        current = { ...current, calendar: calendarState === "denied" ? "denied" : "granted" };
      }
      return Promise.resolve({ ...current });
    },
    openPrivacyPane: (kind: string) => {
      // eslint-disable-next-line no-console
      console.info("[preview] openPrivacyPane:", kind);
      if (kind === "calendar") current = { ...current, calendar: "granted" };
      return Promise.resolve();
    },
  },
};

initI18n({ locale: params.get("lng") ?? undefined, resources: RESOURCES });

function Preview() {
  const [finished, setFinished] = useState(false);
  if (finished) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">onFinish fired ✓</p>
      </div>
    );
  }
  return <PermissionOnboarding onFinish={() => setFinished(true)} />;
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider
    defaultTheme={params.get("theme") === "dark" ? "dark" : "light"}
    enableSystem={false}
  >
    <Preview />
  </ThemeProvider>,
);
