import { test as base, expect } from "@playwright/test";
import { startMockServer, type MockServer } from "./mock-server";
import type { ChatScript } from "./chat-script";

/**
 * Extended Playwright fixtures:
 * - `mockServer`: a per-test local Lynse backend (JSON + scripted poll chat).
 * - `chatPage`: opens /chat with the app pointed at the mock server,
 *   authenticated via a fake localStorage token (login itself is not tested).
 */

export const test = base.extend<{ mockServer: MockServer; chatScript: ChatScript | null }>({
  chatScript: [null, { option: true }],
  mockServer: async ({ chatScript }, use) => {
    const server = await startMockServer(chatScript ?? undefined);
    await use(server);
    await server.close();
  },
});

/** Bootstrap the app against the mock backend, logged in, English locale. */
export async function bootstrapApp(page: import("@playwright/test").Page, serverUrl: string) {
  await page.addInitScript((url: string) => {
    localStorage.setItem("lynse_api_url", url);
    localStorage.setItem("lynse_token", "e2e-access-token");
    localStorage.setItem("lynse_locale", "en");
  }, serverUrl);
}

export async function openChat(page: import("@playwright/test").Page, serverUrl: string) {
  await bootstrapApp(page, serverUrl);
  await page.goto("/chat");
  // The composer placeholder is a stable render proof for the chat page.
  await expect(
    page.getByPlaceholder("Ask about your recordings, meetings..."),
  ).toBeVisible({ timeout: 20_000 });
}

export { expect };
