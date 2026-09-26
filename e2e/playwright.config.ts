import { defineConfig, devices } from "@playwright/test";

/**
 * E2E test system for the Lynse web app.
 *
 * - Assumes the dev server is already running (or starts it via webServer):
 *   `pnpm dev:web` → http://localhost:${E2E_PORT:-3000}
 * - Set `E2E_PORT` to run against (or boot) a dedicated dev server on another
 *   port, e.g. while :3000 is in use by an interactive dev session.
 * - Auth is NOT tested: a fake token is injected into localStorage and a local
 *   mock backend server (started per worker by the fixtures) serves all
 *   /api/business/** responses, including the scripted poll chat endpoint.
 */
const port = Number(process.env.E2E_PORT || 3000);

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: undefined,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    // The copy-response test needs clipboard access in headless Chromium.
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Repo root owns the pnpm workspace. `pnpm dev:web` hard-codes :3000, so
    // a dedicated E2E_PORT boots `next dev` directly on that port instead.
    command: port === 3000 ? "pnpm dev:web" : `pnpm --filter @lynse/web exec next dev --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 180_000,
    cwd: "..",
    stdout: "ignore",
    stderr: "pipe",
  },
});
