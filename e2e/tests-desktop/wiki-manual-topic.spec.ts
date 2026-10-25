import { resolve } from "node:path";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { installAutomaticWiki, openWiki } from "../fixtures/wiki-automatic";
import type { WikiState, WikiTopic, WikiTopicLink } from "../../packages/views/workbench/types";

const ref = { id: "meeting-1", kind: "meeting_summary", revision: "r1", quote: "灵光记项目完成原型，客户反馈仍需整理。" };
function ordinary(id: string, title: string): WikiTopic {
  return { id, title, purpose: "", notes: "", pinned: false, excluded: false, stale: false, candidate: null, error: "", inScope: true,
    published: { id: `page-${id}`, markdown: `# ${title}\n\nOriginal topic content.`, citations: [ref], fingerprint: "fixture", createdAt: "2026-10-23", reviewedAt: "", review: "auto_validated" } };
}
function link(targetId: string, state: WikiTopicLink["state"]): WikiTopicLink {
  return { targetId, state, manual: false, reason: "The cited prototype decision supports the requested delivery work.", citations: [ref], events: [], fingerprint: "fixture", error: "" };
}
function manual(): WikiTopic {
  return { ...ordinary("manual", "Product delivery"), purpose: "Track requirements and decisions", collection: { status: "ready", completed: 3, total: 3, links: [
    { ...link("prototype", "included"), events: [
      { id: "record", text: "Prototype review recorded", date: "2026-10-25", dateBasis: "record", citations: [ref] },
      { id: "early", text: "Prototype proposed, not approved", date: "2026-10-01", dateBasis: "event", citations: [ref] },
      { id: "undated", text: "Feedback date remains unknown", date: "", dateBasis: "unknown", citations: [ref] },
    ] }, link("feedback", "candidate"), link("ads", "excluded") ] } };
}
async function state(page: Parameters<typeof installAutomaticWiki>[0]) {
  return page.evaluate(async () => (window as unknown as { desktopAPI: { workbench: { wiki: (request: { action: string }) => Promise<WikiState> } } }).desktopAPI.workbench.wiki({ action: "state" }));
}

test("creates a visible manual topic and opens its saved pending reader", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url); await installAutomaticWiki(page); await openWiki(page);
  await page.getByRole("button", { name: "Topic directory", exact: true }).click();
  await page.getByRole("button", { name: "New topic", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New topic", exact: true });
  await dialog.getByRole("textbox").first().fill("Multimodal delivery");
  await dialog.getByRole("textbox", { name: "What would you like to track?", exact: true }).fill("Requirements and release decisions");
  await dialog.getByRole("button", { name: "Create and organize", exact: true }).click();
  const reader = page.getByRole("article", { name: "Multimodal delivery", exact: true });
  await expect(reader).toBeVisible(); await expect(reader).toContainText("Waiting to organize related topics");
  await expect(reader.getByRole("button", { name: "Edit topic focus", exact: true })).toBeVisible();
  const created = (await state(page)).topics.find(topic => topic.title === "Multimodal delivery")!;
  expect(created.collection).toBeTruthy(); expect(created.published).toBeNull();
  await reader.getByRole("button", { name: "Back to knowledge base", exact: true }).click();
  await expect(page.getByRole("button", { name: /Multimodal delivery/ })).toBeVisible();
});

test("an empty directory can save a manual topic while AI is disabled", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url); await installAutomaticWiki(page, true, { topics: [] });
  await page.evaluate(() => (window as unknown as { wikiTest: { patch: (status: Record<string, unknown>) => void } }).wikiTest.patch({ allowAi: false }));
  await openWiki(page); await page.getByRole("button", { name: "New topic", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New topic", exact: true });
  await dialog.getByRole("textbox").first().fill("Saved direction");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("article", { name: "Saved direction", exact: true })).toContainText("Waiting for AI organization to be enabled");
  expect((await state(page)).topics[0]?.collection).toBeTruthy();
});

