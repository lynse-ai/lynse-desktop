"use client";

import { Suspense } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@lynse/views/navigation";

function NavigationProviderInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Next's App Router keeps a monotonically increasing `idx` in history.state;
  // idx > 0 means there is something to go back to. Defensive: state is null
  // on a freshly opened tab.
  const historyIdx =
    typeof window === "undefined" ? 0 : (window.history.state?.idx ?? 0);

  const adapter: NavigationAdapter = {
    push: router.push,
    replace: router.replace,
    back: router.back,
    forward: () => window.history.forward(),
    canGoBack: historyIdx > 0,
    canGoForward:
      typeof window !== "undefined" && historyIdx < window.history.length - 1,
    pathname,
    searchParams: new URLSearchParams(searchParams.toString()),
    getShareableUrl: (path: string) =>
      typeof window === "undefined" ? path : window.location.origin + path,
    prefetch: (path: string) => {
      router.prefetch(path);
    },
  };

  return <NavigationProvider value={adapter}>{children}</NavigationProvider>;
}

export function WebNavigationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense>
      <NavigationProviderInner>{children}</NavigationProviderInner>
    </Suspense>
  );
}
