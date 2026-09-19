import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

/**
 * Visual regression baselines for the desktop renderer (the surface users
 * actually see). Runs LOCALLY ONLY — screenshot pixels are platform-specific
 * (font antialiasing), so CI (ubuntu) skips these; baselines live in
 * tests-desktop/*-snapshots/ and are refreshed deliberately with:
 *
 *   pnpm test:desktop 90-visual --update-snapshots
 *
 * Only deterministic surfaces get baselines: the home feed is dynamic
 * (weather, greeting, date) and would flake every run.
 */
test.skip(!!process.env.CI, "visual baselines are platform-specific; run locally");

test.describe("desktop visual baselines", () => {
  test("notes with open note and docked chat panel", async ({ page, mockServer }) => {
    const { loadScript } = await import("../helpers/chat");
    mockServer.setChatScript(loadScript("core-basic"));
    await openWorkspace(page, mockServer.url);
    await page.getByRole("complementary").getByRole("button", { name: "Notes" }).click();
    await page.getByRole("button", { name: /Q3 review\.m4a/ }).click();
    const askAi = page.getByTitle("Ask AI");
    await expect(askAi).toBeVisible();
    await askAi.click();
    await expect(page.getByPlaceholder("Ask about this file…")).toBeVisible();

    // Capture the freshly opened panel. A shot after sending is NOT stable:
    // the panel runs JS-driven animations (rotating waiting captions, avatar
    // idle motion) that toHaveScreenshot's CSS animation freeze can't stop.
    // Small pixel tolerance absorbs the rotating quick-prompt chips.
    await page.waitForTimeout(1500); // panel spring + fade settle
    await expect(page).toHaveScreenshot("notes-chat-panel.png", {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("settings dialog", async ({ page, mockServer }) => {
    await openWorkspace(page, mockServer.url);
    await page.getByRole("complementary").getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot("settings.png", { fullPage: false });
  });
});
