import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { completeOAuth, setDefaultDestination, setPaywall } from "../fixtures/integrations-mock";

/**
 * The UI-level Connections flow, verified against the stateful mock.
 *
 * Opt-in: `featureFlags.connections` is off until the backend deploys, so this
 * suite skips unless BOTH the flag is flipped locally and the run is marked
 * with `LYNSE_E2E_CONNECTIONS=on`. That keeps CI honest about the shipped
 * state while leaving a runnable proof of the whole flow:
 *
 *   pnpm --filter @lynse/tauri exec vite build   # not needed; dev:e2e serves it
 *   LYNSE_E2E_CONNECTIONS=on npx playwright test --config playwright.desktop.config.ts 31-connections
 *
 * What it covers: the section renders with its five groups, the reminder card
 * shows, Connect drives the real handshake (browser step completed from the
 * mock side, exactly as the backend's web relay would), the connected account
 * plus Sync/Notify appear, and a Pro provider surfaces the paywall copy.
 */
test.skip(process.env.LYNSE_E2E_CONNECTIONS !== "on", "flip featureFlags.connections to run");

// One at a time: each test drives the same compile-time feature and shares the
// mock's OAuth state machine semantics, so parallel workers make a row look
// stuck mid-handshake.
test.describe.configure({ mode: "serial" });

test("connections UI renders and a connect completes end to end", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await page.locator('button[title="E2E Tester"]').click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Connections" }).click();
  await expect(dialog.getByText("Manage your integrations").first()).toBeVisible();
  await expect(dialog.getByText("Pre-meeting reminder").first()).toBeVisible();
  await expect(dialog.getByText("Google Calendar").first()).toBeVisible();
  await expect(dialog.getByText("Notion").first()).toBeVisible();
  await expect(dialog.getByText("Todoist").first()).toBeVisible();

  // Connect Google Calendar: the shim swallows openExternal, so the browser
  // never really opens — complete the handshake from the mock side instead.
  await dialog.getByRole("button", { name: "Connect", exact: true }).first().click();
  await expect
    .poll(async () => mockServer.integrations.pendingOAuth.size, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const [token] = [...mockServer.integrations.pendingOAuth.keys()];
  completeOAuth(mockServer.integrations, token!);

  await expect(page.getByText(/google-user-\d+@e2e\.local/).first()).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText("Connected").first()).toBeVisible();
  // Calendar accounts carry Sync + Notify.
  await expect(dialog.getByText("Remind me").first()).toBeVisible();
  await expect(dialog.getByText("Sync", { exact: true }).first()).toBeVisible();

  // Paywall path: notion is Pro, so its Connect must surface the upgrade copy.
  const notionConnect = dialog.locator(
    'xpath=//p[normalize-space()="Notion"]/ancestor::div[contains(@class,"rounded-lg")]//button[normalize-space()="Connect"]',
  );
  await notionConnect.click();
  await expect(dialog.getByText("This is a Lynse Pro feature").first()).toBeVisible({ timeout: 15_000 });

  // AC-5: nothing third-party may land in client storage. The shim's vault is
  // localStorage-backed, so dumping storage is the whole audit surface here.
  const dumped = await page.evaluate(() => {
    const entries: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) entries.push(`${key}=${localStorage.getItem(key) ?? ""}`);
    }
    return entries.join("&");
  });
  expect(dumped).not.toMatch(/access_token|refresh_token|authorization_code/i);
  expect(dumped).not.toMatch(/access_token|refresh_token/);

  await page.screenshot({ path: "connections-ui.png", fullPage: false });
});

