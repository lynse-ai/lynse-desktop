import { readFileSync } from "node:fs";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import type { KnowledgeGraph, WorkbenchReadResult, WorkbenchStatus, WikiState } from "../../packages/views/workbench/types";

// The opt-in runner produces this from the real local HTTP response and Rust projection.
// Identity/model and native IPC remain synthetic; no user vault or remote provider is used.
test("local Lynclaw HTTP result uses summaries and opens summary evidence without audio", async ({ page, mockServer }) => {
  const resultPath = process.env.LYNSE_GRAPH_LOCAL_RESULT;
  test.skip(!resultPath, "Run pnpm test:graph:local to start the loopback service and Rust smoke");
  const result = JSON.parse(readFileSync(resultPath!, "utf8")) as { graph: KnowledgeGraph; record: WorkbenchReadResult; serviceUrl: string };
  mockServer.setRoute("/api/business/file/presign/download", { envelope: true, body: `${result.serviceUrl}/audio.wav` });
  await page.addInitScript(() => {
    const sample = window as unknown as { graphSeekPositions: number[] };
    sample.graphSeekPositions = [];
    document.addEventListener("seeked", event => {
      if (event.target instanceof HTMLAudioElement) {
        sample.graphSeekPositions.push(event.target.currentTime);
        event.target.pause();
      }
    }, true);
  });
  await openWorkspace(page, mockServer.url);
  await page.evaluate(({ graph, record }) => {
    const runtime = window as unknown as { __LYNSE_E2E__: { setCommand: (name: string, handler: (args: Record<string, unknown>) => unknown) => void; emit: (name: string, value: unknown) => void } };
    const status: WorkbenchStatus = { scope: "local-graph-smoke", userId: "graph-smoke-user", enabled: true, allowAi: true, initialComplete: true, phase: "ready", updatedAt: "local-http-smoke", error: "", discovered: 1, synced: 1, awaitingTranscription: 0, failed: 0, conflicts: 0, memories: [], entries: [{ id: record.document.id, title: record.document.title, kind: "meeting", revision: record.document.revision, status: "synced", excluded: false, error: "" }] };
    const wiki: WikiState = { graph, topics: [], models: { embedding: { baseUrl: "", model: "" } } };
    runtime.__LYNSE_E2E__.setCommand("vault_config_get", () => ({ enabled: true, path: "/tmp/local-graph-smoke" }));
    runtime.__LYNSE_E2E__.setCommand("workbench_bind", () => structuredClone(status));
    runtime.__LYNSE_E2E__.setCommand("workbench_status", () => structuredClone(status));
    runtime.__LYNSE_E2E__.setCommand("workbench_wiki", () => structuredClone(wiki));
    runtime.__LYNSE_E2E__.setCommand("workbench_read", () => structuredClone(record));
    runtime.__LYNSE_E2E__.emit("workbench:updated", status);
  }, result);
  await page.locator(".lyse-sidebar").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: /^(Memory|Wiki)$/ }).click();
  const panel = page.getByRole("tabpanel", { name: "Wiki", exact: true });
  const graph = panel.getByRole("region", { name: "Knowledge graph", exact: true });
  await graph.getByText("Find related information", { exact: true }).click();
  await expect(graph.getByRole("button", { name: "张三 → A项目", exact: true })).toBeVisible();
  await graph.getByRole("button", { name: "Open tasks", exact: true }).click();
  await expect(graph.getByRole("button", { name: "提交预算表", exact: true })).toBeVisible();
  await expect(graph.getByText("Deadline in source: 周五 · exact date not resolved", { exact: true })).toBeVisible();
  await graph.getByRole("button", { name: "Decisions and risks", exact: true }).click();
  await expect(graph.getByRole("button", { name: "采用方案B", exact: true })).toBeVisible();
  await expect(graph.getByRole("button", { name: "预算超支", exact: true })).toBeVisible();
  await graph.getByRole("button", { name: "Open tasks", exact: true }).click();
  await graph.getByRole("button", { name: "提交预算表", exact: true }).click();
  const reader = panel.getByRole("region", { name: "Note content", exact: true });
  await expect(reader.getByRole("heading", { name: "提交预算表", exact: true })).toBeVisible();
  await expect(reader.getByText("AI extraction · needs confirmation", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("local-http-graph.png"), animations: "disabled" });
  await reader.getByRole("button", { name: /本地合成会议 · 图谱联调.*Meeting summary/ }).last().click();
  const source = reader.getByRole("article", { name: "Meeting note", exact: true });
  await expect(source.getByRole("heading", { name: "本地合成会议 · 图谱联调", level: 3, exact: true })).toBeVisible();
  await expect(source).toContainText("zhang@example.com");
  await expect(source).toContainText("Quoted from a meeting summary");
  await expect(source).not.toContainText("TRANSCRIPT_ONLY");
  await expect(source).not.toContainText("cloudFileId");
  await expect(source.locator("audio")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { graphSeekPositions: number[] }).graphSeekPositions)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("local-http-evidence.png"), animations: "disabled" });
});
