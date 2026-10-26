import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

test("desktop MCP settings copy configuration and serve local and signed-in cloud data", async ({page, mockServer}) => {
  mockServer.setRoute("GET /api/business/file/page", {envelope:true, body:{items:[{id:"cloud-1", originalFilename:"Cloud meeting"}]}});
  // The eligibility gate sends every meeting id (local ones included) to the
  // memory service before any row is returned.
  await page.route(/\/memory\/source-eligibility$/, route => route.fulfill({ status: 200, json: { allowed_source_ids: ["local-1", "cloud-1"] } }));
  await openWorkspace(page, mockServer.url);
  await page.evaluate(() => {
    type Result = {requestId:string; result:{structuredContent?:{data:unknown}; isError:boolean}};
    const hooks = (window as unknown as {__LYNSE_E2E__:{setCommand:(name:string, handler:(args:Record<string, unknown>) => unknown) => void}}).__LYNSE_E2E__;
    let config = {enabled:false, port:27125, token:"e2e-local-credential"};
    const results: Result[] = [];
    (window as unknown as {__mcpResults:Result[]}).__mcpResults = results;
    hooks.setCommand("desktop_mcp_get", () => config);
    hooks.setCommand("desktop_mcp_configure", (args) => {
      config = {...config, enabled:args.enabled === true, port:Number(args.port), token:args.rotate ? "e2e-rotated-credential" : config.token};
      return config;
    });
    hooks.setCommand("desktop_mcp_complete", (args) => { results.push(args as Result); return null; });
    hooks.setCommand("local_transcription_list", () => [{id:"local-1", title:"Local meeting", transcriptText:"Local transcript", providerConfig:{apiKey:"do-not-share"}}]);
  });
  await page.getByRole("button", {name:"E2", exact:true}).click();
  await page.getByRole("menuitem", {name:"Settings", exact:true}).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", {name:"AI Assistant", exact:true}).click();
  const toggle = dialog.getByRole("switch", {name:"Allow local AI clients to access Lynse"});
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(dialog.getByText("http://127.0.0.1:27125/mcp", {exact:true})).toBeVisible();
  await dialog.getByRole("button", {name:"Copy Codex config", exact:true}).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('http_headers = { Authorization = "Bearer e2e-local-credential" }');
  expect(copied.split("\n")).toHaveLength(4);
  await expect(dialog.getByText("e2e-local-credential", {exact:true})).toHaveCount(0);
  await page.evaluate(() => {
    const hooks = (window as unknown as {__LYNSE_E2E__:{emit:(event:string, payload:unknown) => void}}).__LYNSE_E2E__;
    hooks.emit("lynse-mcp-request", {requestId:"local", name:"get_local_meeting", arguments:{id:"local-1", content:"transcript"}});
    hooks.emit("lynse-mcp-request", {requestId:"cloud", name:"list_cloud_meetings", arguments:{page_size:7}});
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as {__mcpResults:unknown[]}).__mcpResults.length)).toBe(2);
  const results = await page.evaluate(() => (window as unknown as {__mcpResults:{requestId:string; result:{isError:boolean; structuredContent:{data:unknown}}}[]}).__mcpResults);
  expect(results.every((row) => !row.result.isError)).toBe(true);
  expect(results.find((row) => row.requestId === "local")!.result.structuredContent.data).toEqual({id:"local-1", title:"Local meeting", transcriptText:"Local transcript"});
  expect(results.find((row) => row.requestId === "cloud")!.result.structuredContent.data).toEqual({items:[{id:"cloud-1", originalFilename:"Cloud meeting"}]});
  const request = mockServer.requests().find((row) => row.path === "/api/business/file/page" && row.query.pageSize === "7");
  expect(request).toBeTruthy();
  expect(request!.headers.authorization).toBeTruthy();
  expect(request!.headers["x-api-key"]).toBeUndefined();
  await page.screenshot({path:"test-results/desktop-mcp.png"});
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(dialog.getByRole("button", {name:"Copy Codex config"})).toHaveCount(0);
});