test("orders dates and allows confirming, removing and restoring topic associations", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page, true, { topics: [manual(), ordinary("prototype", "Prototype"), ordinary("feedback", "Feedback"), ordinary("ads", "Ads")] });
  await openWiki(page); await page.getByRole("button", { name: "Topic directory", exact: true }).click();
  await page.getByRole("region", { name: "Topic directory", exact: true }).getByRole("button", { name: /Product delivery/ }).click();
  const reader = page.getByRole("article", { name: "Product delivery", exact: true });
  const timeline = reader.getByRole("region", { name: "Timeline", exact: true });
  const text = await timeline.innerText();
  expect(text.indexOf("Prototype review recorded")).toBeLessThan(text.indexOf("Prototype proposed, not approved"));
  expect(text.indexOf("Prototype proposed, not approved")).toBeLessThan(text.indexOf("Feedback date remains unknown"));
  await expect(timeline).toContainText("Record date"); await expect(timeline).toContainText("Date to confirm");
  const candidates = reader.getByRole("region", { name: "Associations to confirm", exact: true });
  await candidates.getByRole("button", { name: "Include", exact: true }).click();
  await expect(candidates).toHaveCount(0);
  const related = reader.getByRole("region", { name: "Related topics", exact: true });
  const feedback = related.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Feedback", exact: true }) });
  await expect(feedback).toContainText("Your choice");
  await feedback.getByRole("button", { name: "Remove from this topic", exact: true }).click();
  await expect(feedback).toHaveCount(0);
  await reader.getByText("Removed from this topic", { exact: true }).click();
  await reader.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Feedback", exact: true }) }).getByRole("button", { name: "Include again", exact: true }).click();
  await expect(feedback).toBeVisible();
  expect((await state(page)).topics.find(topic => topic.id === "feedback")?.published?.markdown).toContain("Original topic content");
  expect((await state(page)).topics.find(topic => topic.id === "feedback")?.excluded).toBe(false);
  await page.setViewportSize({ width: 680, height: 900 });
  expect(await reader.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await timeline.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("manual-topic-timeline.png"), fullPage: true });
});

test("old services show a detailed actionable failure instead of indefinite processing", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  const topic = manual(); topic.error = "Lynclaw synthesis failed (HTTP 422): Unknown synthesis task";
  topic.collection!.status = "failed";
  topic.failure = { message: topic.error, stage: "analyzing", sourceIds: [ref.id], occurredAt: "2026-10-25T04:00:00Z" };
  await installAutomaticWiki(page, true, { topics: [topic, ordinary("prototype", "Prototype")] }); await openWiki(page);
  const failure = page.getByRole("region", { name: "Topics needing attention", exact: true });
  await expect(failure).toContainText("service");
  await failure.getByText("Error details", { exact: true }).click();
  await expect(failure).toContainText("Unknown synthesis task");
  await expect(page.getByText(/Finding related topics/)).toHaveCount(0);
});


test("Chinese manual topics show progress and retain an edited focus", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  const topic=manual();topic.published=null;topic.collection!.status="matching";topic.collection!.completed=2;topic.collection!.total=3;
  await installAutomaticWiki(page,true,{topics:[topic,ordinary("prototype","Prototype")]});await openWiki(page);
  await page.evaluate(async url=>{await(await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await page.getByRole("button",{name:"专题目录",exact:true}).click();
  await page.getByRole("region",{name:"专题目录",exact:true}).getByRole("button",{name:/Product delivery/}).click();
  const reader=page.getByRole("article",{name:"Product delivery",exact:true});
  await expect(reader.getByRole("status")).toContainText("正在关联专题 · 2/3");
  await reader.getByRole("button",{name:"编辑关注点",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"编辑关注点",exact:true});
  await dialog.getByRole("textbox",{name:"希望追踪什么",exact:true}).fill("追踪原型发布及反馈");
  await dialog.getByRole("button",{name:"保存并更新",exact:true}).click();
  await expect(reader.getByText("追踪原型发布及反馈",{exact:true})).toBeVisible();
  const saved=(await state(page)).topics.find(item=>item.id==="manual")!;
  expect(saved.collection?.links[2]?.state).toBe("excluded");
  await expect(reader.getByRole("button",{name:"查看依据 1",exact:true}).first()).toBeVisible();
});

test("a failed association can be removed without excluding its original topic", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  const topic=manual(); topic.error="Network unavailable";topic.collection!.status="failed";
  topic.collection!.links[0]!.error="Network unavailable";
  await installAutomaticWiki(page,true,{topics:[topic,ordinary("prototype","Prototype")]});await openWiki(page);
  await page.getByRole("button",{name:"Topic directory",exact:true}).click();
  await page.getByRole("region",{name:"Topic directory",exact:true}).getByRole("button",{name:/Product delivery/}).click();
  const failed=page.getByRole("article",{name:"Product delivery",exact:true}).getByRole("region",{name:"Failed associations",exact:true});
  await expect(failed).toContainText("Network unavailable");
  await failed.getByRole("button",{name:"Remove from this topic",exact:true}).click();
  await expect(failed).toHaveCount(0);
  const saved=await state(page);
  expect(saved.topics.find(item=>item.id==="prototype")?.excluded).toBe(false);
  expect(saved.topics.find(item=>item.id==="manual")?.collection?.links[0]).toMatchObject({state:"excluded",manual:true});
});
