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
    await expect(page.getByText("AI Assistant").first()).toBeVisible();

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

  test("settings dialog opens from the sidebar", async ({ page, mockServer }) => {
    await openWorkspace(page, mockServer.url);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
  });
});
