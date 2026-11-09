import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { installAutomaticWiki, openWiki } from "../fixtures/wiki-automatic";
import type { WikiTopic } from "../../packages/views/workbench/types";

const citation = { id: "meeting-1", kind: "meeting_summary", revision: "r1", quote: "灵光记项目完成原型，客户反馈仍需整理。" };

/** Same topic shape the wiki-automatic fixture builds, with stale/candidate variants. */
function buildTopics(): WikiTopic[] {
  const titles = ["灵光记项目", "客户反馈", "产品规划", "团队协作", "市场研究", "技术架构"];
  const published = (title: string) => ({
    id: `version-${title}`, markdown: `# ${title}\n\n已完成原型。`, overview: "已完成产品原型。",
    review: "auto_validated", fingerprint: "fixture", reviewedAt: "", createdAt: "2026-10-23T03:00:00Z",
    citations: [citation], changes: [],
  });
  return titles.map((title, index) => ({
    id: `topic-${index + 1}`, title, purpose: "", notes: "", candidate: null, pinned: false,
    excluded: false, stale: index === 5, error: "", inScope: true, topicKind: "topic" as const,
    sourceIds: [citation.id], published: published(title), history: [],
  }));
}

const insights = {
  communities: [
    { id: 0, label: "灵光记项目", size: 3, titles: ["灵光记项目", "客户反馈", "产品规划"], members: ["wiki:topic-1", "wiki:topic-2", "wiki:topic-3"], cohesion: 0.9 },
    { id: 1, label: "团队协作", size: 2, titles: ["团队协作", "市场研究"], members: ["wiki:topic-4", "wiki:topic-5"], cohesion: 0.85 },
  ],
  isolatedTopics: [{ id: "wiki:topic-6", title: "技术架构", degree: 0 }],
  sparseCommunities: [{ id: 2, label: "市场研究", size: 3, titles: ["团队协作", "市场研究", "技术架构"], members: ["wiki:topic-4", "wiki:topic-5", "wiki:topic-6"], cohesion: 0.1 }],
  bridgeTopics: [{ id: "wiki:topic-1", title: "灵光记项目", communities: 3 }],
  crossCommunityLinks: [{ source: "wiki:topic-1", target: "wiki:topic-4", sourceTitle: "灵光记项目", targetTitle: "团队协作", weight: 3 }],
};

const wikiNodes = ["灵光记项目", "客户反馈", "产品规划", "团队协作", "市场研究", "技术架构"].map((title, index) => ({
  id: `wiki:topic-${index + 1}`, wikiId: `topic-${index + 1}`, kind: "wiki" as const, title,
  description: "", status: "published" as const, citations: [], updates: [],
}));

/** Topic graph seed carrying insights; evidence graph gains the wiki nodes so selection works. */
export const graphSeed = {
  topicGraph: {
    automaticTracking: true,
    nodes: wikiNodes,
    edges: [
      { id: "e1", source: "wiki:topic-1", target: "wiki:topic-2", kind: "shared_source", citations: [] },
      { id: "e2", source: "wiki:topic-1", target: "wiki:topic-3", kind: "shared_source", citations: [] },
      { id: "e3", source: "wiki:topic-2", target: "wiki:topic-3", kind: "shared_source", citations: [] },
      { id: "e4", source: "wiki:topic-4", target: "wiki:topic-5", kind: "shared_source", citations: [] },
    ],
    tracking: { processing: false, total: 6, completed: 6, failed: 0, error: "" },
    insights,
  },
  graph: {
    automaticTracking: true,
    nodes: [...wikiNodes, { id: "person-1", kind: "entity", subtype: "person", title: "小林", description: "参与了本周产品讨论。", status: "unknown", citations: [citation], updates: [] }],
    edges: [
      { id: "ge1", source: "wiki:topic-1", target: "wiki:topic-2", kind: "shared_source", citations: [] },
      { id: "ge2", source: "wiki:topic-4", target: "wiki:topic-5", kind: "shared_source", citations: [] },
    ],
    tracking: { processing: false, total: 7, completed: 7, failed: 0, error: "" },
  },
  purpose: "Track the desktop release milestones and customer feedback.",
};

