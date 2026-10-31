import { test as base, expect } from "@playwright/test";
import { startMockServer, type MockServer } from "../fixtures/mock-server";
import type { ChatScript } from "../fixtures/chat-script";
import { bootstrapApp as bootstrapLoggedInApp } from "../fixtures/lynse-fixture";

/**
 * Desktop workspace fixtures: same mock backend as the web suite, pointed at
 * the real Tauri renderer (running under the e2e IPC shim).
 */
export const test = base.extend<{ mockServer: MockServer }>({
  mockServer: async ({}, use) => {
    const server = await startMockServer();
    await use(server);
    await server.close();
  },
});

export { expect };

/** Desktop feature scenarios explicitly opt into the runtime Beta surface. */
export async function bootstrapApp(page: import("@playwright/test").Page, serverUrl: string) {
  await bootstrapLoggedInApp(page, serverUrl);
  await page.addInitScript(() => localStorage.setItem("lynse_test_mode", "1"));
}

/** Open the desktop workspace root, logged in, with a chat script attached. */
export async function openWorkspace(page: import("@playwright/test").Page, serverUrl: string) {
  await bootstrapApp(page, serverUrl);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /E2E Tester/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Home" })).toBeVisible({ timeout: 20_000 });
}

export type { ChatScript };
