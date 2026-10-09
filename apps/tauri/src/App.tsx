import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CoreProvider } from "@lynse/core/platform";
import { ThemeProvider } from "@lynse/ui/components/common/theme-provider";
import { Toaster } from "@lynse/ui/components/ui/sonner";
import { DashboardLayout } from "@lynse/views/layout";
import { useNavigation } from "@lynse/views/navigation";
import { WorkspaceLayout } from "@lynse/views/workspace";
import { HomePage } from "@lynse/views/home";
import { ChatPage } from "@lynse/views/chat";
import { TodoPage } from "@lynse/views/todo";
import { NotesPage } from "@lynse/views/notes";
import { InspirationCaptureSheet, InspirationPage } from "@lynse/views/inspiration";
import { NotificationsPage, AppUpdateNotifier, ContextInboxNotifier } from "@lynse/views/notifications";
import { DevicesPage } from "@lynse/views/devices";
import { SettingsDialog, useWebdavAutoSync } from "@lynse/views/settings";
import { AboutWindow } from "@lynse/views/about";
import { FeedbackWindow } from "@lynse/views/feedback";
import { BotAgent, BotAuthSupervisor } from "@lynse/views/bots";
import { PluginHost } from "@lynse/views/plugins";
import { AudioEditorPage } from "@lynse/views/audio-editor";
import {
  LiveSubtitleOverlay,
  MeetingAutoRecordAgent,
  RecordingIslandWindow,
  RecordingTrayAgent,
  TranscriptDetailPage,
} from "@lynse/views/live-translation";
import { RESOURCES } from "@lynse/views/locales";
import {
  configureBuildChannel,
  type BuildChannel,
} from "@lynse/views/feature-flags";
import { featureFlags } from "@lynse/views/feature-flags";
import { AuthGate, ApiConfigPage } from "@lynse/views/auth";
import { PermissionOnboardingGate } from "@lynse/views/onboarding";
import { configureWechatLogin } from "@lynse/core/auth/wechat";
import { useMaximized } from "@lynse/views/layout";
import { cn } from "@lynse/ui/lib/utils";
import { DesktopNavigationProvider } from "./platform/navigation";
import { NativeThemeSync } from "./platform/native-theme";
import { AppThemeSync } from "@lynse/views/settings/app-theme";
import { clearAuthSecrets, secureStorage } from "./secure-storage";

// Build channel (official | debug) + WeChat Open Platform appid, injected
// by Vite at build time — see apps/tauri/.env.example. Unset builds are
// OFFICIAL when packaged (the distributable default) and DEBUG in dev.
configureBuildChannel(
  (import.meta.env.VITE_BUILD_CHANNEL as BuildChannel | undefined) ??
    (import.meta.env.PROD ? "official" : "debug"),
);
configureWechatLogin({
  appId: import.meta.env.VITE_WECHAT_APP_ID ?? "",
  // The desktop app can't be a WeChat redirect target; send the QR page to
  // the web app's callback, which publishes the session for the desktop poll.
  redirectOrigin: import.meta.env.VITE_WEB_APP_URL ?? "",
});

// How long the recording page's slide layers stay mounted — must cover the
// longer slide duration in globals.css (300ms in / 260ms out).
const RECORDING_SLIDE_HOLD_MS = 320;

