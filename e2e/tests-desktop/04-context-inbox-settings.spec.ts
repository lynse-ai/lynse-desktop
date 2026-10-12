import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

/** All API requests remain on the synthetic per-test backend. */
test("proactive suggestions are off by default and follow the saved settings switch", async ({ page, mockServer }) => {
  mockServer.setRoute("GET /api/connectors/identity", { body: { user_id: "user-e2e" } });
  mockServer.setRoute("GET /api/context/inbox", { body: {
    status: "ok", available: true, user_id: "user-e2e", items: [], can_display: true,
  } });
  mockServer.setRoute("POST /api/context/sync", { body: { status: "accepted", queued: true } });
  const contextRequests = () => mockServer.requests().filter((request) => request.path.startsWith("/api/context/"));
  async function openSettings() {
    await page.getByRole("button", { name: "E2", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "AI Assistant", exact: true }).click();
    return dialog;
  }

  await page.addInitScript((url: string) => localStorage.setItem("lynse_agent_api_url", url), mockServer.url);
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  await openWorkspace(page, mockServer.url);
  const dialog = await openSettings();
  const toggle = dialog.getByRole("switch", { name: "Receive proactive suggestions", exact: true });
  await expect(toggle).not.toBeChecked();
  expect(contextRequests()).toHaveLength(0);
  await expect(dialog.getByText(/Off by default/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("settings-default.png"), animations: "disabled" });

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Set up background meeting reviews", exact: true })).toBeVisible();
  await expect.poll(() => contextRequests().filter((request) => request.path.endsWith("/inbox")).length).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("settings-enabled.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  // The empty inbox still has a reachable notification entry after opt-in.
  await expect(page.getByRole("complementary").getByRole("button", { name: "Notifications", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeVisible();
  await openSettings();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary").getByRole("button", { name: "Notifications", exact: true })).toHaveCount(0);
  const count = contextRequests().length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(contextRequests()).toHaveLength(count);

  await page.reload();
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeVisible();
  await openSettings();
  await expect(toggle).not.toBeChecked();
  expect(contextRequests()).toHaveLength(count);
});
