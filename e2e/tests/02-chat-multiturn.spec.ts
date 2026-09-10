import { test, expect, openChat } from "../fixtures/lynse-fixture";
import { replayScript, loadScript, loadScriptsBySuite, sendChatMessage, waitForTurnDone,
  expectAssistantSaid, fullText } from "../helpers/chat";

/**
 * Replays every multiturn script in e2e/scripts/ (suite === "multiturn").
 * Each script has ≥ 5 turns and mixes stream / clarify / error / abort
 * response types (poll tasks that complete, pop a card, fail, or stay
 * pending); replayScript asserts the UI after each turn.
 * Add or edit scripts freely — this spec picks them up automatically.
 */

const multiturnScripts = loadScriptsBySuite("multiturn");

test.describe("chat multiturn scripts", () => {
  for (const script of multiturnScripts) {
    test(`script: ${script.name} (${script.turns.length} turns) — ${script.description}`, async ({
    page,
    mockServer,
  }) => {
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);
    await replayScript(page, script);
  });
  }

  test("all-quick-prompts script covers all 8 chips", () => {
    const script = loadScript("all-quick-prompts");
    expect(script.turns.length).toBe(8);
    expect(script.turns.every((t) => !!t.quickPrompt)).toBe(true);
  });

  test("every multiturn script has >= 5 turns", () => {
    expect(multiturnScripts.length).toBeGreaterThanOrEqual(8);
    for (const script of multiturnScripts) {
      expect(
        script.turns.length,
        `${script.name} must have >= 5 turns`,
      ).toBeGreaterThanOrEqual(5);
    }
  });
});

test.describe("history restore after reload", () => {
  test("history-restore: 5 turns, reload, conversation resumes", async ({
    page,
    mockServer,
  }) => {
    const script = loadScript("history-restore");
    mockServer.setChatScript(script);
    await openChat(page, mockServer.url);

    // First five turns.
    for (const turn of script.turns.slice(0, 5)) {
      await sendChatMessage(page, turn.user);
      await waitForTurnDone(page);
      await expectAssistantSaid(page, fullText(turn));
    }

    // Give the persisted-history save a moment before reloading.
    await page.waitForTimeout(1_500);
    // Reload — the persisted history must survive.
    await page.reload();
    await expect(page.getByPlaceholder("Ask about your recordings, meetings...")).toBeVisible({
      timeout: 20_000,
    });
    await expectAssistantSaid(page, fullText(script.turns[4]!));

    // Turn six continues in the same conversation (same sessionId).
    await sendChatMessage(page, script.turns[5]!.user);
    await waitForTurnDone(page);
    await expectAssistantSaid(page, fullText(script.turns[5]!));
  });
});
