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
    // The assistant has its own origin; keep scripted turns on this mock too.
    localStorage.setItem("lynse_agent_api_url", url);
    // Calendar and Connections use a separate backend origin. Keep fake
    // credentials and background requests on the per-test mock server.
    localStorage.setItem("lynse_integrations_api_url", url);
    localStorage.setItem("lynse_token", "e2e-access-token");
    localStorage.setItem("lynse_locale", "en");
    // Past first-run: since v1.1.6 the desktop shell renders the permission
    // onboarding instead of the dashboard until this is answered, which made
    // every desktop spec stall on the onboarding page (no Home button). The
    // fixture means "logged-in app at its landing route", so skip it the same
    // way a user who already answered would see it skipped.
    // Key mirrors PERMISSION_ONBOARDING_DONE_KEY in
    // packages/views/onboarding/permission-onboarding.tsx.
    localStorage.setItem("lynse_permission_onboarding_done", "1");
  }, serverUrl);
}

export async function openChat(page: import("@playwright/test").Page, serverUrl: string) {
  await bootstrapApp(page, serverUrl);
  await page.goto("/chat");
  // Account hydration resets chat history; wait before sending the first turn.
  await expect(page.getByRole("button", { name: /E2E Tester/ })).toBeVisible();
  // The composer placeholder is a stable render proof for the chat page.
  await expect(
    page.getByPlaceholder("Ask about your recordings, meetings"),
  ).toBeVisible({ timeout: 20_000 });
}

export { expect };
