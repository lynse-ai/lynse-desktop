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
  /** Enable only after the durable sync service and local-data migration are ready. */
  inspirationCloudSync: false,
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
  /** Workbench knowledge base (Wiki): sidebar entry, /memory page, home
   * progress card, desktop chat context and the Rust synthesis worker. The
   * pipeline is still under release hold — exposure follows the beta gate
   * below (debug-channel builds, dev shells and the runtime test mode). */
  wiki: true,
  /** Lynclaw summary tabs (Beta): the add-summary dialog lists Lynclaw
   * pseudo-templates (Markdown / HTML, badged "Beta"). The client summarizes
   * the transcript via the agent service and inserts the result as a real
   * cloud conclusion, so it renders as a regular summary tab — editable,
   * deletable and synced like any template summary. Beta while the output
   * quality (inline images in particular) is being evaluated; the backend
   * will own generation once it graduates. */
  lynclawSummaryTabs: true,
} as const;

/**
 * Beta-exposure gate shared by the WIP surfaces marked with a Beta badge
 * (suggestions, assistant settings, models and connections). Beta surfaces stay visible in
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
 * Whether the knowledge base (Wiki) is exposed. The single gate every entry
 * point reads: the flag above AND the beta channel gate — debug-channel
 * builds, dev shells and the runtime test mode show it; official builds hide
 * the sidebar entry, the /memory page, the home card and the desktop chat
 * context, and the Rust worker stays disabled (bind sends betaEnabled=false).
 */
export function isWikiEnabled(): boolean {
  return featureFlags.wiki && isBetaFeaturesUnlocked();
}

/**
 * Whether the beta Lynclaw summary pseudo-templates are exposed in the
 * add-summary dialog. The single gate every entry point reads: the flag above
 * AND the beta channel gate — debug-channel builds, dev shells and the
 * runtime test mode show them; official builds hide the entries entirely.
 */
export function isLynclawSummaryTabsEnabled(): boolean {
  return featureFlags.lynclawSummaryTabs && isBetaFeaturesUnlocked();
}

/**
 * Build channel, selected at packaging time via an env var:
 *
 * Legacy feature-exposure override for unfinished surfaces. This never
 * selects a different login flow or backend. Phone, WeChat and app-scanned
 * QR sign-in are shared; users select their server on the login page.
 *
 * Each app shell calls `configureBuildChannel` at startup with its own env
 * (`NEXT_PUBLIC_BUILD_CHANNEL` on web, `VITE_BUILD_CHANNEL` in Tauri), falling
 * back to "official". Rust debug/release profiles do not select a channel.
 */
export type BuildChannel = "official" | "debug";

let buildChannel: BuildChannel = "official";

export function configureBuildChannel(channel: BuildChannel): void {
  buildChannel = channel;
}

export function getBuildChannel(): BuildChannel {
  return buildChannel;
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
  if (typeof window !== "undefined") window.dispatchEvent(new Event("lynse-test-mode-changed"));
}

