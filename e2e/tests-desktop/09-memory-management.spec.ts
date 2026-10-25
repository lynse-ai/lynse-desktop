import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

test("memory confirmation and forgetting remain available with Wiki disabled", async ({ page, mockServer }) => {
  let confirmed = false; let forgotten = false;
  const operations: { path: string; id: string; body: Record<string, unknown> }[] = [];
  const member = { id: "mem-one", revision: 1, content: "Friday is a proposal; approval is still pending.", status: "candidate", sources: [] as unknown[], eligibility: { usable: false, reasons: ["confirmation_required"] } };
  const file = { path: "memory/work.md", title: "Work memory", revision: "rev-1", editable: true, recordIds: ["mem-one"], markdown: "# Work memory\n\nConfirmed context stays put.", members: [] as unknown[], pendingUpdates: [member] };
  await page.route(/\/api\/(?:business\/ai\/)?memory\//, async route => {
    const request = route.request(); const path = new URL(request.url()).pathname.split("/memory/")[1]!;
    const body = request.method() === "POST" ? request.postDataJSON() as Record<string, unknown> : {};
    if (request.method() === "POST") operations.push({ path, id: request.headers()["operation-id"] ?? "", body });
    let result: unknown;
    if (path === "capabilities") result = { user_id: "user-e2e", available: true, protocol_version: 4, features: { memory_management: true, topic_files: true }, policy: null, projections: false, todo_four_states: false };
    else if (path === "files") result = { files: [{ path: file.path, title: file.title, revision: file.revision, editable: true, recordIds: file.recordIds, pendingCount: file.pendingUpdates.length }] };
    else if (path === "files/read") result = { path: file.path, title: file.title, revision: file.revision, editable: true, recordIds: file.recordIds, markdown: file.markdown, members: file.members, pendingUpdates: file.pendingUpdates };
    else if (path === "confirmation-previews") result = { preview_id: "preview-one", items: [{ id: "mem-one", revision: 1, fingerprint: "frozen" }] };
    else if (path === "confirm-preview") { confirmed = true; result = { status: "ok" }; }
    else if (path === "forget-plans") result = { plan_id: "forget-one", manifest_hash: "frozen-manifest", items: [{ id: "mem-one", revision: 1, fingerprint: "frozen" }], preserves_original_sources: true, preserves_wiki_browsing: true };
    else if (path === "forget-plans/forget-one/execute") { forgotten = true; result = { plan_id: "forget-one", state: "complete", stopped_using: true, cloud_cleanup_complete: true, device_sync: "pending", processed: 1, total: 1 }; }
    else { await route.fulfill({ status: 404, json: { error: { code: "not_found" } } }); return; }
    await route.fulfill({ status: 200, json: result });
  });
  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const main = page.getByRole("main", { name: "Memory", exact: true });
  await expect(main).toBeVisible();
  const library = main.getByRole("region", { name: "Memory files", exact: true });
  await expect(library).toContainText("Friday is a proposal");
  await library.getByRole("button", { name: "Confirm updates", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Confirm updates", exact: true });
  await expect(review).toContainText("Friday is a proposal");
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await library.locator("summary[aria-label='File actions']").click();
  await library.getByRole("button", { name: "Delete memory", exact: true }).click();
  const forget = page.getByRole("dialog", { name: "Delete this memory?", exact: true });
  await expect(forget).toContainText("Friday is a proposal");
  await forget.getByRole("button", { name: "Delete memory", exact: true }).click();
  await expect(main).toContainText("cloud cleanup complete");
  expect(confirmed).toBe(true);
  expect(forgotten).toBe(true);
  expect(operations.map(operation => operation.path)).toEqual(["confirmation-previews", "confirm-preview", "forget-plans", "forget-plans/forget-one/execute"]);
  expect(operations.every(operation => operation.id.length > 0)).toBe(true);
  expect(operations[1]!.body).toEqual({ preview_id: "preview-one" });
  expect(operations[3]!.body).toEqual({ manifest_hash: "frozen-manifest" });
});
