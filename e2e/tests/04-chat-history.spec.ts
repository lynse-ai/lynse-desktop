import { test, expect, openChat } from "../fixtures/lynse-fixture";
import {
  chatSelectors,
  sendChatMessage,
  waitForTurnDone,
  expectAssistantSaid,
  fullText,
  loadScript,
} from "../helpers/chat";

test.describe("chat history sidebar", () => {
  test("empty history state, then conversation appears after first exchange", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("core-basic");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);

    await page.getByRole("button", chatSelectors.historyToggle).click();
    await expect(
      page.getByText("No previous conversations yet. New chats are saved here automatically."),
    ).toBeVisible();

    // Close sidebar, run one exchange.
    await page.getByRole("button", chatSelectors.historyToggle).click();
    await sendChatMessage(page, script.turns[0]!.user);
    await waitForTurnDone(page);

    await page.getByRole("button", chatSelectors.historyToggle).click();
    // The conversation is listed (title derives from the first user message).
    await expect(
      page.getByRole("button", { name: /Q3 review recording/ }).first(),
    ).toBeVisible();
  });

  test("new chat starts a fresh conversation and old one is switchable", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("core-basic");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);

    // First conversation.
    await sendChatMessage(page, script.turns[0]!.user);
    await waitForTurnDone(page);
    const firstReply = fullText(script.turns[0]!);

    // New chat — composer clears, welcome back.
    await page.getByRole("button", chatSelectors.newChat).click();
    await expect(page.getByText(chatSelectors.welcomeTitle)).toBeVisible();

    // History lists the first conversation; switching restores its messages.
    await page.getByRole("button", chatSelectors.historyToggle).click();
    await page.getByRole("button", { name: /Q3 review recording/ }).first().click();
    await expectAssistantSaid(page, firstReply);
  });
});
