import { defineConfig, devices } from "@playwright/test";

/**
 * E2E test system for the Lynse web app.
 *
 * - Assumes the dev server is already running (or starts it via webServer):
 *   `pnpm dev:web` → http://localhost:3000
 * - Auth is NOT tested: a fake token is injected into localStorage and a local
 *   mock backend server (started per worker by the fixtures) serves all
 *   /api/business/** responses, including the scripted poll chat endpoint.
 */
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
    baseURL: "http://localhost:3000",
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
    // Repo root owns the pnpm workspace; dev:web serves on :3000.
    command: "pnpm dev:web",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 180_000,
    cwd: "..",
    stdout: "ignore",
    stderr: "pipe",
  },
});
