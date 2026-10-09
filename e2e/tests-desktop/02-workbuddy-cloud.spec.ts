import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

test("WorkBuddy settings can reset a profile-only binding locally", async ({ page, mockServer }) => {
  mockServer.setRoute("GET /api/auth/workbuddy/token", { envelope: true, body: {
    authorized: true, openId: "mock-old-account", scope: "user.profile.readable",
    accessToken: "mock-profile-ticket", expiresAt: "2999-01-01 00:00:00",
  } });
  await openWorkspace(page, mockServer.url);
  await page.evaluate(() => {
    (window as unknown as { __LYNSE_E2E__: { setCommand: (name: string, handler: () => unknown) => void } }).__LYNSE_E2E__
      .setCommand("workbuddy_openapi", () => ({ status: 200, body: '{"nickname":"Mock user"}' }));
  });
  await page.getByRole("button", { name: "E2", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "AI Assistant", exact: true }).click();
  await expect(dialog.getByText("Cloud authorization required", { exact: true })).toBeVisible();
  await expect(dialog.getByText("mock-old-account", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Reset status", exact: true }).click();
  await expect(dialog.getByText("Ready to reconnect", { exact: true })).toBeVisible();
  await expect(dialog.getByText("mock-old-account", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Authorize WorkBuddy", exact: true })).toBeEnabled();
  await page.screenshot({ path: "test-results/workbuddy-reset.png" });
});

test("WorkBuddy cloud streams, reuses tasks, answers approvals and restores history", async ({ page, mockServer }) => {
  mockServer.setRoute("GET /api/auth/workbuddy/token", { envelope: true, body: {
    authorized: true, accessToken: "mock-oauth-ticket", openId: "mock-open-id",
    scope: "user.task.readable user.task.invokable", expiresAt: "2999-01-01 00:00:00",
  } });
  await openWorkspace(page, mockServer.url);
  await page.evaluate(() => {
    const hooks = (window as unknown as { __LYNSE_E2E__: { setCommand: (name: string, handler: (args: Record<string, unknown>) => unknown) => void } }).__LYNSE_E2E__;
    type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown };
    type Channel = { onmessage: (event: unknown) => void };
    const tasks = new Map<string, { role: "user" | "assistant"; text: string }[]>();
    const connections = new Map<string, { taskId: string; channel: Channel }>();
    const waiting = new Map<string, { message: Message; query: string }>();
    const stats = { created: 0, prompts: [] as { taskId: string; query: string }[], answers: [] as Message[] };
    (window as unknown as { __workbuddyTest: typeof stats }).__workbuddyTest = stats;
    function ticket(taskId: string) { return { task_id: taskId, status: "idle", link: `https://acp.workbuddy.cn/sessions/${taskId}`, token: "mock-task-ticket", sandboxDataLink: "https://mock.agentos-run.net" }; }
    function emit(handle: string, message: unknown) {
      const connection = connections.get(handle); if (!connection) return;
      const bytes = [...new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: "2.0", ...message as object })}\n\n`)];
      // Byte-sized packets also split Chinese characters across IPC events.
      for (const byte of bytes) connection.channel.onmessage({ kind: "chunk", bytes: [byte] });
    }
    function update(handle: string, sessionUpdate: string, text: string) {
      emit(handle, { method: "session/update", params: { sessionId: connections.get(handle)!.taskId, update: { sessionUpdate, content: { type: "text", text } } } });
    }
    function finish(handle: string, message: Message, query: string) {
      const connection = connections.get(handle)!;
      const answer = `云端回复 ${query} (${connection.taskId})`;
      setTimeout(() => update(handle, "agent_message_chunk", "云端回复 "), 20);
      setTimeout(() => {
        if (!connections.has(handle)) return;
        update(handle, "agent_message_chunk", `${query} (${connection.taskId})`);
        tasks.get(connection.taskId)!.push({ role: "assistant", text: answer });
        emit(handle, { method: "_codebuddy.ai/artifact", params: { sessionId: connection.taskId, event: "created", artifact: {
          type: "plan", uri: "agent:///artifacts/plan.md", title: "Cloud plan.md", text: "# Cloud plan\n\nReady to continue.",
        } } });
        emit(handle, { id: message.id, result: { stopReason: "end_turn" } });
      }, 80);
    }
    hooks.setCommand("workbuddy_openapi", (args) => {
      const req = args.req as { path: string; method: string; body?: string };
      if (req.path === "/tasks" && req.method === "POST") {
        const id = `task-${++stats.created}`; tasks.set(id, []);
        return { status: 200, body: JSON.stringify(ticket(id)) };
      }
      const id = req.path.split("/").at(-1)!;
      return { status: 200, body: JSON.stringify(ticket(id)) };
    });
    hooks.setCommand("workbuddy_cloud_resource", () => ({ status: 200, body: '{"code":0,"data":{"artifacts":[]}}' }));
    hooks.setCommand("workbuddy_acp_open", (args) => {
      const taskId = String(args.url).split("/").at(-1)!;
      const handle = `${taskId}-${connections.size}-${Date.now()}`;
      connections.set(handle, { taskId, channel: args.onEvent as Channel });
      return { status: 200, handle, connectionId: `connection-${handle}` };
    });
    hooks.setCommand("workbuddy_acp_post", (args) => {
      const handle = String(args.handle); const connection = connections.get(handle)!;
      const message = JSON.parse(String(args.body)) as Message;
      if (message.method === "initialize") emit(handle, { id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/load") {
        for (const entry of tasks.get(connection.taskId) ?? []) update(handle, entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", entry.text);
        emit(handle, { id: message.id, result: {} });
      } else if (message.method === "session/prompt") {
        const query = (message.params!.prompt as { text: string }[])[0]!.text;
        stats.prompts.push({ taskId: connection.taskId, query });
        tasks.get(connection.taskId)!.push({ role: "user", text: query });
        if (query === "approval") {
          waiting.set(handle, { message, query });
          emit(handle, { id: "approve-1", method: "session/request_permission", params: { sessionId: connection.taskId,
            toolCall: { title: "Read cloud file", rawInput: { path: "/workspace/example" } },
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
          } });
        } else finish(handle, message, query);
      } else if (message.id === "approve-1" && message.result) {
        stats.answers.push(message); const turn = waiting.get(handle)!; waiting.delete(handle); finish(handle, turn.message, turn.query);
      }
      return { status: 202, body: "" };
    });
    hooks.setCommand("workbuddy_acp_close", (args) => { connections.delete(String(args.handle)); return null; });
  });
  await page.getByRole("complementary").getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Switch assistant" }).click();
  await page.getByRole("menuitem", { name: "WorkBuddy Cloud" }).click();
  const composer = page.getByRole("textbox").last();
  await expect(composer).toBeEnabled();
  await composer.fill("cloud-one"); await composer.press("Enter");
  await expect(page.getByText("云端回复 cloud-one (task-1)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await composer.fill("cloud-two"); await composer.press("Enter");
  await expect(page.getByText("云端回复 cloud-two (task-2)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat history", exact: true }).click();
  await page.getByRole("button", { name: /^cloud-one\s/ }).click();
  await composer.fill("follow-up"); await composer.press("Enter");
  await expect(page.getByText("云端回复 follow-up (task-1)", { exact: true })).toBeVisible();
  await composer.fill("approval"); await composer.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Read cloud file")).toBeVisible();
  await dialog.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("云端回复 approval (task-1)", { exact: true })).toBeVisible();
  const stats = await page.evaluate(() => (window as unknown as { __workbuddyTest: { created: number; prompts: { taskId: string; query: string }[]; answers: unknown[] } }).__workbuddyTest);
  expect(stats.created).toBe(2);
  expect(stats.prompts.map((entry) => entry.taskId)).toEqual(["task-1", "task-2", "task-1", "task-1"]);
  expect(stats.answers).toEqual([{ jsonrpc: "2.0", id: "approve-1", result: { outcome: { outcome: "selected", optionId: "allow" } } }]);
  await expect(page.getByRole("button", { name: /Cloud plan.md/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /Cloud plan.md/ }).first().click();
  await expect(page.getByRole("heading", { name: "Cloud plan", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "test-results/workbuddy-cloud.png" });
  await expect.poll(async () => page.evaluate(() => Object.values(localStorage).join("\n"))).toContain("task-1");
  const persisted = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(persisted).not.toContain("mock-task-ticket");
  expect(persisted).not.toContain("mock-oauth-ticket");
});
