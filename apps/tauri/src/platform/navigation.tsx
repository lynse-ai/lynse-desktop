import { useMemo, useState, type ReactNode } from "react";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@lynse/views/navigation";

export function DesktopNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [pathname, setPathname] = useState("/recordings");

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
