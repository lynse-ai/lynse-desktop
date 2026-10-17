import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatScript } from "../fixtures/chat-script";

/** ── Selectors (English locale labels; see packages/views/locales/en.ts) ── */

export const chatSelectors = {
  composer: 'textarea[placeholder^="Ask about your recordings, meetings"]',
  send: { role: "button", name: "Send" },
  stop: { role: "button", name: "Stop" },
  historyToggle: { role: "button", name: "Chat history" },
  newChat: { role: "button", name: "New chat" },
  copy: { role: "button", name: "Copy response" },
  copied: { role: "button", name: "Copied" },
  welcomeTitle: "What would you like to know?",
  responding: "Generating a response…",
  thinking: "Thinking",
  confirmCancel: { role: "button", name: "Cancel" },
  mic: { role: "button", name: "Voice input" },
  attach: { role: "button", name: "Add attachments" },
};

export function composer(page: Page): Locator {
  return page.locator(chatSelectors.composer);
}

export function sendButton(page: Page): Locator {
  return page.getByRole("button", chatSelectors.send);
}

export function stopButton(page: Page): Locator {
  // Match the labels used by both full-page and docked chat surfaces.
  return page.locator('button[title="Stop"], button[aria-label="Stop"]');
}

/** Quick-prompt chips by i18n key → English label (chat/page.tsx QUICK_PROMPTS). */
export const quickPromptLabels: Record<string, string | RegExp> = {
  "chat.suggestion_summary": /^Meeting summary /,
  "chat.quick_minutes": /^Meeting minutes /,
  "chat.suggestion_actions": "Find key decisions and action items",
  "chat.quick_todos": /^To-do list /,
  "chat.suggestion_notes": /^Note digest /,
  "chat.quick_plan": /^Action plan /,
  "chat.quick_translate": "Translate the key points into English",
  "chat.quick_rewrite": "Rewrite this more concisely",
};

/** ── Actions ── */

/** Type a message and send it with Enter (mirrors real user input). */
export async function sendChatMessage(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** Send by clicking the Send button (covers the button path). */
export async function sendWithButton(page: Page, text: string) {
  await composer(page).fill(text);
  await sendButton(page).click();
}

/** Wait until the assistant turn finishes (Stop hidden, composer enabled). */
export async function waitForTurnDone(page: Page, timeout = 20_000) {
  await expect(stopButton(page)).toBeHidden({ timeout });
  await expect(composer(page)).toBeEnabled({ timeout });
}

/** The last assistant message bubble (StreamingMarkdown container). */
export function lastAssistantMessage(page: Page): Locator {
  return page.locator("[data-streaming-markdown], .markdown-body, article").last();
}

/** ── Script loading ── */

// Playwright runs with cwd = e2e/ (the config directory).
const scriptsDir = join(process.cwd(), "scripts");

export function loadScript(name: string): ChatScript {
  const raw = readFileSync(join(scriptsDir, `${name}.json`), "utf8");
  return JSON.parse(raw) as ChatScript;
}

export function loadScriptsBySuite(suite: string): ChatScript[] {
  return readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(scriptsDir, f), "utf8")) as ChatScript)
    .filter((s) => s.suite === suite);
}

/** Concatenate a turn's chunks into the expected final assistant text. */
export function fullText(turn: ChatScript["turns"][number]): string {
  return turn.response.type === "stream" || turn.response.type === "stream-abort"
    ? turn.response.chunks.join("")
    : "";
}

/**
 * Assert the last assistant bubble contains `text`, token-wise (words of ≥3
 * alphanumeric chars). Markdown decoration (list numbers, table pipes,
 * code-language labels) never reaches the DOM text, so exact-substring
 * matching is not robust.
 */
export async function expectAssistantSaid(page: Page, text: string) {
  const words = text.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  expect(words.length, "expected text must contain words").toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const body = (await page.locator("article").last().textContent()) ?? "";
        return words.every((w) => body.includes(w));
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Play one full script against the chat page, asserting each reply renders. */
export async function replayScript(page: Page, script: ChatScript) {
  for (const [i, turn] of script.turns.entries()) {
    if (turn.quickPrompt) {
      const label = quickPromptLabels[turn.quickPrompt];
      if (!label) throw new Error(`Unknown quickPrompt key: ${turn.quickPrompt}`);
      await page.getByRole("button", { name: label }).click();
      // Quick prompts now fill the composer for review before submission.
      await expect(composer(page)).not.toHaveValue("");
      await composer(page).press("Enter");
    } else {
      await sendChatMessage(page, turn.user);
    }
    if (turn.response.type === "stream") {
      await waitForTurnDone(page);
      await expectAssistantSaid(page, fullText(turn));
    } else if (turn.response.type === "clarify") {
      await expect(page.getByText(turn.response.question)).toBeVisible({ timeout: 20_000 });
    } else if (turn.response.type === "error" || turn.response.type === "http-error") {
      await expect(page.getByText(turn.response.message).last()).toBeVisible({
        timeout: 20_000,
      });
      await waitForTurnDone(page);
    } else if (turn.response.type === "stream-abort") {
      // The turn stays pending with no partial text — the caller stops it.
      await stopButton(page).click();
      await waitForTurnDone(page);
    }
    // i ensures unique assertion context in failure output.
    void i;
  }
}