test("graph insights render and bridge cards select topics; community coloring toggles", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page, true, graphSeed);
  await openWiki(page);
  const insightsPanel = page.getByRole("region", { name: "Knowledge insights", exact: true });
  await expect(insightsPanel).toBeVisible();
  await expect(insightsPanel.getByText("Bridge topics")).toBeVisible();
  await expect(insightsPanel.getByText("Isolated topics")).toBeVisible();
  await expect(insightsPanel.getByText("Loose clusters")).toBeVisible();
  await expect(insightsPanel.getByText("Cross-cluster links")).toBeVisible();
  await expect(insightsPanel.getByText("3 clusters")).toBeVisible();
  await expect(insightsPanel.getByText("0 connections")).toBeVisible();
  await expect(insightsPanel.getByText(/cohesion 10%/)).toBeVisible();
  await expect(insightsPanel.getByText("3 shared sources")).toBeVisible();

  // Community coloring swaps wiki-node fills to the community palette.
  const graph = page.getByRole("group", { name: "Knowledge graph canvas", exact: true });
  const particle = graph.locator('[data-graph-node="wiki:topic-1"] [data-graph-particle]');
  const beforeColor = await particle.getAttribute("fill");
  const toggle = page.getByRole("button", { name: "By community", exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(particle).not.toHaveAttribute("fill", beforeColor!);
  await expect(particle).toHaveAttribute("fill", /oklch\(/);

  // Clicking a bridge card selects the topic and opens the reading preview.
  await insightsPanel.getByRole("button", { name: /灵光记项目/ }).first().click();
  await expect(graph.locator('[data-graph-node="wiki:topic-1"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("aside").getByRole("heading", { name: "灵光记项目", exact: true })).toBeVisible();
});

test("clicking an isolated topic card opens it in the reading preview", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page, true, graphSeed);
  await openWiki(page);
  const insightsPanel = page.getByRole("region", { name: "Knowledge insights", exact: true });
  await insightsPanel.getByRole("button", { name: /技术架构/ }).click();
  await expect(page.locator("aside").getByRole("heading", { name: "技术架构", exact: true })).toBeVisible();
});

test("knowledge goal saves through the purpose action without retrying topics", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page, true, graphSeed);
  await openWiki(page);
  await page.getByRole("button", { name: "Knowledge base settings", exact: true }).click();
  const goalBox = page.getByRole("textbox", { name: "Knowledge-base goal", exact: true });
  await expect(goalBox).toHaveValue("Track the desktop release milestones and customer feedback.");
  await goalBox.fill("聚焦桌面端发布节奏与客户反馈。");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Knowledge-base goal saved")).toBeVisible();
  const requests = await page.evaluate(() => (window as unknown as { wikiTest: { requests: { action: string }[] } }).wikiTest.requests);
  expect(requests.filter(request => request.action === "purpose")).toEqual([{ action: "purpose", purpose: "聚焦桌面端发布节奏与客户反馈。" }]);
  // Saving the goal never touches the organization pipeline.
  expect(requests.filter(request => request.action === "retry")).toHaveLength(0);
});

test("health panel reports organization progress and stale topics", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  const topics = buildTopics();
  const seed = {
    ...graphSeed,
    topics,
    graph: { ...graphSeed.graph, tracking: { processing: true, total: 7, completed: 4, failed: 0, error: "" } },
  };
  await installAutomaticWiki(page, true, seed);
  await openWiki(page);
  const health = page.getByRole("region", { name: "Knowledge-base health", exact: true });
  await expect(health).toBeVisible();
  await expect(health.getByText("Organizing: 4 / 7 sources processed")).toBeVisible();
  await expect(health.getByText(/topic(s)? are outdated after source changes/)).toBeVisible();
  await health.getByRole("button", { name: "技术架构" }).click();
  // Navigation is state-based here; assert the reading view opened the topic.
  await expect(page.getByRole("heading", { name: "技术架构", exact: true }).first()).toBeVisible();
});
