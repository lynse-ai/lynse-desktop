import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

test("memory confirmation and forgetting remain available with Wiki disabled", async ({ page, mockServer }) => {
  let confirmed = false; let forgotten = false;
  const operations: { path: string; id: string; body: Record<string, unknown> }[] = [];
  const row = () => ({ id: "mem-one", revision: 1, content: "Friday is a proposal; approval is still pending.", status: confirmed ? "confirmed" : "candidate", target: "memory", memory_type: "project_fact", scope_type: "global", scope_id: "", eligibility: { usable: confirmed, reasons: confirmed ? [] : ["confirmation_required"] }, provenance: { knowledge: { modality: "planned", scene: "work" } } });
  await page.route(/\/api\/(?:business\/ai\/)?memory\//, async route => {
    const request = route.request(); const path = new URL(request.url()).pathname.split("/memory/")[1]!;
    const body = request.method() === "POST" ? request.postDataJSON() as Record<string, unknown> : {};
    if (request.method() === "POST") operations.push({ path, id: request.headers()["operation-id"] ?? "", body });
    let result: unknown;
    if (path === "capabilities") result = { user_id: "user-e2e", available: true, protocol_version: 4, features: { memory_management: true }, policy: null, projections: false, todo_four_states: false };
    else if (path === "records") result = { records: forgotten || (new URL(request.url()).searchParams.get("status") === "confirmed") !== confirmed ? [] : [row()], total: forgotten ? 0 : 1 };
    else if (path === "confirmation-previews") result = { preview_id: "preview-one", items: [{ id: "mem-one", revision: 1, fingerprint: "frozen" }] };
    else if (path === "confirm-preview") { confirmed = true; result = { status: "ok" }; }
    else if (path === "forget-plans") result = { plan_id: "forget-one", manifest_hash: "frozen-manifest", items: [{ id: "mem-one", revision: 1, fingerprint: "frozen" }], preserves_original_sources: true, preserves_wiki_browsing: true };
    else if (path === "forget-plans/forget-one/execute") { forgotten = true; result = { plan_id: "forget-one", state: "complete", stopped_using: true, cloud_cleanup_complete: true, device_sync: "pending", processed: 1, total: 1 }; }
    else { await route.fulfill({ status: 404, json: { error: { code: "not_found" } } }); return; }
    await route.fulfill({ status: 200, json: result });
  });
  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Memory management", exact: true }).click();
  const main = page.getByRole("main", { name: "Memory management", exact: true });
  await expect(main).toBeVisible();
  await main.getByRole("button", { name: "Pending confirmation", exact: true }).click();
  await expect(main).toContainText("Friday is a proposal");
  await main.getByRole("button", { name: "Confirm", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Confirm selected memories", exact: true });
  await expect(review).toContainText("Friday is a proposal");
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await main.getByRole("button", { name: "Remembered", exact: true }).click();
  await expect(main).toContainText("Friday is a proposal");
  await main.getByRole("button", { name: "Forget", exact: true }).click();
  const forget = page.getByRole("dialog", { name: "Review forgetting", exact: true });
  await expect(forget).toContainText("Original meetings, recordings, chats and browsable Wiki pages are kept");
  await forget.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(main).toContainText("cloud cleanup complete");
  await expect(main).not.toContainText("Friday is a proposal");
  expect(operations.map(operation => operation.path)).toEqual(["confirmation-previews", "confirm-preview", "forget-plans", "forget-plans/forget-one/execute"]);
  expect(operations.every(operation => operation.id.length > 0)).toBe(true);
  expect(operations[1]!.body).toEqual({ preview_id: "preview-one" });
  expect(operations[3]!.body).toEqual({ manifest_hash: "frozen-manifest" });
});
