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
   * to expose the section (PRD: docs/connections-api-contract.md).
   *
   * Even when `true`, exposure is narrowed to debug-channel builds via
   * `isConnectionsEnabled()` below: the integration backend is still under
   * active debugging, so official builds hide the section until it ships. */
  connections: true,
  /** Settings → Plugins community (browse/install/enable/uninstall plugins).
   * When off, plugin-contributed settings sections render unconditionally —
   * the exact pre-plugin behavior — so this flag alone rolls back the whole
   * plugin system (PRD: docs/plugin-architecture-prd.md). */
  pluginMarketplace: true,
} as const;

/**
 * Beta-exposure gate shared by the WIP surfaces marked with a Beta badge
 * (主动建议, 小玲同学服务地址, 对话模型, 连接). Beta surfaces stay visible in
 * debug-channel builds and dev shells so the team can keep iterating; official
 * builds hide them from the UI entirely and the features stay off by default.
 * The runtime test mode (login-logo 5-tap) unlocks them inside an official
 * build for the team.
 */
export function isBetaFeaturesUnlocked(): boolean {
  return getBuildChannel() === "debug" || isTestMode();
}

/**
 * Whether Settings → Connections (third-party integrations) is exposed. The
 * single gate every entry point reads: the flag above AND the beta channel
 * gate — debug-channel builds and dev shells show it, official builds hide it
 * while the integration flows are still being debugged.
 */
export function isConnectionsEnabled(): boolean {
  return featureFlags.connections && isBetaFeaturesUnlocked();
}

/**
 * Build channel, selected at packaging time via an env var:
 *
 *   - "official"  — the OFFICIAL build (正式版). Login page carries the full
 *                   sign-in surface: phone + SMS code and WeChat QR-code.
 *                   This is what `pnpm build` produces by default and the
 *                   only channel distributed: installers are published to
 *                   Tencent CloudBase (website download + in-app auto-update),
 *                   see apps/tauri/scripts/publish-cloudbase.sh.
 *   - "debug"     — the DEBUG channel build. No phone/WeChat login; the
 *                   API-key sign-in unlocks via the login-page logo 5-tap
 *                   (test mode), so the locked face is the "more ways"
 *                   chooser. Dev shells default to it; packaged explicitly
 *                   via the `build:debug` scripts.
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
 * API-key sign-in on the login page. Hidden by default in EVERY build —
 * dev shells and debug-channel builds included, so a dev screenshot shows
 * the same face as production. The only way in is the runtime test mode
 * below: five taps on the login-page logo unlock the API sign-in panel,
 * and the unlock persists in localStorage until explicitly exited.
 */
export function hasDevApiAuth(): boolean {
  return loadTestMode();
}

/**
 * Runtime "test mode" — a hidden maintenance entry for the team inside a
 * single official build. Tapping the login-page logo five times in a row
 * enables it: the API sign-in surface (server selection + API key, the
 * debug-build panel) appears under "more ways to sign in" and persists in
 * localStorage until explicitly exited. Deliberately narrow on purpose —
 * phone/WeChat login and the official update source stay untouched, and
 * the panel is a pure UI unlock (connecting still needs a valid key), so
 * the flag is no auth bypass.
 */
const TEST_MODE_STORAGE_KEY = "lynse_test_mode";

let testMode: boolean | undefined;

function loadTestMode(): boolean {
  if (testMode === undefined) {
    try {
      testMode =
        typeof localStorage !== "undefined" &&
        localStorage.getItem(TEST_MODE_STORAGE_KEY) === "1";
    } catch {
      testMode = false;
    }
  }
  return testMode;
}

export function isTestMode(): boolean {
  return loadTestMode();
}

export function setTestMode(enabled: boolean): void {
  testMode = enabled;
  try {
    if (enabled) localStorage.setItem(TEST_MODE_STORAGE_KEY, "1");
    else localStorage.removeItem(TEST_MODE_STORAGE_KEY);
  } catch {
    // Storage unavailable (SSR / private mode) — keep it session-only.
  }
}

