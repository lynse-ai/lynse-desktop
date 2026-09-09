import { useEffect, useMemo, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@lynse/views/navigation";

export function DesktopNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  // The app opens on the Home feed (主页).
  const [pathname, setPathname] = useState("/home");

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    // Tray actions surface the unified recording / live-translation page.
    const openLiveTranslation = () => setPathname("/recording");
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
  }, []);

  const adapter = useMemo<NavigationAdapter>(
    () => ({
      push: (path: string) => setPathname(path),
      replace: (path: string) => setPathname(path),
      back: () => {},
      pathname,
      searchParams: new URLSearchParams(),
      getShareableUrl: (path: string) => path,
    }),
    [pathname],
  );

  return (
    <NavigationProvider value={adapter}>{children}</NavigationProvider>
  );
}
