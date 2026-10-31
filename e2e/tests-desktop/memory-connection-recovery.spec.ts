import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { installAutomaticWiki, openWiki } from "../fixtures/wiki-automatic";
import type { KnowledgePolicy, MemoryCapabilities } from "../../packages/core/api/memory";
import { resolve } from "node:path";

for (const chinese of [false, true]) {
test(`memory reconnect preserves the draft and never resumes paused organization (${chinese ? "Chinese" : "English"})`, async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page, false);
  await page.evaluate(async () => {
    const runtime = window as unknown as {
      desktopAPI: { workbench: { knowledgePolicy: (request: { action: string }) => Promise<{ capabilities: MemoryCapabilities }> } };
      __LYNSE_E2E__: { setCommand: (name: string, handler: (args: Record<string, unknown>) => unknown) => void };
      memoryRecovery: { fail: boolean; reads: number; writes: number };
    };
    const current = await runtime.desktopAPI.workbench.knowledgePolicy({ action: "read" });
    runtime.memoryRecovery = { fail: true, reads: 0, writes: 0 };
    runtime.__LYNSE_E2E__.setCommand("workbench_knowledge_policy", args => {
      const request = args.request as { action: string; policy?: KnowledgePolicy };
      if (request.action !== "read") {
        runtime.memoryRecovery.writes += 1;
        throw new Error("Reconnect must not write policy");
      }
      runtime.memoryRecovery.reads += 1;
      if (runtime.memoryRecovery.fail) throw new Error("Cloud knowledge request failed (HTTP 503)");
      return current;
    });
  });
  await openWiki(page);
  if (chinese) {
    await page.evaluate(async url => { await (await import(url)).changeLanguage("zh-Hans"); }, `/@fs${resolve(__dirname, "../../packages/core/i18n/react.ts")}`);
  }
  const message = chinese ? "暂时无法连接记忆服务，已保存的知识会保留。请稍后重新连接。" : "Couldn't connect to the memory service. Your saved knowledge is kept. Try reconnecting shortly.";
  const reconnect = chinese ? "重新连接" : "Reconnect";
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByText(/Error:|请更新记忆服务及网关/)).toHaveCount(0);
  const enable = page.getByRole("button", { name: chinese ? "开启自动整理" : "Enable automatic organization", exact: true });
  await expect(enable).toBeDisabled();
  await page.getByRole("checkbox", { name: "Work", exact: true }).check();
  await page.evaluate(() => { (window as unknown as { memoryRecovery: { fail: boolean } }).memoryRecovery.fail = false; });
  await page.screenshot({ path: test.info().outputPath("memory-connection-failure.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: reconnect, exact: true }).click();
  await expect(enable).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: "Work", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: reconnect, exact: true })).toHaveCount(0);
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("memory-connection-recovered.png"), fullPage: true, animations: "disabled" });
  const result = await page.evaluate(() => {
    const runtime = window as unknown as { memoryRecovery: { reads: number; writes: number }; wikiTest: { configure: unknown[] } };
    return { ...runtime.memoryRecovery, configured: runtime.wikiTest.configure };
  });
  expect(result.reads).toBeGreaterThanOrEqual(2);
  expect(result.writes).toBe(0);
  expect(result.configured).toEqual([]);
});
}
