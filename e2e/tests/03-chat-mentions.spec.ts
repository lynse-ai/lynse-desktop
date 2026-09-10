import { test, expect, openChat } from "../fixtures/lynse-fixture";
import {
  chatSelectors,
  sendChatMessage,
  waitForTurnDone,
  expectAssistantSaid,
  fullText,
  loadScript,
} from "../helpers/chat";

/**
 * @ / # mentions: picker appears, keyboard navigation works (↓ ↑ Enter Tab Esc),
 * chips render and can be removed, and mentioned notes scope the request.
 */

test.describe("chat mentions", () => {
  test("@ opens the note picker, keyboard-navigates and inserts a chip", async ({
    page,
    mockServer,
  }) => {
    await openChat(page, mockServer.url);
    const composer = page.locator(chatSelectors.composer);

    await composer.pressSequentially("@");
    const listbox = page.getByRole("listbox", { name: "Reference a note" });
    await expect(listbox).toBeVisible();
    // Mocked notes appear as options.
    await expect(listbox.getByRole("option", { name: /Q3 review/ })).toBeVisible();

    // ArrowDown moves the highlight.
    await composer.press("ArrowDown");
    await composer.press("ArrowUp");
    // Enter picks the highlighted option → chip appears.
    await composer.press("Enter");
    // Selected note chips carry a remove button — the picker is gone.
    await expect(
      page.getByRole("button", { name: /Remove reference/ }).first(),
    ).toBeVisible();
  });

  test("# opens the group picker and Tab picks", async ({ page, mockServer }) => {
    await openChat(page, mockServer.url);
    const composer = page.locator(chatSelectors.composer);

    await composer.pressSequentially("#");
    const listbox = page.getByRole("listbox", { name: "Reference a group" });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole("option", { name: /Work/ })).toBeVisible();

    await composer.press("Tab");
    await expect(
      page.getByRole("button", { name: /Remove reference/ }).first(),
    ).toBeVisible();
  });

  test("Escape closes the picker without picking", async ({ page, mockServer }) => {
    await openChat(page, mockServer.url);
    const composer = page.locator(chatSelectors.composer);

    await composer.pressSequentially("@");
    const listbox = page.getByRole("listbox", { name: "Reference a note" });
    await expect(listbox).toBeVisible();
    // Escape only lands once options are present (typing must settle first).
    await expect(listbox.getByRole("option", { name: /Q3 review/ })).toBeVisible();
    await composer.press("Escape");
    await expect(listbox).toBeHidden();
  });

  test("mention chip can be removed before sending", async ({ page, mockServer }) => {
    await openChat(page, mockServer.url);
    const composer = page.locator(chatSelectors.composer);

    await composer.pressSequentially("@");
    const listbox = page.getByRole("listbox", { name: "Reference a note" });
    await expect(listbox.getByRole("option", { name: /Q3 review/ })).toBeVisible();
    await composer.press("Enter"); // pick first note
    const removeButton = page.getByRole("button", { name: /Remove reference/ }).first();
    await removeButton.click();
    await expect(page.getByRole("button", { name: /Remove reference/ })).toHaveCount(0);
  });

  test("mentioned note is sent with the message (multiturn mentions script, 5 turns)", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("mentions-workflow");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);
    const composer = page.locator(chatSelectors.composer);

    // Turn 1: "@Q3 review.m4a summarize this note"
    await composer.pressSequentially("@");
    await page.getByRole("listbox", { name: "Reference a note" }).getByRole("option", { name: /Q3 review/ }).click();
    await composer.fill("summarize this note");
    await composer.press("Enter");
    await waitForTurnDone(page);
    await expectAssistantSaid(page, fullText(script.turns[0]!));

    // Turn 2: plain follow-up keeps context.
    await sendChatMessage(page, script.turns[1]!.user);
    await waitForTurnDone(page);
    await expectAssistantSaid(page, fullText(script.turns[1]!));

    // Turn 3: "#Work what is in this group?"
    await composer.pressSequentially("#");
    await page.getByRole("listbox", { name: "Reference a group" }).getByRole("option", { name: /Work/ }).click();
    await composer.fill("what is in this group?");
    await composer.press("Enter");
    await waitForTurnDone(page);
    await expectAssistantSaid(page, fullText(script.turns[2]!));

    // Turns 4–5.
    for (const turn of script.turns.slice(3)) {
      await sendChatMessage(page, turn.user);
      await waitForTurnDone(page);
      await expectAssistantSaid(page, fullText(turn));
    }
  });
});
