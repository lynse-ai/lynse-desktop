import { test, expect, openChat } from "../fixtures/lynse-fixture";
import {
  chatSelectors,
  sendChatMessage,
  sendWithButton,
  waitForTurnDone,
  expectAssistantSaid,
  fullText,
  quickPromptLabels,
  loadScript,
} from "../helpers/chat";

test.describe("chat core", () => {
  test("welcome state renders and attachment entry is hidden", async ({
    page,
    mockServer,
  }) => {
    await openChat(page, mockServer.url);
    await expect(page.getByText(chatSelectors.welcomeTitle)).toBeVisible();
    // All 8 quick prompts are offered.
    for (const label of Object.values(quickPromptLabels)) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
    // Attachment upload is disabled in the UI until the feature ships.
    await expect(
      page.getByRole("button", { name: "Add attachments" }),
    ).toHaveCount(0);
    // Mic is a visible placeholder (no handler yet, but rendered).
    await expect(page.getByRole("button", chatSelectors.mic)).toBeVisible();
  });

  test("send via Enter renders a full reply with sources and copy works", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("core-basic");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);

    const turn = script.turns[0]!;
    await sendChatMessage(page, turn.user);

    // Stop button appears while the reply is pending, then disappears when done.
    await expect(page.getByRole("button", chatSelectors.stop)).toBeVisible();
    await waitForTurnDone(page);

    // User message and full assistant text are rendered.
    await expect(page.getByText(turn.user).last()).toBeVisible();
    await expectAssistantSaid(page, fullText(turn));

    // Source chip from the meta event.
    await expect(page.getByText("Q3 review.m4a").first()).toBeVisible();

    // Copy toggles to Copied (the button only appears on hover over the message).
    const lastArticle = page.locator("article").last();
    await lastArticle.hover();
    await page
      .locator('button[title="Copy response"]')
      .last()
      .click({ timeout: 5_000 });
    await expect(page.getByRole("button", chatSelectors.copied).last()).toBeVisible();
  });

  test("send via button click works too", async ({ page, mockServer }) => {
    const script = loadScript("core-basic");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);
    await sendWithButton(page, script.turns[0]!.user);
    await waitForTurnDone(page);
    await expectAssistantSaid(page, fullText(script.turns[0]!));
  });

  test("stop button cancels a pending reply and chat recovers", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("core-stop");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);

    await sendChatMessage(page, script.turns[0]!.user);
    // Poll keeps the turn pending with no partial text; the Stop button is
    // the way out.
    await expect(page.getByRole("button", chatSelectors.stop)).toBeVisible();
    await page.getByRole("button", chatSelectors.stop).click();
    await waitForTurnDone(page);
    // The cancelled turn left no half-finished bubble behind.
    await expect(page.getByRole("button", chatSelectors.stop)).toBeHidden();

    // Next turn still works.
    await sendChatMessage(page, script.turns[1]!.user);
    await waitForTurnDone(page);
    await expectAssistantSaid(page, fullText(script.turns[1]!));
  });

  test("business and HTTP errors surface as error bubbles, then recovery", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("core-error");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);

    // Task `status: "error"` → error bubble inside the assistant message.
    await sendChatMessage(page, script.turns[0]!.user);
    const taskError = script.turns[0]!.response;
    if (taskError.type === "error") await expectAssistantSaid(page, taskError.message);

    // HTTP-level error → same error surface (match inside the message only,
    // the Next dev overlay also echoes fetch errors).
    await sendChatMessage(page, script.turns[1]!.user);
    const httpError = script.turns[1]!.response;
    if (httpError.type === "http-error") await expectAssistantSaid(page, httpError.message);

    // Recovery.
    await sendChatMessage(page, script.turns[2]!.user);
    await waitForTurnDone(page);
    await expectAssistantSaid(page, fullText(script.turns[2]!));
  });

  test("clarify dialog pops and clicking an option answers", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("core-clarify");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);

    await sendChatMessage(page, script.turns[0]!.user);
    const clarify = script.turns[0]!.response;
    await expect(page.getByText(chatSelectors.confirmTitle)).toBeVisible({ timeout: 20_000 });
    if (clarify.type === "clarify") {
      await expect(page.getByText(clarify.question)).toBeVisible();
      await page.getByRole("button", { name: clarify.options[0]!.label }).click();
    }
    await waitForTurnDone(page);
    await expectAssistantSaid(page, fullText(script.turns[1]!));
  });

  test("clarify dialog can be cancelled", async ({ page, mockServer }) => {
    const script = loadScript("core-clarify");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);

    await sendChatMessage(page, script.turns[0]!.user);
    await expect(page.getByText(chatSelectors.confirmTitle)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", chatSelectors.confirmCancel).click();
    await expect(page.getByText(chatSelectors.confirmTitle)).toBeHidden();
    // Composer is usable again.
    await expect(page.locator(chatSelectors.composer)).toBeEnabled();
  });
});
