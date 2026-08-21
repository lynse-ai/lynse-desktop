import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@lynse/views/navigation";

export function DesktopNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [pathname, setPathname] = useState("/notes");

  useEffect(() => {
    // Tray actions surface the unified recording / live-translation page.
    const openLiveTranslation = () => setPathname("/recording");
    window.addEventListener(
      "lynse:live-translation-tray-action",
      openLiveTranslation,
    );
    return () => {
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
