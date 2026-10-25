import { resolve } from "node:path";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { installAutomaticWiki, openWiki } from "../fixtures/wiki-automatic";
import type { WikiState, WikiTopic } from "../../packages/views/workbench/types";

const error = "Lynclaw synthesis failed (HTTP 422): Citation does not match source evidence";
function failedTopic(id: string, title: string): WikiTopic {
  return { id, title, purpose: "Track the plan", notes: "Saved correction", error,
    pinned: false, excluded: false, stale: true, inScope: false, sourceIds: ["meeting-1"],
    published: null, candidate: null,
    failure: { message: error, stage: "analyzing", sourceIds: ["meeting-1"], occurredAt: "2026-10-25T04:00:00Z" },
  };
}
async function prepare(page: Parameters<typeof installAutomaticWiki>[0], url: string, saved = false) {
  await openWorkspace(page, url);
  const first = failedTopic("failed-1", "Image extraction");
  if (saved) first.published = { id: "saved-page", markdown: "# Saved knowledge\n\nKeep this content.", citations: [], fingerprint: "saved", createdAt: "2026-10-24T04:00:00Z", reviewedAt: "", review: "auto_validated" };
  await installAutomaticWiki(page, true, { topics: [first, failedTopic("failed-2", "Ad planning")] });
  await page.evaluate(() => (window as unknown as { wikiTest: { patch: (status: Record<string, unknown>) => void } }).wikiTest.patch({ error: "Wiki processing failed for 2 topics; open Wiki to review and retry", wikiProgress: { stage: "complete", completed: 0, total: 2, failed: 2, currentTitle: "", topicTitle: "" } }));
  await openWiki(page);
  return page.getByRole("region", { name: "Topics needing attention", exact: true });
}

test("unpublished failures show details and sources, and retry only the selected topic", async ({ page, mockServer }) => {
  const failures = await prepare(page, mockServer.url);
  const first = failures.getByRole("article", { name: "Image extraction", exact: true });
  await expect(first).toBeVisible();
  await expect(failures.getByRole("article", { name: "Ad planning", exact: true })).toBeVisible();
  await first.getByText("Error details", { exact: true }).click();
  await expect(first).toContainText(error);
  await expect(first).toContainText("Analyzing meeting text");
  await expect(first.locator("time")).toHaveAttribute("datetime", "2026-10-25T04:00:00Z");
  await first.getByRole("button", { name: /^Open source:/ }).click();
  const source = page.getByRole("dialog", { name: "Source meetings", exact: true });
  await expect(source).toContainText("TRANSCRIPT_ONLY");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 680, height: 900 });
  expect(await failures.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("wiki-failure-details.png"), fullPage: true, animations: "disabled" });
  await first.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(failures.getByRole("article", { name: "Ad planning", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { wikiTest: { requests: { action: string }[] } }).wikiTest.requests.filter(request => request.action === "retry"))).toEqual([{ action: "retry", id: "failed-1" }]);
});

test("excluding a failed topic preserves its saved page and offers restoration", async ({ page, mockServer }) => {
  const failures = await prepare(page, mockServer.url, true);
  const first = failures.getByRole("article", { name: "Image extraction", exact: true });
  await first.getByRole("button", { name: "Exclude topic", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Exclude “Image extraction”?", exact: true });
  await expect(confirm).toContainText("saved pages and meeting sources are kept");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: "Exclude topic", exact: true }).click();
  await confirm.getByRole("button", { name: "Exclude topic", exact: true }).click();
  await expect(first).toHaveCount(0);
  await page.getByText("Excluded topics (1)", { exact: true }).click();
  const state = () => page.evaluate(async () => (window as unknown as { desktopAPI: { workbench: { wiki: (request: { action: string }) => Promise<WikiState> } } }).desktopAPI.workbench.wiki({ action: "state" }));
  const excluded = (await state()).topics.find(topic => topic.id === "failed-1")!;
  expect(excluded.excluded).toBe(true);
  expect(excluded.published?.markdown).toContain("Keep this content.");
  await page.getByRole("button", { name: "Restore topic", exact: true }).click();
  await expect(page.getByText("Excluded topics (1)", { exact: true })).toHaveCount(0);
  const restored = (await state()).topics.find(topic => topic.id === "failed-1")!;
  expect(restored.excluded).toBe(false);
  expect(restored.published).toEqual(excluded.published);
  await expect(failures.getByRole("article", { name: "Ad planning", exact: true })).toBeVisible();
});

test("a rejected retry keeps recovery guidance and allows a correction before retrying", async ({ page, mockServer }) => {
  const failures = await prepare(page, mockServer.url);
  const first = failures.getByRole("article", { name: "Image extraction", exact: true });
  await page.evaluate(() => { (window as unknown as { wikiTest: { failNextRetry: boolean } }).wikiTest.failNextRetry = true; });
  await first.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not apply this action" })).toBeVisible();
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: "Add context and retry", exact: true }).click();
  const correction = page.getByRole("dialog", { name: "Add context and retry", exact: true });
  await correction.getByRole("textbox", { name: "User-provided context", exact: true }).fill("Focus on the image upload plan.");
  await correction.getByRole("button", { name: "Save context and retry", exact: true }).click();
  await expect(correction).toHaveCount(0);
  await expect(first).toHaveCount(0);
  const requests = await page.evaluate(() => (window as unknown as { wikiTest: { requests: { action: string }[] } }).wikiTest.requests.filter(request => ["correction", "retry"].includes(request.action)));
  expect(requests.slice(-2)).toEqual([{ action: "correction", id: "failed-1", notes: "Focus on the image upload plan." }, { action: "retry", id: "failed-1" }]);
});

test("Chinese recovery guidance links to AI settings and explains exclusion", async ({ page, mockServer }) => {
  await prepare(page, mockServer.url);
  await page.evaluate(async url => { await (await import(url)).changeLanguage("zh-Hans"); }, `/@fs${resolve(__dirname, "../../packages/core/i18n/react.ts")}`);
  const failures = page.getByRole("region", { name: "需要处理的专题", exact: true });
  const first = failures.getByRole("article", { name: "Image extraction", exact: true });
  await expect(first).toContainText("若反复失败");
  await first.getByRole("button", { name: "检查 AI 模型设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.locator("button[aria-current='true']")).toContainText("AI");
  await page.keyboard.press("Escape");
  await first.getByText("错误详情", { exact: true }).click();
  await expect(first).toContainText("正在分析会议资料");
  await first.getByRole("button", { name: "排除此专题", exact: true }).click();
  const exclude = page.getByRole("dialog", { name: "排除「Image extraction」？", exact: true });
  await expect(exclude).toContainText("已保存的页面和会议原文会保留");
  await exclude.getByRole("button", { name: "取消", exact: true }).click();
  await failures.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("wiki-failure-details-zh.png"), fullPage: true, animations: "disabled" });
});