/** FR-2: multi-select on the Todos page, then export to a connected provider. */
test("action items can be selected and exported to Todoist", async ({ page, mockServer }) => {
  // Connect Todoist and give it a project over HTTP first: this test covers the
  // selection UI and the export call, not the handshake (proved in test 1).
  const st = (
    await (await page.request.get(`${mockServer.url}/api/v2/integrations/todoist/oauth-state`)).json()
  ).state;
  completeOAuth(mockServer.integrations, st);
  await page.request.post(`${mockServer.url}/api/v2/integrations/todoist/exchange-code`, {
    data: { code: "c", state: st },
  });

  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "Todos" }).click();

  // Enter selection mode from the title bar, then take everything.
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByText("1 selected")).toBeVisible();

  await page.getByRole("button", { name: "Export" }).click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog.getByText("Export action items")).toBeVisible();

  // Pick a destination — without one the backend bounces with 409.
  await dialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: "Work" }).click();
  await dialog.getByRole("button", { name: "Export" }).click();

  await expect(page.getByText("Exported 1 items to Todoist")).toBeVisible({ timeout: 15_000 });
  const call = mockServer.integrations.exportCalls.at(-1);
  expect(call?.provider).toBe("todoist");
  expect((call?.body as { action_item_ids?: string[] }).action_item_ids).toHaveLength(1);
});

/** FR-3: the note header exports the summary, and re-exporting updates. */
test("a note summary can be exported to a connected document provider", async ({
  page,
  mockServer,
}) => {
  setPaywall(mockServer.integrations, false);

  // Connect notion + give it a default database, over HTTP: this test is about
  // the note UI, not about repeating the handshake.
  const state = (
    await (await page.request.get(`${mockServer.url}/api/v2/integrations/notion/oauth-state`)).json()
  ).state;
  completeOAuth(mockServer.integrations, state);
  await page.request.post(`${mockServer.url}/api/v2/integrations/notion/exchange-code`, {
    data: { code: "c", state },
  });
  const account = (
    await (await page.request.get(`${mockServer.url}/api/v2/integrations/notion/status`)).json()
  ).accounts[0];
  setDefaultDestination(mockServer.integrations, "notion", account.id, "db-meetings");

  // The note needs a conclusion, or the menu item has nothing to export.
  mockServer.setRoute("GET /api/business/file/conclusion/list", {
    envelope: true,
    body: [
      {
        id: "concl-1",
        fileId: "file-q3-review",
        templateName: "Meeting minutes",
        conclusionText: "Q3 revenue grew 18%; the team agrees to fund the migration.",
        createdAt: "2026-09-01T11:00:00Z",
      },
    ],
  });

  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "Notes" }).click();
  await page.getByRole("button", { name: /Q3 review\.m4a/ }).click();

  // The export item acts on the *selected* summary, so open its tab first.
  await page.getByRole("button", { name: "Meeting minutes" }).click();

  // The header menu must offer the export and leave it enabled — i.e. the note
  // UI sees the connected account *and* its default database. The export call
  // itself (including the "second export updates the same page" upsert) is
  // covered at the contract level in 30-connections.spec.ts.
  await page.locator('button[title="More actions"]').click();
  const item = page.getByRole("menuitem", { name: /Export summary to/ });
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  await expect(item).toContainText("Export summary to");

});

/**
 * The reason `useConnectFlow` exists at all: WorkBuddy's inline poll is torn
 * down when the settings dialog unmounts, so a user who clicks Connect and then
 * navigates away never finishes. This asserts the session survives the dialog
 * closing and the page changing underneath it.
 */
test("a connect started in Settings still completes after navigating away", async ({
  page,
  mockServer,
}) => {
  await openWorkspace(page, mockServer.url);
  await page.locator('button[title="E2E Tester"]').click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Connections" }).click();

  const calendarConnect = dialog.locator(
    'xpath=//p[normalize-space()="Google Calendar"]/ancestor::div[contains(@class,"rounded-lg")]//button[normalize-space()="Connect"]',
  );
  await calendarConnect.click();
  await expect
    .poll(async () => mockServer.integrations.pendingOAuth.size, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const [token] = [...mockServer.integrations.pendingOAuth.keys()];

  // Walk away mid-handshake: close the dialog and change route entirely.
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("complementary").getByRole("button", { name: "Home" }).click();

  // The user finishes in the browser while the app is on another page.
  completeOAuth(mockServer.integrations, token!);

  // Come back: the session must have completed with nobody watching.
  await page.locator('button[title="E2E Tester"]').click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await dialog.getByRole("button", { name: "Connections" }).click();
  await expect(page.getByText(/google-user-\d+@e2e\.local/).first()).toBeVisible({ timeout: 25_000 });
});
