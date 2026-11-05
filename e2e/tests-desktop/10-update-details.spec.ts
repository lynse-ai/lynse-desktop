import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

const releaseNotes = JSON.parse(readFileSync(resolve(__dirname, "../../apps/tauri/release-notes/1.3.0.json"), "utf8")) as Record<string, string>;
const updateModule = `/@fs${resolve(__dirname, "../../packages/views/app-update.ts")}`;
const languageModule = `/@fs${resolve(__dirname, "../../packages/core/i18n/react.ts")}`;

test.beforeEach(async ({ page }) => {
  // The real update service and installer are never used in these scenarios.
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
});

async function openNotes(page: Page, notes: string) {
  await page.evaluate(async ({ moduleUrl, notes }) => {
    const desktop = (window as unknown as {
      desktopAPI: {
        appInfo: { version: string; platform: string; sandboxed: boolean };
        app: { checkForUpdate: () => Promise<unknown> };
      };
    }).desktopAPI;
    desktop.appInfo = { ...desktop.appInfo, version: "1.2.7", sandboxed: false };
    desktop.app.checkForUpdate = async () => ({
      currentVersion: "1.2.7", latestVersion: "1.3.0", hasUpdate: true,
      releaseUrl: "https://example.com/release", releaseNotes: notes,
    });
    (await import(moduleUrl)).openAppUpdateDialog({ refresh: true });
  }, { moduleUrl: updateModule, notes });
}

test("long update notes scroll while the version header and actions stay visible", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  const extraNotes = Array.from({ length: 18 }, (_, index) => `\n• Compatibility detail ${index + 1}: the original meeting content stays available while background tasks finish.`).join("");
  await openNotes(page, releaseNotes.en + extraNotes);
  const dialog = page.getByRole("dialog", { name: "Update to v1.3.0" });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(dialog.getByText("Current version: v1.2.7")).toBeVisible();
  await expect(dialog.getByRole("region", { name: "New features" }).getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("region", { name: "Improvements" }).getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("region", { name: "Fixes" }).getByRole("listitem")).toHaveCount(19);
  const body = dialog.locator('[data-slot="update-notes-body"]');
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const header = dialog.locator('[data-slot="dialog-header"]');
  const footer = dialog.locator('[data-slot="dialog-footer"]');
  const headerBefore = await header.boundingBox();
  const footerBefore = await footer.boundingBox();
  await page.screenshot({ path: test.info().outputPath("update-details-long.png"), animations: "disabled" });
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await header.boundingBox()).toEqual(headerBefore);
  expect(await footer.boundingBox()).toEqual(footerBefore);
  await expect(dialog.getByRole("button", { name: "Install update" })).toBeInViewport();
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).not.toBeVisible();
});

test("Chinese notes and long words wrap in a narrow dark window", async ({ page, mockServer }) => {
  await page.setViewportSize({ width: 400, height: 680 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openWorkspace(page, mockServer.url);
  await page.evaluate(async (url) => { await (await import(url)).changeLanguage("zh-Hans"); }, languageModule);
  await openNotes(page, releaseNotes["zh-Hans"] + "\n• " + "LongUnbrokenCompatibilityIdentifier".repeat(6));
  const dialog = page.getByRole("dialog", { name: "更新到 v1.3.0" });
  await expect(dialog.getByRole("region", { name: "新功能" }).getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("region", { name: "改进" }).getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("region", { name: "错误修复" }).getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "立即更新" })).toBeInViewport();
  const sizes = await dialog.evaluate((element) => ({
    overflow: element.scrollWidth - element.clientWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    viewport: innerWidth,
    bodyOverflow: element.querySelector('[data-slot="update-notes-body"]')!.scrollWidth - element.querySelector('[data-slot="update-notes-body"]')!.clientWidth,
  }));
  expect(sizes.overflow).toBeLessThanOrEqual(1);
  expect(sizes.bodyOverflow).toBeLessThanOrEqual(1);
  expect(sizes.left).toBeGreaterThanOrEqual(15);
  expect(sizes.right).toBeLessThanOrEqual(sizes.viewport - 15);
  await expect(dialog.getByText("当前版本：v1.2.7")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("update-details-narrow-dark.png"), animations: "disabled" });
});

test("download progress stays guarded and a failed install can retry without a real installer", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await page.evaluate(() => {
    const target = window as unknown as {
      updateTest: { calls: number; relaunches: number; fail?: () => void };
      desktopAPI: { app: {
        downloadAndInstallUpdate: (onProgress: (progress: { event: string; downloaded: number; total: number }) => void) => Promise<void>;
        relaunchApp: () => Promise<void>;
      } };
    };
    target.updateTest = { calls: 0, relaunches: 0 };
    target.desktopAPI.app.downloadAndInstallUpdate = (onProgress) => {
      target.updateTest.calls += 1;
      onProgress({ event: "progress", downloaded: 25, total: 100 });
      return new Promise((_, reject) => { target.updateTest.fail = () => reject(new Error("Simulated download failure")); });
    };
    target.desktopAPI.app.relaunchApp = async () => { target.updateTest.relaunches += 1; };
  });
  await openNotes(page, releaseNotes.en);
  const dialog = page.getByRole("dialog", { name: "Update to v1.3.0" });
  await dialog.getByRole("button", { name: "Install update" }).click();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  await expect(dialog.getByRole("button", { name: "Later" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Downloading update… 25%" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.mouse.click(4, 4);
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as unknown as { updateTest: { fail: () => void } }).updateTest.fail());
  await expect(dialog.getByRole("alert")).toContainText("Simulated download failure");
  await dialog.getByRole("button", { name: "Retry" }).click();
  expect(await page.evaluate(() => (window as unknown as { updateTest: { calls: number } }).updateTest.calls)).toBe(2);
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  await page.evaluate(() => (window as unknown as { updateTest: { fail: () => void } }).updateTest.fail());
  await expect(dialog.getByRole("button", { name: "Later" })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { updateTest: { relaunches: number } }).updateTest.relaunches)).toBe(0);
});
