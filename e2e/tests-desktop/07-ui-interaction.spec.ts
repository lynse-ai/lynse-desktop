import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

test.beforeEach(async ({ page }) => {
  // All account hydration, polling and asset requests stay on local fixtures.
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
});

async function seedHistory(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem("lynse_ai_chat_history_v1:user-e2e", JSON.stringify({
      activeConversationId: "saved-0",
      conversations: Array.from({ length: 24 }, (_, i) => ({
        id: `saved-${i}`,
        title: `Meeting ${i} — decisions and follow-up actions`,
        provider: "cloud",
        createdAt: i + 1,
        updatedAt: i + 1,
        messages: [{
          id: `reply-${i}`, role: "assistant", timestamp: i + 1,
          content: Array.from({ length: 15 }, (_, n) => `### Decision ${n + 1}\n\nThe team agreed on the next milestone and owner.`).join("\n\n"),
        }],
      })),
    }));
  });
}

test("history reverses continuously, stays aligned and preserves the draft and list position", async ({ page, mockServer }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await seedHistory(page);
  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "AI Chat", exact: true }).click();
  const composer = page.getByPlaceholder("Ask about your recordings, meetings…");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await composer.fill("A draft that stays here");
  const toggle = page.getByRole("button", { name: "Chat history", exact: true });
  await toggle.click();
  const drawer = page.locator("#chat-history");
  await expect(drawer).toBeVisible();

  const gaps = await page.evaluate(async () => {
    const drawer = document.querySelector("#chat-history")!;
    const content = document.querySelector(".chat-history-offset")!;
    const composer = document.querySelectorAll(".chat-history-offset")[1]!;
    const gaps: number[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(requestAnimationFrame);
      gaps.push(Math.abs(drawer.getBoundingClientRect().right - content.getBoundingClientRect().left));
      gaps.push(Math.abs(content.getBoundingClientRect().left - composer.getBoundingClientRect().left));
    }
    return gaps;
  });
  expect(Math.max(...gaps)).toBeLessThan(1);
  const divider = page.locator('[data-slot="app-title-bar"] [data-slot="title-bar-divider"]').first();
  expect(Math.abs((await divider.boundingBox())!.x - ((await drawer.boundingBox())!.x + (await drawer.boundingBox())!.width))).toBeLessThan(1);
  const historyList = drawer.locator(".overflow-y-auto");
  await historyList.evaluate((el) => { el.scrollTop = 180; });
  const before = await historyList.evaluate((el) => el.scrollTop);
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // Reopen during the closing transition; the same list and draft survive.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await historyList.evaluate((el) => el.scrollTop)).toBe(before);
  await expect(composer).toHaveValue("A draft that stays here");
  await page.screenshot({ path: test.info().outputPath("chat-history-open.png"), animations: "disabled" });
});

test("a narrow window overlays history without squeezing the composer and respects reduced motion", async ({ page, mockServer }) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedHistory(page);
  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "AI Chat", exact: true }).click();
  const composer = page.getByPlaceholder("Ask about your recordings, meetings…");
  const before = await composer.boundingBox();
  const toggle = page.getByRole("button", { name: "Chat history", exact: true });
  await toggle.click();
  await expect(page.locator(".chat-page")).toHaveAttribute("data-history-overlay", "true");
  await expect(page.locator("#chat-history")).toBeVisible();
  expect(await composer.boundingBox()).toEqual(before);
  expect(await page.locator("#chat-history").evaluate((el) => el.getAnimations().length)).toBe(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("chat-history-narrow.png"), animations: "disabled" });
  // A pointer action on the uncovered composer dismisses the nonmodal panel.
  await composer.click({ position: { x: before!.width - 12, y: before!.height / 2 } });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(composer).toBeFocused();
});

test("a failed added summary stays local to its tab and retries in place without interrupting reading", async ({ page, mockServer }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // This scenario intentionally fails an HTTP request and refuses remote
    // assets. Keep application/React errors, including duplicate summary keys.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  const saved = { id: "summary-saved", fileId: "file-q3-review", templateName: "Saved summary", conclusionText: "The original summary stays available.", createdAt: "2026-09-01" };
  const recovered = { id: "summary-recovered", fileId: "file-q3-review", templateName: "Meeting summary", conclusionText: "Recovered summary with the final decisions.", createdAt: "2026-09-02" };
  mockServer.setJsonRoute("/api/business/file/conclusion/list", [saved]);
  mockServer.setJsonRoute("/api/business/file/outline/get", { outlineText: "<h1>Meeting outline</h1><p>Keep reading this content.</p>" });
  mockServer.setJsonRoute("/api/business/translate/prompt/categories", [{
    category: "Meetings",
    templates: [{ id: "template-meeting", name: "Meeting summary", alias: "", tags: "", category: "Meetings", isDefault: 1 }],
  }]);
  mockServer.setRoute("POST /api/business/file/ai", { status: 500, body: { message: "Temporary summary failure" }, delayMs: 300 });
  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: /Q3 review\.m4a/ }).click();
  await page.getByTitle("Add summary", { exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText("Summary generation failed", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("summary-failed.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Saved summary", exact: true }).click();
  await expect(page.getByText(saved.conclusionText, { exact: true })).toBeVisible();
  await expect(page.getByText("Summary generation failed", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await expect(page.getByText("Keep reading this content.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Meeting summary", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Summary generation failed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  mockServer.setRoute("POST /api/business/file/ai", { body: "summary-retry-task" });
  mockServer.setRoute("POST /api/business/file/ai/result", { body: { status: "PROCESSING" } });
  await page.getByRole("dialog").getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText("Generating summary", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Meeting summary", exact: true })).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("summary-pending.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  mockServer.setJsonRoute("/api/business/file/conclusion/list", [saved, recovered]);
  mockServer.setRoute("POST /api/business/file/ai/result", { body: { status: "COMPLETED", conclusion: { ...recovered, generateSuccess: true } } });
  await expect(page.getByText("New summary generated", { exact: true })).toBeVisible();
  // The task finishes, but the reader remains on the outline they chose.
  await expect(page.getByText("Keep reading this content.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Meeting summary", exact: true }).click();
  await expect(page.getByText(recovered.conclusionText, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Meeting summary", exact: true })).toHaveCount(1);
  expect(mockServer.requests({ method: "POST", path: "/api/business/file/ai" })).toHaveLength(2);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("summary-recovered.png"), animations: "disabled" });
});