function PageRouter() {
  const { pathname, push } = useNavigation();

  let page: ReactNode = <WorkspaceLayout />;
  let route = "workspace";
  if (pathname === "/" || pathname.startsWith("/home")) {
    page = <HomePage />;
    route = "home";
  } else if (pathname.startsWith("/chat")) {
    page = <ChatPage />;
    route = "chat";
  } else if (pathname.startsWith("/todo")) {
    page = <TodoPage />;
    route = "todo";
  } else if (pathname.startsWith("/recording")) {
    page = <TranscriptDetailPage />;
    route = "recording";
  } else if (pathname.startsWith("/settings")) {
    // Settings is shown in a popup dialog, not an inline page. Visiting the
    // /settings route pops the dialog (closing it navigates back to the workspace).
    page = <SettingsDialog open onOpenChange={() => push("/")} />;
    route = "settings";
  } else if (featureFlags.inspiration && pathname.startsWith("/inspiration")) {
    page = <InspirationPage />;
    route = "inspiration";
  } else if (pathname.startsWith("/notifications")) {
    page = <NotificationsPage />;
    route = "notifications";
  } else if (featureFlags.devices && pathname.startsWith("/devices")) {
    page = <DevicesPage />;
    route = "devices";
  } else if (pathname.startsWith("/audio-editor")) {
    page = <AudioEditorPage />;
    route = "audio-editor";
  } else if (pathname.startsWith("/notes")) {
    page = <NotesPage />;
    route = "notes";
  }
  // Flag-gated WIP features fall through to the workspace above, so a stale
  // link can't reach the unfinished page.

  // ── Recording page sheet choreography ──
  // The recording page is the app's pushed surface: it slides in from the
  // right edge when opened (sidebar / float dock / tray) and slides back out
  // to the right when the user leaves it — typically right after a recording
  // has ended. The page on the other side holds still beneath the sheet, so
  // the motion reads as slide-over / reveal. Every other route keeps the
  // plain fade-up swap.
  const [slide, setSlide] = useState<{
    direction: "in" | "out";
    /** The page held beneath (going in) or the recording page leaving (going out). */
    node: ReactNode;
  } | null>(null);
  const [prevRoute, setPrevRoute] = useState(route);
  const recordingRoute = route === "recording";
  const lastPageRef = useRef({ route, node: page });
  if (prevRoute !== route) {
    // Derived during render (React's adjust-state-on-prop-change pattern) so
    // the swap commits in a single paint — the outgoing page never drops for
    // a frame before the sheet layer takes over.
    const from = prevRoute;
    setPrevRoute(route);
    if (from === "recording") {
      setSlide({ direction: "out", node: lastPageRef.current.node });
    } else if (recordingRoute) {
      setSlide({ direction: "in", node: lastPageRef.current.node });
    } else {
      setSlide(null);
    }
  }
  lastPageRef.current = { route, node: page };

  // Retire the slide layer (and the page held beneath it) once the sheet has
  // landed — must cover the longer slide duration in globals.css.
  useEffect(() => {
    if (!slide) return;
    const timer = setTimeout(() => setSlide(null), RECORDING_SLIDE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [slide]);

  const sheetLeaving = slide?.direction === "out";

  // Keyed by top-level route so switching sidebar destinations (待办 / 笔记 /
  // AI 助手 / …) replays the page-enter animation; sub-navigation within a
  // page (e.g. /chat/<id>) keeps the key and doesn't re-animate.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Base layer — the destination page, or the previous page held still
          while the recording sheet slides over it. */}
      {recordingRoute ? (
        slide?.direction === "in" && (
          <div className="flex min-h-0 flex-1 flex-col">{slide.node}</div>
        )
      ) : (
        <div key={route} className="animate-page-in flex min-h-0 flex-1 flex-col">
          {page}
        </div>
      )}
      {/* The recording sheet itself. It stays mounted in this slot in steady
          state, so the page revealed by the slide-in is the same node that
          keeps rendering — no remount, no replayed entrance. */}
      {(recordingRoute || sheetLeaving) && (
        <div
          className={cn(
            "absolute inset-0 z-10 flex min-h-0 flex-col bg-background",
            sheetLeaving ? "animate-page-out-right" : "animate-page-in-right",
          )}
        >
          {recordingRoute ? page : slide?.node}
        </div>
      )}
    </div>
  );
}

