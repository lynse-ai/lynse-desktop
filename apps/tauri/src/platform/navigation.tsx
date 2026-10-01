import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@lynse/views/navigation";

/** Bounded history so a long session can't grow the stack unbounded. */
const MAX_HISTORY = 50;
// The app opens on the Home feed (主页).
const HOME_PATH = "/home";

interface HistoryState {
  entries: string[];
  index: number;
}

export function DesktopNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [history, setHistory] = useState<HistoryState>(() => ({
    entries: [HOME_PATH],
    index: 0,
  }));
  const pathname = history.entries[history.index] ?? HOME_PATH;

  const push = useCallback((path: string) => {
    setHistory((h) => {
      // Re-push of the current route (e.g. sidebar click) must not eat the
      // back stack.
      if (h.entries[h.index] === path) return h;
      const entries = [...h.entries.slice(0, h.index + 1), path].slice(-MAX_HISTORY);
      return { entries, index: entries.length - 1 };
    });
  }, []);

  const replace = useCallback((path: string) => {
    setHistory((h) => {
      const entries = [...h.entries];
      entries[h.index] = path;
      return { ...h, entries };
    });
  }, []);

  const back = useCallback(() => {
    setHistory((h) => (h.index > 0 ? { ...h, index: h.index - 1 } : h));
  }, []);

  const forward = useCallback(() => {
    setHistory((h) =>
      h.index < h.entries.length - 1 ? { ...h, index: h.index + 1 } : h,
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    // Tray actions surface the unified recording / live-translation page.
    // push (not replace) so the title bar's back arrow returns to wherever
    // the user was when the tray fired.
    const openLiveTranslation = () => push("/recording");
    window.addEventListener(
      "lynse:live-translation-tray-action",
      openLiveTranslation,
    );

    // The recording island's "expand" asks the main window (via a broadcast
    // Tauri event, see tauri-bridge openRecordingPage) to land on the
    // recording page — recording is decoupled from the page, so the main
    // window may be sitting on any route when the user taps the island.
    void listen("lynse:open-recording-page", openLiveTranslation).then(
      (cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      },
    );

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(
        "lynse:live-translation-tray-action",
        openLiveTranslation,
      );
    };
  }, [push]);

  const adapter = useMemo<NavigationAdapter>(
    () => ({
      push,
      replace,
      back,
      forward,
      canGoBack: history.index > 0,
      canGoForward: history.index < history.entries.length - 1,
      pathname,
      searchParams: new URLSearchParams(),
      getShareableUrl: (path: string) => path,
    }),
    [push, replace, back, forward, history, pathname],
  );

  return (
    <NavigationProvider value={adapter}>{children}</NavigationProvider>
  );
}
