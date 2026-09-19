import { test, expect } from "@playwright/test";
import {
  bootstrapRealBackend,
  tagChatSessionsWithRunId,
  realRunId,
  appendChatNotes,
} from "../fixtures/real-backend";

/**
 * Real-backend AI chat smoke (P6): ONE real turn against the live API, with
 * the conversation's sessionId rewritten to the run id so the server-side
 * lynclaw Langfuse trace is attributable. No content assertions — the AI is
 * the system under observation, not the thing under test; the assertions
 * cover only what the UI must do (accept input, stream, finish).
 *
 * After the run:
 *   node scripts/langfuse-report.mjs --run-id <printed run id>
 */
test("real AI chat turn streams a reply and is Langfuse-attributable", async ({ page }) => {
  const runId = realRunId();
  bootstrapRealBackend(page);
  tagChatSessionsWithRunId(page, runId);

  await page.goto("/chat");
  const composer = page.getByPlaceholder("Ask about your recordings, meetings");
  await expect(composer).toBeVisible({ timeout: 30_000 });

  await composer.fill("用一句话告诉我现在可以怎么使用 Lynse 助手。");
  await composer.press("Enter");

  // Stop visible = turn in flight; hidden = finished (content or error).
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(stop).toBeHidden({ timeout: 180_000 });

  // Some reply text (or an explicit error bubble) must render — an empty
  // hang is a UI bug even when the AI misbehaves.
  await expect(page.locator("article").last()).not.toBeEmpty({ timeout: 30_000 });

  const note = [
    `run: ${runId}`,
    `finished: ${new Date().toISOString()}`,
    `report: node scripts/langfuse-report.mjs --run-id ${runId}`,
  ].join("\n");
  appendChatNotes(note);
  console.log(`[real-backend] run id: ${runId}`);
  console.log(`[real-backend] langfuse report: node scripts/langfuse-report.mjs --run-id ${runId}`);
});
