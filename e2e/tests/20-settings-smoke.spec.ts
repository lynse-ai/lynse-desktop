import { test, expect } from "@playwright/test";
import { bootstrapApp } from "../fixtures/lynse-fixture";
import { startMockServer } from "../fixtures/mock-server";

/**
 * Settings smoke: the /settings route opens the settings dialog; its web
 * sections render (STT/hotwords/voiceprints are desktop-only and hidden).
 */

const SETTING_SECTIONS = [
  /appearance/i,
  /theme/i,
  /live|translat/i,
  /vault/i,
  /webdav|sync/i,
];

test("settings dialog opens and lists its sections", async ({ page }) => {
  const server = await startMockServer();
  await bootstrapApp(page, server.url);

  // The /settings route opens the settings dialog directly.
  await page.goto("/settings");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  // Config cards render lazily/async — give them a beat.
  let found = 0;
  await expect
    .poll(
      async () => {
        found = 0;
        for (const section of SETTING_SECTIONS) {
          if (await dialog.getByText(section).first().isVisible().catch(() => false)) {
            found += 1;
          }
        }
        return found;
      },
      { timeout: 15_000 },
    )
    // Live-translation/Vault/WebDAV cards render only when their backend or
    // desktop capabilities are present — with plain mocks only the Appearance
    // card (title + theme row) is guaranteed.
    .toBeGreaterThanOrEqual(2);

  await server.close();
});