function AppShell() {
  const { pathname } = useNavigation();

  // API configuration is reachable pre-login from the login page's corner
  // link, so it must bypass the auth gate.
  if (pathname.startsWith("/api-config")) {
    return <ApiConfigPage />;
  }

  return (
    <AuthGate>
      {/* First-launch permission onboarding (desktop only): holds the whole
          shell — recording agents included — until mic/system-audio setup is
          answered, so nothing starts recording behind the user's back. */}
      <PermissionOnboardingGate>
        <DashboardLayout>
          <PageRouter />
        </DashboardLayout>
        {/* Answers the tray menu's "start live recording" no matter which page
            is open; the island answers tray pause/stop while a session runs. */}
        <RecordingTrayAgent />
        {/* Answers IM chat messages (Feishu today; DingTalk next) through the
            Rust bot long connection — headless, works with any page open or the
            window hidden. */}
        <BotAgent />
        {/* Headless plugin subscribers (event listeners) for installed + enabled
            plugins; renders nothing until a plugin contributes one. */}
        <PluginHost />
        {/* Starts/stops a recording when the Rust meeting detector spots a
            whitelisted meeting app doing audio (user opt-in from Settings). */}
        {featureFlags.autoRecord && <MeetingAutoRecordAgent />}
        {/* Pops the flomo-style capture panel over any page (sidebar icon,
            home quick actions). */}
        {featureFlags.inspiration && <InspirationCaptureSheet />}
        <AppUpdateNotifier />
      </PermissionOnboardingGate>
    </AuthGate>
  );
}

function AppContent() {
  // Launch-time + periodic WebDAV sync of records and settings (no-op unless
  // enabled in settings; main window only).
  useWebdavAutoSync();
  return (
    <DesktopNavigationProvider>
      {/* Bot channel lifecycle (pause on logout, resume on login) must sit
          OUTSIDE the AuthGate: after logout the gate unmounts its children,
          and this supervisor is what stops the bots and aborts in-flight
          answers. */}
      <BotAuthSupervisor />
      <ContextInboxNotifier />
      <AppShell />
    </DesktopNavigationProvider>
  );
}

export default function App() {
  const windowKind = new URLSearchParams(window.location.search).get("window");
  const subtitleWindow = windowKind === "live-subtitles";
  const recordingIslandWindow = windowKind === "recording-island";
  const aboutWindow = windowKind === "about";
  const feedbackWindow = windowKind === "feedback";
  const identity = useMemo(() => {
    const appInfo = (window as unknown as { desktopAPI?: { appInfo?: { version: string } } })
      .desktopAPI?.appInfo;
    return { platform: "desktop" as const, version: appInfo?.version ?? "0.1.0" };
  }, []);

  // Reflect the main window's maximized state on <html> so layout CSS can keep
  // a comfortable reading column when the window is maximized.
  useMaximized();

  return (
    <ThemeProvider>
      {/* Keep the native window material (vibrancy) on the appearance and
          repaint the per-mode appearance customization on every flip — both
          key off the resolved light/dark, not the system's. Every window kind
          renders inside ThemeProvider, so the island and subtitle overlay
          sync too. */}
      <NativeThemeSync />
      <AppThemeSync />
      {recordingIslandWindow ? (
        <RecordingIslandWindow />
      ) : subtitleWindow ? (
        <LiveSubtitleOverlay />
      ) : aboutWindow ? (
        <AboutWindow />
      ) : feedbackWindow ? (
        <FeedbackWindow getStoredValue={(key) => secureStorage.getItem(key)} />
      ) : (
        <CoreProvider
          apiBaseUrl={import.meta.env.VITE_API_URL}
          wsUrl={import.meta.env.VITE_WS_URL}
          storage={secureStorage}
          identity={identity}
          resources={RESOURCES}
          onLogout={() => {
            // Logout must not leave credentials in the OS keychain.
            void clearAuthSecrets();
          }}
        >
          <AppContent />
        </CoreProvider>
      )}
      <Toaster />
    </ThemeProvider>
  );
}
