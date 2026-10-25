import { resolve } from "node:path";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { installAutomaticWiki, openWiki } from "../fixtures/wiki-automatic";

test("knowledge graph opens with 3D particles and retains rotation and mode through settings", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installAutomaticWiki(page);
  await openWiki(page);
  const graph = page.getByRole("group", { name: "Knowledge graph canvas", exact: true });
  const threeD = page.getByRole("button", { name: "3D", exact: true });
  await expect(threeD).toHaveAttribute("aria-pressed", "true");
  await expect(graph.locator("[data-graph-particle]")).toHaveCount(6);
  expect(await graph.locator("[data-graph-particle]").evaluateAll(particles => particles.every(particle => Number(particle.getAttribute("r")) < 10))).toBe(true);
  await expect(graph.locator("[data-graph-node] .lucide")).toHaveCount(0);
  await expect(graph.locator("[data-graph-contour]")).toHaveCount(0);
  const node = graph.locator("[data-graph-node]").first();
  const before = await node.getAttribute("transform");
  const box = (await graph.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await expect(node).not.toHaveAttribute("transform", before!);
  const rotated = await node.getAttribute("transform");
  await page.getByRole("button", { name: "Knowledge base settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to knowledge base", exact: true }).click();
  await expect(threeD).toHaveAttribute("aria-pressed", "true");
  await expect(node).toHaveAttribute("transform", rotated!);
  await page.screenshot({ path: test.info().outputPath("wiki-3d-particles.png"), animations: "disabled" });
  const twoD = page.getByRole("button", { name: "2D", exact: true });
  await twoD.click();
  await expect(twoD).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Knowledge base settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to knowledge base", exact: true }).click();
  await expect(twoD).toHaveAttribute("aria-pressed", "true");
  await threeD.click();
  await expect(threeD).toHaveAttribute("aria-pressed", "true");
});

test("first setup requires an explicit folder selection and starts automatic organization",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page,false);await openWiki(page);
  for(const name of ["Work","Team","Unfiled meetings"])await expect(page.getByRole("checkbox",{name,exact:true})).not.toBeChecked();
  await page.getByRole("button",{name:"Enable automatic organization",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Choose at least one");
  await page.getByRole("checkbox",{name:"Work",exact:true}).check();
  await expect(page.getByText(/configured AI service uses summaries/)).toBeVisible();
  await page.getByRole("button",{name:"Enable automatic organization",exact:true}).click();
  await expect(page.getByRole("group").getByRole("button",{name:"灵光记项目",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {wikiTest:{configure:unknown[]}}).wikiTest.configure)).toEqual([{enabled:false,allowAi:false,automation:{folderIds:["folder-work"],includeUnfiled:false}},{enabled:true,allowAi:true,automation:{folderIds:["folder-work"],includeUnfiled:false}}]);
  await expect(page.getByRole("button",{name:/Create topic|Approve and publish|Show connections/})).toHaveCount(0);
});

