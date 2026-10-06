export interface NavigationAdapter {
  push(path: string): void;
  replace(path: string): void;
  back(): void;
  /** Move forward again after going back. Only offered by adapters with a real history stack. */
  forward?(): void;
  /**
   * Whether back()/forward() have somewhere to go. Optional — the app title
   * bar treats `undefined` as "assume enabled" (the web adapter can't always
   * know without coupling to the router's internals).
   */
  canGoBack?: boolean;
  canGoForward?: boolean;
  pathname: string;
  searchParams: URLSearchParams;
  openInNewTab?: (path: string, title?: string, opts?: { activate?: boolean }) => void;
  getShareableUrl: (path: string) => string;
  prefetch?: (path: string) => void;
}
