import { defineConfig, devices } from "@playwright/test";

/**
 * Real-backend E2E profile (P6): the same chat smoke flows as the mock
 * suite, but pointed at the LIVE Lynse API through the web app's proxy.
 * Every chat sessionId is rewritten to a per-run id so the backend's
 * Langfuse traces can be pulled and diffed per run
 * (scripts/langfuse-report.mjs).
 *
 * Required env:
 *   LYNSE_E2E_TOKEN  — a valid access token for the target API (no token →
 *                      the whole suite is ignored, so CI can include this
 *                      config only when the secret exists).
 * Optional env:
 *   LYNSE_E2E_API_URL — target API (default https://api.lynse.cn)
 *   LYNSE_RUN_ID      — correlation id (default e2e-real-<date>-<rand>)
 *
 * Deliberately opt-in (`pnpm test:real`): real turns burn the account's AI
 * quota, so there is no scheduled trigger.
 */

const token = process.env.LYNSE_E2E_TOKEN;
const runId =
  process.env.LYNSE_RUN_ID ??
  `e2e-real-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Math.random()
    .toString(16)
    .slice(2, 6)}`;

if (!token) {
  console.warn(
    "[real-backend] LYNSE_E2E_TOKEN is not set — skipping the real-backend suite.",
  );
}

export default defineConfig({
  testDir: "./tests-real",
  testIgnore: token ? [] : /.*/,
  // Without LYNSE_E2E_TOKEN the suite is intentionally empty — exit clean
  // so CI pipelines can include this config unconditionally.
  passWithNoTests: !token,
  timeout: 240_000, // real AI turns run 30-120s server-side
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1, // one account: never hammer the API in parallel
  retries: 0,
  reporter: [["html", { open: "never", outputFile: "real-report/index.html" }], ["list"]],
  use: {
    baseURL: "http://localhost:3000",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium-real", use: { ...devices["Desktop Chrome"] } }],
  // No token → no tests → don't bother booting the dev server.
  webServer: token
    ? {
        command: "pnpm dev:web",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 180_000,
        cwd: "..",
        stdout: "ignore",
        stderr: "pipe",
      }
    : undefined,
});
