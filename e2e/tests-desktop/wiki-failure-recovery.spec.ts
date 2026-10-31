import { resolve } from "node:path";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { installAutomaticWiki, openWiki } from "../fixtures/wiki-automatic";
import type { WikiState, WikiTopic, WikiValidationDetails } from "../../packages/views/workbench/types";

const error = "Lynclaw synthesis failed (HTTP 422): Citation does not match source evidence";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lynse_test_mode", "1"));
});

test("source failures explain authorization and keep completed pages on retry", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  const completed = failedTopic("completed", "Saved topic");
  completed.error = ""; completed.failure = null; completed.stale = false;
  completed.published = { id: "saved-revision", markdown: "# Saved topic\n\nKeep this content.", citations: [], fingerprint: "saved", createdAt: "2026-10-24T04:00:00Z", reviewedAt: "", review: "auto_validated" };
  await installAutomaticWiki(page, true, { topics: [completed], sourceFailures: [
    { id: "failed-chunk", sourceId: "meeting-1", title: "Budget review", stage: "analyzing", message: "Cloud knowledge identity verification failed", occurredAt: "2026-10-28T00:50:00Z" },
    { id: "organization", sourceId: "", title: "", stage: "preparing", message: "Cloud knowledge organization is not enabled on this server", occurredAt: "2026-10-28T00:51:00Z" },
    { id: "catalog-format", sourceId: "meeting-1", title: "Catalog extraction", stage: "analyzing", message: "Lynclaw synthesis failed (HTTP 422): Invalid Wiki catalog output", occurredAt: "2026-10-28T00:52:00Z" },
  ] });
  await page.evaluate(() => (window as unknown as { wikiTest: { patch: (status: Record<string, unknown>) => void } }).wikiTest.patch({ phase: "failed", error: "Cloud knowledge organization is not enabled on this server" }));
  await openWiki(page);
  const region = page.getByRole("region", { name: "Sources needing attention", exact: true });
  await region.locator("summary").filter({ hasText: "Budget review" }).click();
  await expect(region).toContainText("Cloud knowledge identity verification failed");
  await expect(region.getByRole("button", { name: "Check sign-in", exact: true })).toBeVisible();
  await region.locator("summary").filter({ hasText: "Organization setup" }).click();
  await expect(region).toContainText("selected server");
  await expect(region.locator("time").first()).toHaveAttribute("datetime", "2026-10-28T00:50:00Z");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await region.locator("summary").filter({ hasText: "Catalog extraction" }).click();
  await expect(region).toContainText("AI topic catalog failed format or source validation");
  await expect(region).toContainText("You do not need to change the meeting text");
  await expect(region).toContainText("Invalid Wiki catalog output");
  await expect(region).toContainText("This record does not contain the specific failed field");
  await region.getByRole("button", { name: "Retry failed work", exact: true }).click();
  const saved = await page.evaluate(async () => (await (window as unknown as { desktopAPI: { workbench: { wiki(request: { action: "state" }): Promise<WikiState> } } }).desktopAPI.workbench.wiki({ action: "state" })).topics[0]!);
  expect(saved.published?.id).toBe("saved-revision");
  expect(saved.published?.markdown).toContain("Keep this content.");
});