test("graph selection previews knowledge and full reading restores its view",async({page,mockServer})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  const graph=page.getByRole("group",{name:"Knowledge graph canvas",exact:true});
  const sidebar=page.getByRole("button",{name:"Toggle topic sidebar",exact:true});
  await expect(sidebar).toHaveAttribute("aria-pressed","false");
  await expect(page.getByRole("complementary",{name:"Topic overview and updates",exact:true})).toHaveCount(0);
  const fullWidth=(await graph.boundingBox())!.width;
  const next=page.getByRole("button",{name:"Forward",exact:true});
  await expect(next.locator("..").getByRole("button")).toHaveCount(2);
  expect((await sidebar.boundingBox())!.x).toBeGreaterThan(page.viewportSize()!.width*0.8);
  const toolbar=page.getByRole("main",{name:"Knowledge base",exact:true}).locator(":scope > header");
  expect(Math.round((await toolbar.boundingBox())!.height)).toBeLessThanOrEqual(48);
  await expect(toolbar.getByRole("button",{name:"Topic directory",exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("wiki-compact-wide.png"),animations:"disabled"});
  await sidebar.click();
  await expect(page.getByRole("complementary",{name:"Topic overview and updates",exact:true})).toContainText("Recent changes");
  expect((await graph.boundingBox())!.width).toBeLessThan(fullWidth-300);
  await sidebar.click();
  await expect(sidebar).toHaveAttribute("aria-pressed","false");
  await graph.getByRole("button",{name:"灵光记项目",exact:true}).click();
  await expect(sidebar).toHaveAttribute("aria-pressed","true");
  const preview=page.getByRole("complementary",{name:"Topic overview and updates",exact:true});
  await expect(preview.getByRole("heading",{name:"灵光记项目",exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("wiki-compact-preview.png"),animations:"disabled"});
  await expect(page.getByRole("heading",{name:"当前情况",exact:true})).toHaveCount(0);
  const beforeZoom=await graph.locator("[data-graph-node]").first().getAttribute("transform");
  await page.getByRole("button",{name:"Zoom in",exact:true}).click();
  await expect(graph.locator("[data-graph-node]").first()).not.toHaveAttribute("transform",beforeZoom!);
  const camera=await graph.locator("[data-graph-node]").first().getAttribute("transform");
  await preview.getByRole("button",{name:"Read full topic",exact:true}).click();
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByRole("heading",{name:"当前情况",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Back to knowledge base",exact:true}).click();
  expect(await graph.locator("[data-graph-node]").first().getAttribute("transform")).toBe(camera);
  await expect(preview.getByRole("heading",{name:"灵光记项目",exact:true})).toBeVisible();
  await preview.getByRole("button",{name:"产品周会 · 10月23日",exact:true}).click();
  const source=page.getByRole("dialog",{name:"Source meetings",exact:true});
  await expect(source).toContainText("Quoted from a meeting summary");await expect(source).not.toContainText("TRANSCRIPT_ONLY");await expect(source.locator("audio")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await preview.getByRole("button",{name:"Add context or a correction",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Add context or a correction",exact:true});await dialog.getByRole("textbox").fill("人工补充：原型还需要做无障碍检查。");await dialog.getByRole("button",{name:"Save",exact:true}).click();
  await preview.getByRole("button",{name:"Read full topic",exact:true}).click();await expect(page.getByText("人工补充：原型还需要做无障碍检查。",{exact:true})).toBeVisible();
  await page.getByText("People and details",{exact:true}).click();await expect(page.getByRole("heading",{name:"小林",exact:true})).toBeVisible();
  await page.getByText("Version history",{exact:true}).click();await page.getByText(/Oct 20.*Published/).click();await expect(page.getByRole("heading",{name:"历史情况",exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test("directory and graph share the same topic and retain name search",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  await page.getByRole("button",{name:"Topic directory",exact:true}).click();
  const search=page.getByRole("textbox",{name:"Find a topic",exact:true});await search.fill("不存在");
  await expect(page.getByRole("status").filter({hasText:"不存在"})).toBeVisible();
  await page.getByRole("button",{name:"Clear search",exact:true}).click();await search.fill("客户");
  await page.getByRole("region",{name:"Topic directory",exact:true}).getByRole("button",{name:/^客户反馈/}).click();await expect(page.getByRole("article",{name:"客户反馈",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Back to knowledge base",exact:true}).click();await expect(search).toHaveValue("客户");
});

test("range updates, pause and resume preserve the saved folder choices",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  await page.getByRole("button",{name:"Knowledge base settings",exact:true}).click();
  const settings=page.getByRole("region",{name:"Scope and automatic organization",exact:true});
  await expect(settings.getByRole("checkbox",{name:"Work",exact:true})).toBeChecked();
  await settings.getByRole("checkbox",{name:"Team",exact:true}).check();await settings.getByRole("checkbox",{name:"Unfiled meetings",exact:true}).check();
  await settings.getByRole("button",{name:"Save scope",exact:true}).click();
  await settings.getByRole("button",{name:"Pause organization",exact:true}).click();
  await expect(settings.getByRole("button",{name:"Enable automatic organization",exact:true})).toBeVisible();
  await expect(settings.getByRole("checkbox",{name:"Team",exact:true})).toBeChecked();
  await settings.getByRole("button",{name:"Enable automatic organization",exact:true}).click();
  await settings.getByRole("checkbox",{name:"Work",exact:true}).uncheck();await settings.getByRole("button",{name:"Save scope",exact:true}).click();
  await page.getByRole("button",{name:"Back to knowledge base",exact:true}).click();await expect(page.getByRole("group").getByRole("button",{name:"灵光记项目",exact:true})).toHaveCount(0);
});

test("service failure keeps the last reading version and exposes a retry",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  await page.evaluate(async()=>{const runtime=window as unknown as {desktopAPI:{workbench:{wiki:(request:{action:"state"})=>Promise<{topics:Record<string,unknown>[]}>}};wikiTest:{patch:(status:Record<string,unknown>,wiki:Record<string,unknown>)=>void}};const wiki=await runtime.desktopAPI.workbench.wiki({action:"state"});wiki.topics[0]!.error="Unavailable";wiki.topics[0]!.stale=true;runtime.wikiTest.patch({error:"Update failed"},wiki);});
  await page.getByRole("group").getByRole("button",{name:"灵光记项目",exact:true}).click();await page.getByRole("button",{name:"Read full topic",exact:true}).click();
  const reader=page.getByRole("article",{name:"灵光记项目",exact:true}).filter({has:page.getByRole("heading",{name:"当前情况",exact:true})});
  await expect(reader.getByRole("heading",{name:"当前情况",exact:true})).toBeVisible();await expect(reader.getByRole("alert")).toBeVisible();
  await reader.getByRole("button",{name:"Retry",exact:true}).click();await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Chinese graph is usable with keyboard, narrow windows and enlarged text",async({page,mockServer})=>{
  await page.setViewportSize({width:1440,height:960});await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  await page.evaluate(async url=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await page.screenshot({path:test.info().outputPath("wiki-home-wide-zh.png"),animations:"disabled"});
  const node=page.getByRole("group").getByRole("button",{name:"灵光记项目",exact:true});await node.focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary",{name:"专题概览与更新",exact:true}).getByRole("heading",{name:"灵光记项目",exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("wiki-graph-zh.png"),animations:"disabled"});
  await page.setViewportSize({width:680,height:800});await page.evaluate(()=>{document.documentElement.style.fontSize="24px";});
  await expect(page.getByRole("button",{name:"阅读完整专题",exact:true})).toBeVisible();
  const graph=page.getByRole("group",{name:"知识图谱画布",exact:true});
  const heading=page.getByRole("complementary",{name:"专题概览与更新",exact:true}).getByRole("heading",{name:"灵光记项目",exact:true});
  expect((await heading.boundingBox())!.y).toBeGreaterThan((await graph.boundingBox())!.y+(await graph.boundingBox())!.height);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("wiki-narrow-zoom-zh.png"),animations:"disabled"});
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(()=>{document.documentElement.style.fontSize="";document.documentElement.style.zoom="2";});
  const main=page.getByRole("main",{name:"知识库",exact:true});
  expect(await main.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await expect(main.locator(":scope > header").getByRole("button",{name:"知识库设置",exact:true})).toBeInViewport();
  await page.screenshot({path:test.info().outputPath("wiki-home-200-zh.png"),animations:"disabled"});
  await page.evaluate(()=>{document.documentElement.dir="rtl";});
  expect(await main.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("wiki-home-rtl.png"),animations:"disabled"});
});


test("failed setup preserves the user's folder choices and stays disabled",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page,false);await openWiki(page);
  await page.evaluate(()=>{(window as unknown as {__LYNSE_E2E__:{setCommand:(name:string,handler:()=>unknown)=>void}}).__LYNSE_E2E__.setCommand("workbench_configure",()=>{throw new Error("Native setup failed");});});
  await page.getByRole("checkbox",{name:"Work",exact:true}).check();await page.getByRole("button",{name:"Enable automatic organization",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Native setup failed");await expect(page.getByRole("checkbox",{name:"Work",exact:true})).toBeChecked();
  await expect(page.getByRole("button",{name:"Enable automatic organization",exact:true})).toBeEnabled();await expect(page.getByText("Automatic organization enabled",{exact:true})).toHaveCount(0);
});

test("organization progress stays on the knowledge homepage and leaves settings for configuration",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  const patch=async(phase:string,stage:string,completed:number,total:number)=>page.evaluate(({phase,stage,completed,total})=>{
    (window as unknown as {wikiTest:{patch:(status:Record<string,unknown>)=>void}}).wikiTest.patch({phase,wikiProgress:{stage,completed,total,failed:0,currentTitle:stage==="analyzing"?"产品周会 · 10月23日":"",topicTitle:stage==="compiling"?"灵光记项目":""}});
  },{phase,stage,completed,total});
  await patch("processing","analyzing",2,8);
  const progress=page.getByRole("region",{name:"Organization progress",exact:true});
  await expect(page.getByRole("main",{name:"Knowledge base",exact:true}).locator(":scope > header").getByRole("progressbar")).toHaveCount(0);
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow","25");
  await expect(progress).toContainText("2 / 8 text sections analyzed");await expect(progress).toContainText("产品周会 · 10月23日");
  await expect(page.getByRole("group",{name:"Knowledge graph canvas",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Knowledge base settings",exact:true}).click();
  await expect(page.getByRole("main",{name:"Knowledge base settings",exact:true}).getByRole("progressbar")).toHaveCount(0);
  await page.getByRole("button",{name:"Back to knowledge base",exact:true}).click();
  await patch("processing","compiling",1,3);await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow","33");await expect(progress).toContainText("灵光记项目");await expect(progress).toContainText("1 / 3 topics processed");
  await patch("processing","analyzing",0,0);await expect(progress.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");await expect(progress).not.toContainText("0%");
  await patch("processing","analyzing",2,8);
  await page.evaluate(async url=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await expect(page.getByRole("region",{name:"整理进度",exact:true})).toContainText("已分析 2 / 8 段资料");
  await page.setViewportSize({width:680,height:800});await page.evaluate(()=>{document.documentElement.style.fontSize="24px";});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("wiki-home-progress.png"),animations:"disabled"});
  await patch("ready","complete",3,3);await expect(page.getByRole("region",{name:"整理进度",exact:true})).toHaveCount(0);
});

test("knowledge settings preserve graph, directory and topic reading state",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  const graph=page.getByRole("group",{name:"Knowledge graph canvas",exact:true});
  await graph.getByRole("button",{name:"灵光记项目",exact:true}).click();
  const beforeZoom=await graph.locator("[data-graph-node]").first().getAttribute("transform");
  await page.getByRole("button",{name:"Zoom in",exact:true}).click();
  await expect(graph.locator("[data-graph-node]").first()).not.toHaveAttribute("transform",beforeZoom!);
  const camera=await graph.locator("[data-graph-node]").first().getAttribute("transform");
  const gear=page.getByRole("button",{name:"Knowledge base settings",exact:true});
  await gear.focus();await page.keyboard.press("Enter");
  const settings=page.getByRole("main",{name:"Knowledge base settings",exact:true});
  await expect(settings.getByRole("heading",{name:"Knowledge base settings",exact:true})).toHaveCount(1);
  await expect(settings.getByRole("tab")).toHaveCount(0);
  await expect(settings.getByRole("button",{name:"Back to knowledge base",exact:true})).toHaveCount(1);
  await expect(settings.getByRole("checkbox",{name:"Work",exact:true})).toBeChecked();
  await expect(settings.locator("details")).toHaveCount(1);
  const advanced=settings.locator("summary");
  await expect(settings.locator("details")).not.toHaveAttribute("open","");
  await expect(settings.getByRole("switch",{name:"Enable local sync",exact:true})).toHaveCount(0);
  await advanced.focus();await page.keyboard.press("Enter");
  for(const name of ["Email sources (enabled separately)","Vector search (optional)","Local files and sync","Maintenance"])await expect(settings.getByRole("heading",{name,exact:true})).toBeVisible();
  await expect(settings.getByRole("button",{name:/Open knowledge base & Wiki|Open meeting workbench/})).toHaveCount(0);
  await settings.getByRole("button",{name:"Back to knowledge base",exact:true}).click();
  await expect(graph.locator("[data-graph-node]").first()).toHaveAttribute("transform",camera!);
  await expect(page.getByRole("complementary").getByRole("heading",{name:"灵光记项目",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Topic directory",exact:true}).click();
  const search=page.getByRole("textbox",{name:"Find a topic",exact:true});await search.fill("客户");
  await gear.click();await settings.getByRole("button",{name:"Back to knowledge base",exact:true}).click();
  await expect(search).toHaveValue("客户");
  await page.getByRole("region",{name:"Topic directory",exact:true}).getByRole("button",{name:/^客户反馈/}).click();
  await gear.click();await settings.getByRole("button",{name:"Back to knowledge base",exact:true}).click();
  await expect(page.getByRole("article",{name:"客户反馈",exact:true})).toBeVisible();
});

test("Chinese knowledge settings reflow at narrow widths, 200 percent zoom and RTL",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  await page.evaluate(async url=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await page.getByRole("button",{name:"知识库设置",exact:true}).click();
  const settings=page.getByRole("main",{name:"知识库设置",exact:true});
  await expect(settings.getByRole("heading",{name:"整理范围与自动整理",exact:true})).toBeVisible();
  await settings.getByText("高级设置",{exact:true}).click();
  for(const zoom of ["1","2"]){
    await page.setViewportSize({width:zoom==="1"?680:1280,height:900});
    await page.evaluate(zoom=>{document.documentElement.style.zoom=zoom;},zoom);
    expect(await settings.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await expect(settings.getByRole("button",{name:"返回知识库",exact:true})).toBeInViewport();
    await settings.getByRole("button",{name:"保存范围",exact:true}).scrollIntoViewIfNeeded();
    await expect(settings.getByRole("button",{name:"保存范围",exact:true})).toBeInViewport();
    await page.screenshot({path:test.info().outputPath(`knowledge-settings-zh-zoom-${zoom}.png`),animations:"disabled"});
  }
  await page.evaluate(()=>{document.documentElement.dir="rtl";});
  expect(await settings.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("knowledge-settings-rtl.png"),animations:"disabled"});
});

test("untranscribed files stay outside organization progress and do not leave a waiting notice",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  await page.evaluate(()=>{
    (window as unknown as {wikiTest:{patch:(status:Record<string,unknown>)=>void}}).wikiTest.patch({phase:"syncing",initialComplete:false,discovered:12,synced:2,awaitingTranscription:9,failed:1,wikiProgress:null});
  });
  const progress=page.getByRole("region",{name:"Organization progress",exact:true});
  await expect(progress).toContainText("2 / 2 available meetings synced");
  await expect(progress).toContainText("1 sync issues");
  await expect(progress).not.toContainText("awaiting transcription");
  const home=page.locator(".lyse-sidebar").getByRole("button",{name:"Home",exact:true});
  await home.click();
  const homeProgress=page.getByRole("region",{name:"Organization progress",exact:true});
  await expect(homeProgress).toContainText("2 / 2 available meetings synced");
  await expect(homeProgress).toContainText("1 failed to sync");
  await expect(homeProgress).not.toContainText("awaiting transcription");
  await openWiki(page);
  await page.evaluate(()=>{
    (window as unknown as {wikiTest:{patch:(status:Record<string,unknown>)=>void}}).wikiTest.patch({discovered:11,failed:0});
  });
  await expect(progress).not.toContainText("sync issues");
  await expect(progress).not.toContainText("awaiting transcription");
  await page.evaluate(async url=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  const chineseProgress=page.getByRole("region",{name:"整理进度",exact:true});
  await expect(chineseProgress).toContainText("已同步 2 / 2 条可用会议");
  await expect(chineseProgress).not.toContainText("待转写");
  await page.evaluate(()=>{
    (window as unknown as {wikiTest:{patch:(status:Record<string,unknown>)=>void}}).wikiTest.patch({phase:"ready",initialComplete:true,wikiProgress:{stage:"complete",completed:2,total:2,failed:0,currentTitle:"",topicTitle:""}});
  });
  await expect(chineseProgress).toHaveCount(0);
});

test("AI service errors show actionable authentication and update messages on the knowledge homepage",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page);await openWiki(page);
  await page.evaluate(()=>{
    (window as unknown as {wikiTest:{patch:(status:Record<string,unknown>)=>void}}).wikiTest.patch({phase:"failed",error:"Lynclaw synthesis failed (HTTP 422): Unknown synthesis task"});
  });
  await expect(page.getByRole("alert")).toContainText("Update the Lynclaw service to continue");
  await page.evaluate(async url=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await expect(page.getByRole("alert")).toContainText("请更新 Lynclaw 服务后继续");
  await page.evaluate(()=>{
    (window as unknown as {wikiTest:{patch:(status:Record<string,unknown>)=>void}}).wikiTest.patch({error:"Lynclaw authentication failed; sign in again"});
  });
  await expect(page.getByRole("alert")).toContainText("请重新登录后重试整理");
  await page.evaluate(async url=>{await (await import(url)).changeLanguage("en");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await expect(page.getByRole("alert")).toContainText("Sign in again, then retry organization");
});
