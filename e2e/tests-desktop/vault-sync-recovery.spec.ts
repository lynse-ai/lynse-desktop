import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

for (const failure of [
  { name: "native string", detail: "API request failed (HTTP 401)", object: false,
    message: "Sync failed API request failed (HTTP 401)" },
  { name: "Error instance", detail: "Network unavailable; retry when connected", object: true,
    message: "Sync failed Network unavailable; retry when connected" },
  { name: "folder permission", detail: "VAULT_PERMISSION_DENIED: Operation not permitted", object: false,
    message: "Lynse is not allowed to read the vault folder, so sync is paused." },
]) {
  test(`local sync explains ${failure.name} failures and permits retry without AI`, async ({ page, mockServer }) => {
    await page.route("**/*", route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort());
    await openWorkspace(page, mockServer.url);
    await page.evaluate(({ detail, object }) => {
      const runtime = window as unknown as {
        __LYNSE_E2E__: { setCommand(name: string, handler: () => unknown): void };
        vaultSyncTest: { syncs: number; aiChanges: number };
      };
      runtime.vaultSyncTest = { syncs: 0, aiChanges: 0 };
      runtime.__LYNSE_E2E__.setCommand("vault_config_get", () => ({ enabled: true, path: "/synthetic-vault" }));
      runtime.__LYNSE_E2E__.setCommand("vault_access_check", () => ({ state: "ok", path: "/synthetic-vault" }));
      runtime.__LYNSE_E2E__.setCommand("workbench_configure", () => { runtime.vaultSyncTest.aiChanges++; });
      runtime.__LYNSE_E2E__.setCommand("workbench_sync", () => {
        runtime.vaultSyncTest.syncs++;
        return runtime.vaultSyncTest.syncs === 1 ? Promise.reject(object ? new Error(detail) : detail) : null;
      });
    }, failure);
    await page.getByRole("button", { name: "E2", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Notes Sync", exact: true }).click();
    const sync = dialog.getByRole("button", { name: "Sync all now", exact: true });
    await sync.click();
    await expect(page.getByText(failure.message, { exact: !failure.name.includes("permission") })).toBeVisible();
    await expect(sync).toBeEnabled();
    await sync.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { vaultSyncTest: { syncs: number } }).vaultSyncTest.syncs)).toBe(2);
    await expect(sync).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { vaultSyncTest: { aiChanges: number } }).vaultSyncTest.aiChanges)).toBe(0);
  });
}

test("folder settings retain the native failure reason and saved switch state", async ({ page, mockServer }) => {
  await page.route("**/*", route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await openWorkspace(page, mockServer.url);
  await page.evaluate(() => {
    const runtime = window as unknown as { __LYNSE_E2E__: { setCommand(name: string, handler: () => unknown): void } };
    runtime.__LYNSE_E2E__.setCommand("vault_config_get", () => ({ enabled: true, path: "/synthetic-vault" }));
    runtime.__LYNSE_E2E__.setCommand("vault_access_check", () => ({ state: "ok", path: "/synthetic-vault" }));
    runtime.__LYNSE_E2E__.setCommand("vault_config_save", () => Promise.reject("Folder configuration failed; retry the folder change"));
  });
  await page.getByRole("button", { name: "E2", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Notes Sync", exact: true }).click();
  const toggle = dialog.getByRole("switch", { name: "Enable local knowledge-base sync", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.getByText("Failed to save settings Folder configuration failed; retry the folder change", { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
});