test.describe("catalog rule diagnostics", () => {
  test.use({ timezoneId: "Asia/Shanghai" });
  test("Chinese saved catalog failures show their rule and keep paused work unchanged", async ({ page, mockServer }) => {
    await openWorkspace(page, mockServer.url);
    const message = "Lynclaw synthesis failed (HTTP 422): Invalid Wiki catalog output";
    await installAutomaticWiki(page, true, { sourceFailures: [
      { id: "typed-catalog", sourceId: "meeting-1", title: "目录结果", stage: "analyzing", message,
        occurredAt: "2026-10-28T16:43:57.573Z", validation: { correctionAttempted: true,
          catalogIssue: { code: "duplicate_key", topicIndex: 1, field: "key" } } },
      { id: "legacy-catalog", sourceId: "meeting-1", title: "旧目录记录", stage: "analyzing", message,
        occurredAt: "2026-10-28T16:43:57.573Z" },
    ] });
    await page.evaluate(() => (window as unknown as { wikiTest: { patch: (status: Record<string, unknown>) => void } })
      .wikiTest.patch({ enabled: false, allowAi: false, phase: "ready" }));
    await openWiki(page);
    await page.evaluate(async url => { await (await import(url)).changeLanguage("zh-Hans"); }, `/@fs${resolve(__dirname, "../../packages/core/i18n/react.ts")}`);
    const region = page.getByRole("region", { name: "需要处理的资料", exact: true });
    await expect(region).toContainText("自动整理已暂停，当前显示的是此前保留的失败记录。");
    await region.locator("summary").filter({ hasText: "目录结果" }).click();
    await expect(region).toContainText("AI 为多个专题生成了相同的内部标识。");
    await expect(region).toContainText("第 2 个专题条目");
    await expect(region).toContainText("duplicate_key · key");
    await expect(region).toContainText("已尝试一次自动纠正，仍未通过校验。");
    await expect(region.locator("time").first()).toContainText("2026/10/29 00:43:57");
    await region.locator("summary").filter({ hasText: "旧目录记录" }).click();
    await expect(region).toContainText("这条记录未保存具体失败字段");
    await expect(region.getByRole("button", { name: "检查 AI 模型设置", exact: true })).toHaveCount(0);
    await expect(region.getByRole("button", { name: "重试失败项", exact: true })).toBeDisabled();
    const requests = await page.evaluate(() => {
      const fixture = (window as unknown as { wikiTest: { configure: unknown[]; requests: { action: string }[] } }).wikiTest;
      return { configured: fixture.configure, retries: fixture.requests.filter(request => request.action === "retry") };
    });
    expect(requests).toEqual({ configured: [], retries: [] });
    await page.screenshot({ path: test.info().outputPath("catalog-rule-zh.png"), fullPage: true, animations: "disabled" });
  });
});

test("a queued source retry shows its pending state instead of reporting a fresh failure", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page, true, { sourceFailures: [
    { id: "retry-source", sourceId: "meeting-1", title: "Launch", stage: "analyzing", retrying: true,
      message: "Lynclaw synthesis failed (HTTP 422): Invalid Wiki catalog output", occurredAt: "2026-10-31T01:31:03Z",
      validation: { correctionAttempted: true, catalogIssue: { code: "missing_new_source", topicIndex: 7, field: "citations" } } },
  ] });
  await page.evaluate(() => (window as unknown as { wikiTest: { patch: (status: Record<string, unknown>) => void } }).wikiTest.patch({ phase: "processing" }));
  await openWiki(page);
  const region = page.getByRole("region", { name: "Sources needing attention", exact: true });
  await expect(region.locator("summary").first()).toHaveText("Launch — Waiting for retry results");
  await expect(region.getByRole("status")).toContainText("previous attempt");
  await expect(region.getByRole("button", { name: "Waiting for retry results", exact: true })).toBeDisabled();
  await expect(region.getByRole("button", { name: "Report organization issue", exact: true })).toHaveCount(0);
});

