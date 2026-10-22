import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { loadScript } from "../helpers/chat";

/**
 * Desktop workspace: docked AI-assistant panel end-to-end through the real
 * Tauri renderer (IPC shim + mock backend). Mirrors the flow a desktop user
 * performs: launch → workspace → "Ask AI" → chat in the docked panel.
 */
test.describe("desktop chat panel", () => {
  test("Ask AI opens the docked panel and a scripted exchange renders", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("core-basic");
    mockServer.setChatScript(script);

    await openWorkspace(page, mockServer.url);

    // The desktop app lands on Home; the docked chat panel lives on the
    // Notes workspace surface once a note is open (title bar → Ask AI).
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "Notes" })
      .click();
    await page.getByRole("button", { name: /Q3 review\.m4a/ }).click();
    const askAi = page.getByTitle("Ask AI");
    await expect(askAi).toBeVisible({ timeout: 10_000 });
    await askAi.click();

    // Turn one through the docked panel composer (plain Input + Enter).
    const composer = page.getByPlaceholder("Ask about this file…");
    await expect(composer).toBeVisible();
    await composer.fill(script.turns[0]!.user);
    await composer.press("Enter");

    // The reply streams into the panel (panel bubbles are plain divs, not
    // <article>, so match against the whole page text).
    const words = (script.turns[0]!.response.type === "stream"
      ? script.turns[0]!.response.chunks.join("")
      : ""
    ).match(/[\p{L}\p{N}]{3,}/gu);
    if (words && words.length > 0) {
      await expect
        .poll(async () => {
          const body = (await page.locator("body").textContent()) ?? "";
          return words.every((w) => body.includes(w));
        }, { timeout: 20_000 })
        .toBe(true);
    }
  });

  test("visual-summary images open across the full window from the Notes sidebar", async ({ page, mockServer }) => {
    const script = loadScript("attachments-report");
    mockServer.setChatScript(script);
    // Use a full-size image so the preview must visibly grow beyond the thumbnail.
    await page.route("**/mock-assets/visual-summary.png", (route) => route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400"><rect width="1000" height="1400" fill="white"/><text x="60" y="100" font-size="48">Visual summary</text></svg>',
    }));
    await openWorkspace(page, mockServer.url);
    await page.getByRole("complementary").getByRole("button", { name: "Notes", exact: true }).click();
    await page.getByRole("button", { name: /Q3 review\.m4a/ }).click();
    await page.getByTitle("Ask AI").click();

    const composer = page.getByPlaceholder("Ask about this file…");
    await composer.fill(script.turns[0]!.user);
    await composer.press("Enter");
    const thumbnail = page.getByRole("img", { name: "灵光记图文总结-2026-09-26-weekly.png" });
    await expect(thumbnail).toBeVisible();
    const thumbnailBox = await thumbnail.boundingBox();
    await thumbnail.click();

    const stage = page.getByTestId("chat-image-stage");
    const viewport = page.viewportSize()!;
    // A fixed overlay inside the blurred, clipped sidebar inherits its bounds.
    await expect.poll(() => stage.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
    const image = stage.getByRole("img");
    await expect(image).toBeVisible();
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(thumbnailBox!.width);
    const fittedWidth = (await image.boundingBox())!.width;
    await page.getByTestId("chat-image-zoom-in").click();
    await expect(page.getByTestId("chat-image-zoom-level")).toHaveText("125%");
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fittedWidth);
    await page.getByTestId("chat-image-zoom-reset").click();
    await expect(page.getByTestId("chat-image-zoom-level")).toHaveText("100%");
    await page.screenshot({ path: test.info().outputPath("notes-image-preview.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(stage).toHaveCount(0);

    await thumbnail.click();
    await expect(stage.getByRole("img")).toBeVisible();
    await stage.click({ position: { x: 24, y: viewport.height / 2 } });
    await expect(stage).toHaveCount(0);
    await expect(composer).toBeVisible();
  });

  test("settings dialog opens from the sidebar", async ({ page, mockServer }) => {
    await openWorkspace(page, mockServer.url);
    await page.getByRole("button", { name: "E2", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
  });
});
