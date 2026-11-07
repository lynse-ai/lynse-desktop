import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { installAutomaticWiki, openWiki } from "../fixtures/wiki-automatic";
import type { WikiTopic, WikiState } from "../../packages/views/workbench/types";

function issue(id:string,title:string,meeting:string):WikiTopic {
  return {id,title,purpose:"",notes:"Keep my correction",pinned:false,excluded:false,stale:false,error:"",inScope:true,candidate:null,
    published:{id:`saved-${id}`,markdown:`# ${title}\n\nKeep this original page.`,overview:title,review:"approved",fingerprint:"saved",createdAt:"2026-10-23",reviewedAt:"",citations:[{id:meeting,kind:"meeting",revision:"r1",quote:"Original evidence"}]},
    history:[{id:`history-${id}`,markdown:"Original reviewed history",citations:[],review:"approved",fingerprint:"old",createdAt:"2026-10-20",reviewedAt:""}]};
}

test("manual grouping combines meetings while preserving issues and reviewed history",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);
  await installAutomaticWiki(page,true,{topics:[issue("wifi","WiFi transfer","meeting-1"),issue("offline","Offline transcription","meeting-2")]});
  await openWiki(page);
  await page.getByRole("button",{name:"Group topics",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Group topics",exact:true});
  await dialog.getByPlaceholder("For example: Product development").fill("Product development");
  await dialog.getByRole("checkbox",{name:/WiFi transfer/}).check();
  await dialog.getByRole("checkbox",{name:/Offline transcription/}).check();
  await expect(dialog).toContainText("2 issues selected · 2 source meetings");
  await dialog.getByRole("button",{name:"Confirm grouping",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Product development",exact:true,level:2})).toBeVisible();
  await expect(page.getByRole("button",{name:"WiFi transfer",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Offline transcription",exact:true})).toBeVisible();
  const saved=await page.evaluate(async()=> (window as unknown as {desktopAPI:{workbench:{wiki(request:{action:"state"}):Promise<WikiState>}}}).desktopAPI.workbench.wiki({action:"state"}));
  expect(saved.topics).toHaveLength(3);
  expect(saved.topics.find(topic=>topic.id==="wifi")?.published?.id).toBe("saved-wifi");
  expect(saved.topics.find(topic=>topic.id==="wifi")?.history?.[0]?.id).toBe("history-wifi");
  await page.getByRole("button",{name:"WiFi transfer",exact:true}).click();
  await expect(page.getByRole("button",{name:"Parent topic: Product development",exact:true})).toBeVisible();
  await expect(page.getByText("Keep this original page.",{exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("internal-issue-and-parent.png"),fullPage:true,animations:"disabled"});
});

test("paused organization still allows local grouping and removing an internal issue",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);
  await installAutomaticWiki(page,true,{topics:[issue("wifi","WiFi transfer","meeting-1"),issue("offline","Offline transcription","meeting-2")]});
  await page.evaluate(()=> (window as unknown as {wikiTest:{patch:(status:Record<string,unknown>)=>void}}).wikiTest.patch({enabled:false,allowAi:false,phase:"ready"}));
  await openWiki(page);await page.getByRole("button",{name:"Group topics",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Group topics",exact:true});
  await dialog.getByPlaceholder("For example: Product development").fill("Product development");
  await dialog.getByRole("checkbox",{name:/WiFi transfer/}).check();
  await dialog.getByRole("checkbox",{name:/Offline transcription/}).check();
  await dialog.getByRole("button",{name:"Confirm grouping",exact:true}).click();
  const row=page.getByRole("listitem").filter({has:page.getByRole("button",{name:"WiFi transfer",exact:true})});
  await row.getByRole("button",{name:"Remove from this topic",exact:true}).click();
  await expect(page.getByText("Removed from this topic",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Back to knowledge base",exact:true}).click();
  await page.getByRole("button",{name:"Topic directory",exact:true}).click();
  await expect(page.getByText("Issues awaiting grouping (1)",{exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"WiFi transfer",exact:true,level:3})).toBeHidden();
  await page.getByText("Issues awaiting grouping (1)",{exact:true}).click();
  await expect(page.getByRole("heading",{name:"WiFi transfer",exact:true,level:3})).toBeVisible();
  const result=await page.evaluate(()=> (window as unknown as {wikiTest:{configure:unknown[];requests:{action:string}[]}}).wikiTest);
  expect(result.configure).toEqual([]);
  expect(result.requests.filter(request=>request.action==="topic_group")).toHaveLength(1);
  expect(result.requests.filter(request=>request.action==="topic_link")).toHaveLength(1);
});

test("the graph sidebar shows the full grouped timeline and opens issues in place", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  const older = issue("older", "Earlier planning", "meeting-old");
  const recent = issue("recent", "Latest progress", "meeting-recent");
  recent.published!.citations[0]!.kind = "meeting_summary";
  recent.published!.citations.push(older.published!.citations[0]!);
  const unknown = issue("unknown", "Undated discussion", "meeting-unknown");
  const parent: WikiTopic = {
    ...issue("parent", "Product development", "meeting-recent"),
    published: { ...recent.published!, createdAt: "2026-10-31" },
    collection: { hierarchy: true, status: "ready", completed: 3, total: 3, links: [unknown, older, recent].map(member => ({
      targetId: member.id, state: "included", manual: true, reason: "", citations: member.published!.citations, fingerprint: "", error: "",
      events: [{ id: `event-${member.id}`, text: `${member.title} recorded`, date: "", dateBasis: "unknown", citations: [member.published!.citations[0]!] }],
    })) },
  };
  await installAutomaticWiki(page, true, {
    topics: [unknown, older, parent, recent],
    sourceDates: { "meeting-old": "2025-12-31", "meeting-recent": "2026-10-25" },
  });
  await openWiki(page);
  const graph = page.getByRole("group", { name: "Knowledge graph canvas", exact: true });
  await graph.getByRole("button", { name: "Product development", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "Topic overview and updates", exact: true });
  const timeline = sidebar.getByRole("region", { name: "Timeline", exact: true });
  await expect(timeline.locator("time")).toHaveText(["10/25/2026", "12/31/2025"]);
  await expect(timeline.getByRole("heading", { level: 4 })).toHaveText(["10/25/2026Record date", "12/31/2025Record date", "Date to confirm"]);
  await expect(sidebar.getByRole("button", { name: "Edit topic focus", exact: true })).toBeVisible();
  await expect.poll(() => sidebar.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await sidebar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("grouped-topic-sidebar.png"), animations: "disabled" });

  await timeline.getByRole("button", { name: "Evidence 1", exact: true }).first().click();
  const source = page.getByRole("dialog", { name: "Source meetings", exact: true });
  await expect(source).toContainText("Original evidence");
  await page.keyboard.press("Escape");

  await sidebar.getByRole("button", { name: "Latest progress", exact: true }).click();
  const issueReader = sidebar.getByRole("article", { name: "Latest progress", exact: true });
  await expect(issueReader).toContainText("Keep this original page.");
  await expect(issueReader.getByText("Version history", { exact: true })).toBeVisible();
  await expect(graph).toBeVisible();
  await expect(sidebar).toBeFocused();
  await expect.poll(() => sidebar.evaluate(element => element.scrollTop)).toBe(0);
  await issueReader.getByRole("button", { name: "Parent topic: Product development", exact: true }).click();
  await expect(timeline.locator("time")).toHaveCount(2);

  await sidebar.getByRole("button", { name: "Full-page reader", exact: true }).click();
  const reader = page.getByRole("article", { name: "Product development", exact: true });
  await expect(sidebar).toHaveCount(0);
  await expect(reader.getByRole("region", { name: "Timeline", exact: true }).locator("time")).toHaveText(["10/25/2026", "12/31/2025"]);
});