test("source citation failures offer a report prefilled with diagnostics", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page, true, { sourceFailures: [
    { id: "failed-source", sourceId: "meeting-1", title: "Launch", stage: "analyzing", message: error,
      occurredAt: "2026-10-31T01:46:35Z", validation: { correctionAttempted: true,
        citationIssue: { code: "quote_not_found", sourceId: "meeting-1", citationIndex: 0, location: "citations" } } },
  ] });
  await openWiki(page);
  const region = page.getByRole("region", { name: "Sources needing attention", exact: true });
  await region.locator("summary").first().click();
  await expect(region).toContainText("You do not need to edit the meeting text or add context");
  await region.getByRole("button", { name: "Report organization issue", exact: true }).click();
  const description = page.locator("#report-description");
  await expect(description).toHaveValue(/Knowledge organization failed: Launch/);
  await expect(description).toHaveValue(/quote_not_found/);
  await expect(description).toHaveValue(/2026-10-31T01:46:35Z/);
  await expect(description).toHaveValue(/Citation does not match source evidence/);
});
function failedTopic(id: string, title: string): WikiTopic {
  return { id, title, purpose: "Track the plan", notes: "Saved correction", error,
    pinned: false, excluded: false, stale: true, inScope: false, sourceIds: ["meeting-1"],
    published: null, candidate: null,
    failure: { message: error, stage: "analyzing", sourceIds: ["meeting-1"], occurredAt: "2026-10-25T04:00:00Z" },
  };
}
async function prepare(page: Parameters<typeof installAutomaticWiki>[0], url: string, saved = false, options: { error?: string; validation?: WikiValidationDetails } = {}) {
  await openWorkspace(page, url);
  const first = failedTopic("failed-1", "Image extraction");
  if (options.error) { first.error = options.error; first.failure!.message = options.error; }
  if (options.validation) first.failure!.validation = options.validation;
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
  await first.getByText("Citation issue details", { exact: true }).click();
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
  await first.getByRole("button", { name: "Reorganize topic", exact: true }).click();
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

test("insufficient evidence offers context after a rejected retry", async ({ page, mockServer }) => {
  const failures = await prepare(page, mockServer.url, false, { error: "No relevant source evidence found for this topic" });
  const first = failures.getByRole("article", { name: "Image extraction", exact: true });
  await page.evaluate(() => { (window as unknown as { wikiTest: { failNextRetry: boolean } }).wikiTest.failNextRetry = true; });
  await first.getByRole("button", { name: "Reorganize topic", exact: true }).click();
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

test("Chinese citation guidance explains ownership and supports deferring without exclusion", async ({ page, mockServer }) => {
  await prepare(page, mockServer.url);
  await page.evaluate(async url => { await (await import(url)).changeLanguage("zh-Hans"); }, `/@fs${resolve(__dirname, "../../packages/core/i18n/react.ts")}`);
  const failures = page.getByRole("region", { name: "需要处理的专题", exact: true });
  const first = failures.getByRole("article", { name: "Image extraction", exact: true });
  await expect(first).toContainText("你无需修改会议原文或补充说明");
  await expect(first.getByRole("button", { name: "检查 AI 模型设置", exact: true })).toHaveCount(0);
  await expect(first.getByRole("button", { name: "补充说明后重试", exact: true })).toHaveCount(0);
  await first.getByRole("button", { name: "稍后处理", exact: true }).click();
  await expect(first).toContainText("已暂时收起此提示");
  expect(await page.evaluate(() => (window as unknown as { wikiTest: { requests: { action: string }[] } }).wikiTest.requests.filter(request => request.action !== "state"))).toEqual([]);
  await first.getByRole("button", { name: "继续处理", exact: true }).click();
  await first.getByText("引用问题详情", { exact: true }).click();
  await expect(first).toContainText("本次未记录具体引用位置");
  await expect(first).toContainText("正在分析会议资料");
  await first.getByRole("button", { name: "排除此专题", exact: true }).click();
  const exclude = page.getByRole("dialog", { name: "排除「Image extraction」？", exact: true });
  await expect(exclude).toContainText("已保存的页面和会议原文会保留");
  await exclude.getByRole("button", { name: "取消", exact: true }).click();
  await failures.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("wiki-failure-details-zh.png"), fullPage: true, animations: "disabled" });
});


test("new diagnostics show the failed reference and an actual automatic correction", async ({ page, mockServer }) => {
  const failures = await prepare(page, mockServer.url, false, { validation: {
    correctionAttempted: true,
    citationIssue: { code: "quote_not_found", sourceId: "meeting-1", citationIndex: 1, location: "memoryItems[2].citations" },
  } });
  const first = failures.getByRole("article", { name: "Image extraction", exact: true });
  await expect(first).toContainText("could not be found in its source meeting");
  await expect(first).toContainText("One automatic correction was attempted");
  await first.getByText("Citation issue details", { exact: true }).click();
  await expect(first).toContainText("Extracted item 3, citation 2");
  await expect(first).not.toContainText("This attempt did not record");
  await expect(first.getByRole("button", { name: "Add context and retry", exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("wiki-citation-diagnostics.png"), fullPage: true, animations: "disabled" });
});


test("cloud connection failures show the failed check and open cloud settings", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page, true, { sourceFailures: [
    { id: "organization", sourceId: "", title: "", stage: "preparing",
      message: "Cloud knowledge connection failed (stage: capabilities; reason: timeout)", occurredAt: "2026-10-30T09:03:07Z" },
  ] });
  await page.evaluate(() => (window as unknown as { wikiTest: { patch: (status: Record<string, unknown>) => void } })
    .wikiTest.patch({ phase: "failed", error: "Cloud knowledge connection failed (stage: capabilities; reason: timeout)" }));
  await openWiki(page);
  const region = page.getByRole("region", { name: "Sources needing attention", exact: true });
  await region.locator("summary").first().click();
  await expect(region).toContainText("The cloud connection check timed out.");
  await expect(region).toContainText("Saved results are kept.");
  await expect(region.getByRole("button", { name: "Check AI model settings", exact: true })).toHaveCount(0);
  await region.getByRole("button", { name: "Check cloud connection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Knowledge base settings", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("cloud-connection-settings.png"), fullPage: true, animations: "disabled" });
});
