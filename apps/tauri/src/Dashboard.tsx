import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { DashboardLayout } from "@lynse/views/layout";
import { useNavigation } from "@lynse/views/navigation";
import { HomePage } from "@lynse/views/home";
import { InspirationCaptureSheet } from "@lynse/views/inspiration";
import { AppUpdateNotifier } from "@lynse/views/notifications";
import { SettingsDialog } from "@lynse/views/settings";
import { BotAgent } from "@lynse/views/bots";
import { PluginHost } from "@lynse/views/plugins";
import { MeetingAutoRecordAgent, RecordingTrayAgent, TranscriptDetailPage } from "@lynse/views/live-translation";
import { featureFlags } from "@lynse/views/feature-flags";
import { PermissionOnboardingGate } from "@lynse/views/onboarding";
import { cn } from "@lynse/ui/lib/utils";
import { Loading } from "./Loading";

// How long the recording page's slide layers stay mounted — must cover the
// longer slide duration in globals.css (300ms in / 260ms out).
const RECORDING_SLIDE_HOLD_MS = 320;

const ChatPage = lazy(() => import("@lynse/views/chat").then(({ ChatPage }) => ({ default: ChatPage })));
const WorkspaceLayout = lazy(() => import("@lynse/views/workspace/workspace-layout").then(({ WorkspaceLayout }) => ({ default: WorkspaceLayout })));
const NotesPage = lazy(() => import("@lynse/views/notes").then(({ NotesPage }) => ({ default: NotesPage })));
const TodoPage = lazy(() => import("@lynse/views/todo").then(({ TodoPage }) => ({ default: TodoPage })));
const MemoryPage = lazy(() => import("@lynse/views/workbench/page").then(({ MemoryPage }) => ({ default: MemoryPage })));
const AudioEditorPage = lazy(() => import("@lynse/views/audio-editor").then(({ AudioEditorPage }) => ({ default: AudioEditorPage })));
const InspirationPage = lazy(() => import("@lynse/views/inspiration/page").then(({ InspirationPage }) => ({ default: InspirationPage })));
const NotificationsPage = lazy(() => import("@lynse/views/notifications/page").then(({ NotificationsPage }) => ({ default: NotificationsPage })));

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
  } else if (pathname.startsWith("/audio-editor")) {
    page = <AudioEditorPage />;
    route = "audio-editor";
  } else if (pathname.startsWith("/notes")) {
    page = <NotesPage />;
    route = "notes";
  } else if (pathname.startsWith("/memory")) {
    page = <MemoryPage />;
    route = "memory";
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
          <div className="flex min-h-0 flex-1 flex-col"><Suspense>{slide.node}</Suspense></div>
        )
      ) : (
        <div key={route} className="animate-page-in flex min-h-0 flex-1 flex-col">
          <Suspense fallback={<Loading />}>{page}</Suspense>
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

export default function Dashboard() {
  return (
    <PermissionOnboardingGate>
      <DashboardLayout>
        <PageRouter />
      </DashboardLayout>
      <RecordingTrayAgent />
      <BotAgent />
      <PluginHost />
      {featureFlags.autoRecord && <MeetingAutoRecordAgent />}
      {featureFlags.inspiration && <InspirationCaptureSheet />}
      <AppUpdateNotifier />
    </PermissionOnboardingGate>
  );
}
