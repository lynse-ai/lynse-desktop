import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

/** All API requests remain on the synthetic per-test backend. */
test("the proactive suggestions switch grants and revokes cloud analysis directly", async ({ page, mockServer }) => {
  const globalScope = { scope_type: "global", scope_id: "" };
  const disabled = { enabled: false, scopes: [], timezone: "Asia/Shanghai", grant_version: 0 };
  const granted = { enabled: true, scopes: [globalScope], timezone: "Asia/Shanghai", grant_version: 1 };
  const revoked = { ...granted, enabled: false, grant_version: 2 };
  mockServer.setRoute("GET /api/connectors/identity", { body: { user_id: "user-e2e" } });
  mockServer.setRoute("GET /api/context/preferences", { body: { status: "ok", preferences: disabled } });
  mockServer.setRoute("POST /api/context/preferences", { body: { status: "ok", changed: true, preferences: granted } });
  mockServer.setRoute("GET /api/context/inbox", { body: {
    status: "ok", available: true, user_id: "user-e2e", items: [], can_display: true,
  } });
  mockServer.setRoute("POST /api/context/sync", { body: { status: "accepted", queued: true } });
  const contextRequests = () => mockServer.requests().filter((request) => request.path.startsWith("/api/context/"));
  const pollRequests = () => contextRequests().filter((request) => !request.path.endsWith("/preferences"));
  const grantWrites = () => mockServer.requests({ method: "POST", path: "/api/context/preferences" });
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
  // Nothing under /api/context is requested until the settings card is opened;
  // opening it reads the cloud grant once and never polls while it is off.
  expect(contextRequests()).toHaveLength(0);
  const dialog = await openSettings();
  const toggle = dialog.getByRole("switch", { name: "Receive proactive suggestions", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => mockServer.requests({ method: "GET", path: "/api/context/preferences" }).length).toBe(1);
  expect(pollRequests()).toHaveLength(0);
  await expect(dialog.getByText(/This switch is the authorization/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: /background meeting review/i })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("settings-default.png"), animations: "disabled" });

  // Turning the switch on is the consent: one grant write with the global
  // scope and the device timezone, then this device starts polling the inbox.
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => grantWrites().length).toBe(1);
  expect(grantWrites()[0]?.body).toMatchObject({ action: "set", enabled: true, scopes: [globalScope], base_version: 0 });
  expect(typeof grantWrites()[0]?.body.timezone).toBe("string");
  expect(typeof grantWrites()[0]?.body.operation_id).toBe("string");
  await expect.poll(() => contextRequests().filter((request) => request.path.endsWith("/inbox")).length).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("settings-enabled.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  // The empty inbox still has a reachable notification entry after opt-in.
  await expect(page.getByRole("complementary").getByRole("button", { name: "Notifications", exact: true })).toBeVisible();

  // The server grant is the source of truth after a reload.
  mockServer.setRoute("GET /api/context/preferences", { body: { status: "ok", preferences: granted } });
  mockServer.setRoute("POST /api/context/preferences", { body: { status: "ok", changed: true, preferences: revoked } });
  await page.reload();
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeVisible();
  await openSettings();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => grantWrites().length).toBe(2);
  expect(grantWrites()[1]?.body).toMatchObject({ action: "stop", base_version: 1 });
  mockServer.setRoute("GET /api/context/preferences", { body: { status: "ok", preferences: revoked } });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary").getByRole("button", { name: "Notifications", exact: true })).toHaveCount(0);
  const polls = pollRequests().length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(pollRequests()).toHaveLength(polls);

  await page.reload();
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeVisible();
  await openSettings();
  await expect(toggle).not.toBeChecked();
  expect(pollRequests()).toHaveLength(polls);
  expect(grantWrites()).toHaveLength(2);
});
