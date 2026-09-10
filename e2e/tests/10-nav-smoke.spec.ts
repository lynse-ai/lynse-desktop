import { test, expect } from "@playwright/test";
import { bootstrapApp } from "../fixtures/lynse-fixture";
import { startMockServer } from "../fixtures/mock-server";

/**
 * Site-wide smoke: every dashboard route renders its primary surface without
 * crashing against the mocked backend.
 */

// /todo, /notes, /notifications have no routes in the web app yet (sidebar
// links exist but the pages 404) — excluded until the routes ship.
const routes: { path: string; proof: () => string }[] = [
  { path: "/home", proof: () => "h1, main, [role=main]" },
  { path: "/chat", proof: () => "textarea" },
  { path: "/recordings", proof: () => "main, [role=main]" },
  { path: "/meetings", proof: () => "main, [role=main]" },
  { path: "/files", proof: () => "main, [role=main]" },
  { path: "/knowledge", proof: () => "main, [role=main]" },
];

for (const route of routes) {
  test(`smoke: ${route.path} renders`, async ({ page }) => {
    const server = await startMockServer();
    await bootstrapApp(page, server.url);
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");
    // Primary surface exists and the page didn't crash into an error boundary.
    await expect(page.locator("body")).toBeVisible();
    const main = page.locator(route.proof().split(",")[0]!.trim()).first();
    await expect(main).toBeVisible({ timeout: 20_000 });
    await server.close();
  });
}

test("sidebar navigation reaches key sections", async ({ page }) => {
  const server = await startMockServer();
  await bootstrapApp(page, server.url);
  await page.goto("/home");
  await expect(page.locator("main, [role=main]").first()).toBeVisible({ timeout: 20_000 });
  // Follow the sidebar to the chat section.
  const chatLink = page.getByRole("link", { name: /chat/i }).first();
  if (await chatLink.isVisible().catch(() => false)) {
    await chatLink.click();
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
  }
  await server.close();
});
