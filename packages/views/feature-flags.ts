/**
 * Release gates for work-in-progress features.
 *
 * Flip a flag to `true` to expose the feature again (sidebar entry + route).
 * Keep this the single source of truth — every entry point must gate on it so
 * a feature can be shipped or hidden by editing this file only.
 */
export const featureFlags = {
  /** Inspiration page (`/inspiration`) — quick flomo-style capture + feed. */
  inspiration: true,
  /** Devices page (`/devices`) — hidden until the feature is complete. */
  devices: false,
  /** Auto-record detected meetings (desktop only; user opts in from Settings).
   * The headless agent and the settings card gate on this so the feature can
   * be shipped or hidden from here alone. */
  autoRecord: true,
  /** Quick voice-memo capture inside the inspiration popup. Hidden for now —
   * flip to `true` to bring back the mic button and recording UI. */
  inspirationVoiceCapture: false,
  /** Settings → Connections (third-party integrations: calendar, Notion, task
   * tools). Off until the backend's /api/v2/integrations contract is deployed —
   * the rows degrade to a 503 "not configured" line while dark. Flip here alone
   * to expose the section (PRD: docs/connections-api-contract.md). */
  connections: true,
  /** Settings → Plugins community (browse/install/enable/uninstall plugins).
   * When off, plugin-contributed settings sections render unconditionally —
   * the exact pre-plugin behavior — so this flag alone rolls back the whole
   * plugin system (PRD: docs/plugin-architecture-prd.md). */
  pluginMarketplace: true,
} as const;

/**
 * Build channel, selected at packaging time via an env var:
 *
 *   - "official"  — the OFFICIAL build (正式版). Login page carries the full
 *                   sign-in surface: phone + SMS code and WeChat QR-code.
 *                   This is what `pnpm build` produces by default and the
 *                   only channel distributed: installers are published to
 *                   Tencent CloudBase (website download + in-app auto-update),
 *                   see apps/tauri/scripts/publish-cloudbase.sh.
 *   - "debug"     — the DEBUG channel build. Login page shows the API-key
 *                   form only; no phone/WeChat login. Dev shells default to
 *                   it; packaged explicitly via the `build:debug` scripts.
 *
 * Each app shell calls `configureBuildChannel` at startup with its own env
 * (`NEXT_PUBLIC_BUILD_CHANNEL` on web, `VITE_BUILD_CHANNEL` in Tauri), falling
 * back to "official" for production builds and "debug" in dev — so the same
 * source produces both channels (see the `build:official` / `build:debug`
 * scripts in apps/web and apps/tauri).
 */
export type BuildChannel = "official" | "debug";

let buildChannel: BuildChannel = "official";

export function configureBuildChannel(channel: BuildChannel): void {
  buildChannel = channel;
}

export function getBuildChannel(): BuildChannel {
  return buildChannel;
}

/** Whether the build ships the passwordless channels (phone SMS + WeChat). */
export function hasPasswordlessAuth(): boolean {
  return buildChannel === "official";
}

/**
 * Dev-only API-key sign-in on the login page. Production builds never ship
 * it; dev shells expose it as an extra entry under "more ways to sign in".
 * Like the build channel, each app shell injects this from its own env
 * (`import.meta.env.DEV` in Tauri, `process.env.NODE_ENV` on web).
 */
let devApiAuth = false;

export function configureDevApiAuth(enabled: boolean): void {
  devApiAuth = enabled;
}

export function hasDevApiAuth(): boolean {
  return devApiAuth;
}
