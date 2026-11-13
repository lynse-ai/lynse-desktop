import { test, expect } from "@playwright/test";
import { bootstrapApp } from "../fixtures/lynse-fixture";
import { startMockServer } from "../fixtures/mock-server";

/**
 * Settings smoke: the /settings route opens the settings dialog; its web
 * sections render (STT/hotwords/voiceprints are desktop-only and hidden).
 */

test("settings dialog opens and lists its sections", async ({ page }) => {
  const server = await startMockServer();
  await bootstrapApp(page, server.url);

  // The /settings route opens the settings dialog directly.
  await page.goto("/settings");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();

  await server.close();
});
