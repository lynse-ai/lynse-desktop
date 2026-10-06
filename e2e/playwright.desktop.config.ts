import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in browser channel, e.g. `LYNSE_E2E_BROWSER_CHANNEL=msedge` to drive the
 * system Edge instead of downloading Playwright's Chromium. Unset keeps the CI
 * default (bundled Chromium) untouched.
 */
const BROWSER_CHANNEL = process.env.LYNSE_E2E_BROWSER_CHANNEL;

/** Video needs Playwright's ffmpeg build; `LYNSE_E2E_VIDEO=off` skips it. */
const VIDEO: "off" | "retain-on-failure" =
  process.env.LYNSE_E2E_VIDEO === "off" ? "off" : "retain-on-failure";

/**
 * Desktop-renderer E2E — drives the REAL Tauri webview UI (apps/tauri) in a
 * plain browser. Vite runs with `--mode e2e`, which installs the Tauri IPC
 * shim (apps/tauri/src/e2e/tauri-shim.ts) so `installTauriBridge()` and the
 * whole app boot unmodified; the API talks straight to the per-test mock
 * backend (CORS enabled there).
 *
 * Run with: pnpm test:desktop  (inside e2e/)
 */

export default defineConfig({
  testDir: "./tests-desktop",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never", outputFile: "desktop-report/index.html" }], ["list"]],
  use: {
    baseURL: "http://localhost:5183",
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: VIDEO,
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}) },
    },
  ],
  webServer: {
    command: "pnpm --filter @lynse/tauri dev:e2e",
    url: "http://localhost:5183",
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: "..",
    stdout: "ignore",
    stderr: "pipe",
  },
});
