import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

/** Verify real progress through the desktop renderer with no external requests. */
test("chat shows submission immediately, then live server progress and partial text", async ({ page, mockServer }) => {
  mockServer.setRoute("POST /api/chat/poll", { delayMs: 3500, body: { task_id: "slow-task", status: "pending" } });
  mockServer.setRoute("GET /api/chat/poll/slow-task", { body: {
    status: "pending", progress_events: [{ type: "round_start", seq: 1, content: "Waiting for the model to respond…" }],
  } });
  await page.addInitScript((url: string) => localStorage.setItem("lynse_agent_api_url", url), mockServer.url);
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "AI Chat", exact: true }).click();
  const composer = page.getByPlaceholder("Ask about your recordings, meetings…");
  await composer.fill("Find the meeting decisions");
  await composer.press("Enter");
  await expect(page.getByText("Sending your question…", { exact: true })).toBeVisible({ timeout: 1000 });
  expect(mockServer.requests().some((request) => request.path === "/api/chat/poll/slow-task")).toBe(false);
  await expect(page.getByText("Waiting for the model to respond…", { exact: true })).toBeVisible();
  await expect(page.getByText(/\d+s elapsed/)).toBeVisible();
  const activity = page.locator('[data-slot="activity-indicator"]');
  await expect(activity).toBeVisible();
  await expect(activity.locator(".activity-pixel").first()).toHaveCSS("animation-name", "activity-pixel");
  const label = page.locator(".activity-label-highlight");
  await expect(label).toHaveCSS("animation-name", "activity-label-sweep");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(activity.locator(".activity-pixel").first()).toHaveCSS("animation-name", "none");
  await expect(label).toHaveCSS("display", "none");
  await expect(page.getByText("Waiting for the model to respond…", { exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.screenshot({ path: test.info().outputPath("chat-waiting.png"), animations: "disabled" });

  mockServer.setRoute("GET /api/chat/poll/slow-task", { body: {
    status: "pending", text: "The first decision is ready.",
    progress_events: [{ type: "round_start", seq: 1, content: "Waiting for the model to respond…" }],
  } });
  await expect(page.getByText("The first decision is ready.", { exact: true })).toBeVisible();
  // The partial answer is visible while the server is still working.
  await expect(page.getByText("Waiting for the model to respond…", { exact: true })).toBeVisible();
  mockServer.setRoute("GET /api/chat/poll/slow-task", { body: {
    status: "done", text: "The first decision is ready. The second decision is confirmed.", sources: [],
  } });
  await expect(page.getByText("The first decision is ready. The second decision is confirmed.", { exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for the model to respond…", { exact: true })).toHaveCount(0);
  await expect(activity).toHaveCount(0);
});

test("interrupted streamed Markdown keeps normal formatting and shows the failure separately", async ({ page, mockServer }) => {
  mockServer.setRoute("POST /api/chat/poll", { body: { task_id: "interrupted-task", status: "pending" } });
  mockServer.setRoute("GET /api/chat/poll/interrupted-task", { body: { status: "pending", text: "**会议纪要**\n\n已收到的内容。" } });
  await page.addInitScript((url: string) => localStorage.setItem("lynse_agent_api_url", url), mockServer.url);
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "AI Chat", exact: true }).click();
  const composer = page.getByPlaceholder("Ask about your recordings, meetings…");
  await composer.fill("Make a visual summary");
  await composer.press("Enter");
  await expect(page.locator("strong").filter({ hasText: "会议纪要" })).toBeVisible();
  mockServer.setRoute("GET /api/chat/poll/interrupted-task", { body: { status: "error", error: "图文生成超时" } });
  const alert = page.getByRole("alert").filter({ hasText: "图文生成超时" });
  await expect(alert).toBeVisible();
  await expect(page.locator("strong").filter({ hasText: "会议纪要" })).toBeVisible();
  await expect(alert).not.toContainText("会议纪要");
  await page.screenshot({ path: test.info().outputPath("chat-interrupted.png"), animations: "disabled" });
});
