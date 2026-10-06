/**
 * Platform detection shared by views.
 *
 * The Tauri desktop shell injects `window.desktopAPI` (see
 * apps/tauri/src/tauri-bridge.ts); browser shells (apps/web) never do, which
 * is the same signal `inspiration/desktop-api.ts` relies on to degrade.
 */

type DesktopBridgeWindow = Window & {
  desktopAPI?: Record<string, unknown>;
};

/** True when running in a browser shell without the desktop bridge. */
export function isWebPlatform(): boolean {
  return (
    typeof window !== "undefined" &&
    !(window as DesktopBridgeWindow).desktopAPI
  );
}
