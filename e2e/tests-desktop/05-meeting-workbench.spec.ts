import { resolve } from "node:path";
import { completeOAuth } from "../fixtures/integrations-mock";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { DEFAULT_EMBEDDING_MODEL } from "../../packages/views/workbench/embedding-model";
import type { KnowledgeGraph, WorkbenchStatus, MemoryDocument } from "../../packages/views/workbench/types";

// Native durability and pagination are exercised by Rust tests. This fixture
// checks the real renderer's consent, incomplete-sync and review interactions.
async function installWorkbench(page: import("@playwright/test").Page) {
  await page.route(/\/api\/(?:business\/ai\/)?memory\/(capabilities|records)(?:\?|$)/,async route=>{
    const status=await page.evaluate(async()=>await (window as unknown as {desktopAPI:{workbench:{status:()=>Promise<WorkbenchStatus>}}}).desktopAPI.workbench.status());
    const capability={protocol_version:4,user_id:status.userId,available:true,features:{memory_management:true},projections:false,todo_four_states:false,policy:null};
    await route.fulfill({status:200,json:route.request().url().includes("/capabilities")?capability:{status:"ok",records:[],total:0}});
  });
  await page.evaluate(async (defaultEmbedding) => {
    const hook = (window as unknown as { __LYNSE_E2E__: {setCommand: (name: string, handler: (args: Record<string, unknown>) => unknown) => void; emit: (name: string, payload: unknown) => void} }).__LYNSE_E2E__;
    const previous=await (window as unknown as {desktopAPI:{workbench:{status:()=>Promise<WorkbenchStatus>}}}).desktopAPI.workbench.status();
    const reference = {id:"meeting-1995",kind:"meeting",revision:"r1",quote:"Friday is only a proposal.",startMs:12000};
    const status = {scope:previous.scope,userId:"user-e2e",enabled:false,allowAi:false,initialComplete:false,phase:"disabled",updatedAt:"1",error:"",discovered:2,synced:1,awaitingTranscription:0,failed:1,conflicts:0,
      entries:[{id:"meeting-1995",kind:"meeting",title:"Project Alpha · 1995",revision:"r1",status:"synced",excluded:false,error:""},{id:"meeting-2026",kind:"meeting",title:"Project Alpha · 2026",revision:"r2",status:"failed",excluded:false,error:"Network unavailable"}],
      memories:[{id:"memory-1",sourceId:"meeting-1995",sourceTitle:"Project Alpha",kind:"proposal",text:"Friday remains a proposal",citations:[reference]}]};
    const record = {document:{id:"meeting-1995",kind:"meeting",title:"Project Alpha · 1995",revision:"r1",transcript:reference.quote,outline:"Review the deadline",segments:[{id:"s1",text:reference.quote,startMs:12000,speakerName:"Sam"}],conclusions:[{id:"v1",templateName:"Original summary",conclusionText:"No final date was agreed."},{id:"v2",templateName:"Updated summary",conclusionText:"The team still needs to confirm."}],todos:[],aiContextEnabled:true},markdown:"# Project Alpha",artifacts:{summaries:[],todoSuggestions:[{id:"suggestion-1",title:"Confirm the launch date",citations:[reference],accepted:false}]}};
    const vault={enabled:false,path:"/tmp/lynse-e2e-vault"};
    const graph: KnowledgeGraph = { schemaVersion:1,availableSources:[{id:"meeting-1995",title:"Project Alpha · 1995",selected:true}],automaticTracking:true,tracking:{processing:false,completed:2,total:2,failed:0,error:""},nodes:[
      {id:"entity:alpha",kind:"entity",subtype:"project",title:"Project Alpha",description:"Launch date needs confirmation.",status:"blocked",citations:[reference],updates:[{description:"Launch date needs confirmation.",status:"blocked",observedAt:"2026-10-20",citations:[reference]},{description:"Initial development started.",status:"active",observedAt:"2026-10-01",citations:[reference]}]},
      {id:"entity:goal",kind:"event",subtype:"milestone",title:"Friday launch",description:"Friday remains a proposal.",status:"proposed",citations:[reference],updates:[{description:"Friday remains a proposal.",status:"proposed",observedAt:"2026-10-20",citations:[reference]}]},
      {id:"wiki:topic-1",kind:"wiki",title:"Launch plan",description:"Review the launch plan",status:"published",wikiId:"topic-1",citations:[reference],updates:[]},
      {id:"source:meeting-1995",kind:"source",title:"Project Alpha · 1995",description:reference.quote,status:"source",source:reference,citations:[reference],updates:[]}
    ],edges:[{id:"g1",source:"entity:alpha",target:"entity:goal",kind:"related"},{id:"g2",source:"entity:alpha",target:"source:meeting-1995",kind:"evidence"},{id:"g3",source:"wiki:topic-1",target:"source:meeting-1995",kind:"evidence"}]};
    const hidden = new Map<string,{node:KnowledgeGraph["nodes"][number];edges:KnowledgeGraph["edges"]}>();
    const wiki={graph,topics:[] as {id:string;title:string;purpose:string;notes:string;pinned:boolean;excluded:boolean;stale:boolean;error:string;candidate:{id:string;markdown:string;citations:typeof reference[]}|null;published:{id:string;markdown:string;citations:typeof reference[]}|null}[],models:{embedding:defaultEmbedding,revision:""},sources:{gmailEnabled:false,gmailAccountId:"",integrationsUrl:""}};
    let policy={enrolled:false,range_version:0,grant_version:0,processing_version:0,folder_ids:[] as string[],include_unfiled:false,excluded_source_ids:[],memory_consent:false,local_text_consent:false,chat_consent:false,email_consent:false,notifications_consent:false,extraction_paused:true,projections_enabled:false,timezone:"Asia/Shanghai"};
    hook.setCommand("workbench_knowledge_policy",args=>{
      const request=args.request as {action:string;policy?:Partial<typeof policy>};
      if(request.action==="read")return {capabilities:{available:true,user_id:status.userId,policy:structuredClone(policy)},pending:false};
      policy={...policy,...request.policy,range_version:policy.range_version+1,grant_version:policy.grant_version+1,processing_version:policy.processing_version+1};return {policy:structuredClone(policy),pending:false};
    });
    hook.setCommand("vault_config_get",()=>structuredClone(vault));
    hook.setCommand("vault_default_path",()=>"/tmp/lynse-e2e-vault");
    hook.setCommand("vault_config_save",(args)=>{Object.assign(vault,args.config);if(!vault.enabled){status.enabled=false;status.initialComplete=false;status.phase="disabled";publish();}return structuredClone(vault);});
    hook.setCommand("workbench_wiki",(args)=>{const request=args.request as Record<string,unknown>;
      if(request.action==="topic_delete")wiki.topics=wiki.topics.filter(topic=>topic.id!==request.id);
      if(request.action==="sources")Object.assign(wiki.sources, request.sources);
      if(request.action==="models")Object.assign(wiki.models, request.models);
      if(request.action==="tracking")graph.automaticTracking=!!request.enabled;
      if(request.action==="tracking_retry"){graph.tracking.failed=0;graph.tracking.error="";}
      if(request.action==="tracking_dismiss"){const id=String(request.id);const node=graph.nodes.find(node=>node.id===id);if(node)hidden.set(id,{node,edges:graph.edges.filter(edge=>edge.source===id||edge.target===id)});graph.nodes=graph.nodes.filter(node=>node.id!==id);graph.edges=graph.edges.filter(edge=>edge.source!==id&&edge.target!==id);}
      if(request.action==="tracking_restore"){const item=hidden.get(String(request.id));if(item){graph.nodes.push(item.node);graph.edges.push(...item.edges);hidden.delete(String(request.id));}}
      if(request.action==="topic"){const item=wiki.topics.find(t=>t.id===request.id);if(item)Object.assign(item,request);else wiki.topics.push({id:"topic-1",title:String(request.title),purpose:String(request.purpose),notes:"",pinned:false,excluded:false,stale:false,error:"",published:null,candidate:status.initialComplete?{id:"candidate-1",markdown:"## Candidate\n\nFriday remains a proposal.",citations:[reference]}:null});}
      if(request.action==="review"){if(!status.initialComplete||!status.allowAi)throw new Error("Sync incomplete");const topic=wiki.topics[0]!;if(request.approve)topic.published={...topic.candidate!,markdown:String(request.markdown??topic.candidate?.markdown)};topic.candidate=null;}
      if(request.action!=="state")publish();
      return structuredClone(wiki);
    });
    let serial=1;
    const publish=()=>{status.updatedAt=String(++serial);hook.emit("workbench-updated",structuredClone(status));};
    hook.setCommand("workbench_status",()=>structuredClone(status));
    hook.setCommand("workbench_bind",()=>structuredClone(status));
    let memoryRevision = 1;
    const documents = new Map<string, MemoryDocument>([
      ["memory_summary.md", {path:"memory_summary.md",title:"Memory overview",kind:"snapshot",editable:false,markdown:"# Memory overview\n\n[Long-term memory](MEMORY.md)",revision:"1",citations:[]}],
      ["MEMORY.md", {path:"MEMORY.md",title:"Long-term memory",kind:"note",editable:true,markdown:"# Long-term memory\n\n## Preferences",revision:"1",citations:[]}],
    ]);
    hook.setCommand("workbench_memory_files", (args) => {
      if(args.scope !== status.scope) throw new Error("Account changed");
      const request = args.request as {action:string;path:string;markdown:string;revision:string;title:string};
      if(request.action === "list") return [...documents.values()].map(({markdown: _markdown, revision: _revision, citations: _citations, ...file}) => file);
      if(request.action === "create") {
        const document: MemoryDocument = {path:`notes/note-${++memoryRevision}.md`,title:request.title,kind:"note",editable:true,markdown:`# ${request.title}\n\n`,revision:String(memoryRevision),citations:[]};
        documents.set(document.path, document);return structuredClone(document);
      }
      const document = documents.get(request.path);
      if(!document) throw new Error("Memory file not found");
      if(request.action === "save") {
        if(request.revision !== document.revision) throw new Error("Memory file changed; reload it before saving");
        if(!document.editable) throw new Error("Memory snapshots are read-only");
        document.markdown=request.markdown;document.revision=String(++memoryRevision);
      }
      return structuredClone(document);
    });
    hook.setCommand("e2e_memory_external_edit", (args) => {
      const document=documents.get(String(args.path))!;document.markdown=String(args.markdown);document.revision=String(++memoryRevision);
    });

    hook.setCommand("workbench_configure",(args)=>{status.enabled=!!args.enabled;if(status.enabled)vault.enabled=true;status.allowAi=!!args.allowAi;if(args.automation)Object.assign(status,{automation:args.automation});status.phase=status.enabled?"incomplete":"disabled";publish();return structuredClone(status);});
    hook.setCommand("workbench_search",()=>({items:[{id:"meeting-1995",title:"Project Alpha · 1995",kind:"meeting",excerpt:reference.quote,source:reference}],initialComplete:status.initialComplete}));
    hook.setCommand("workbench_read",()=>record);
    hook.setCommand("workbench_confirm_todos",()=>{record.artifacts.todoSuggestions[0]!.accepted=true;publish();return [{id:"stable-confirmed-task"}];});
    hook.setCommand("workbench_sync",()=>{status.initialComplete=true;status.failed=0;status.synced=2;status.phase="ready";publish();});
    hook.setCommand("workbench_review",()=>({summary:"## Questions\n\nConfirm the launch date.",memoryItems:[{id:"brief-1",text:"Friday remains a proposal",kind:"proposal",citations:[reference]}],todoSuggestions:[],citations:[reference],insufficientEvidence:false}));
    hook.setCommand("workbench_clear",()=>{status.enabled=false;status.allowAi=false;status.memories=[];status.phase="disabled";publish();});
    hook.setCommand("workbench_memory_edit",(args)=>{const item=status.memories.find(item=>item.id===args.id);if(item)Object.assign(item,{text:args.text,pinned:args.pinned,excluded:args.excluded});publish();});
    publish();
  }, DEFAULT_EMBEDDING_MODEL);
  await page.evaluate(async url=>{await (await import(url)).refreshWorkbench();},`/@fs${resolve(__dirname,"../../packages/views/workbench/api.ts")}`);
}

async function openWiki(page: import("@playwright/test").Page) {
  await page.locator(".lyse-sidebar").getByRole("button", {name:"More",exact:true}).click();
  await page.getByRole("dialog", {name:"More",exact:true}).getByRole("button", {name:/^Knowledge base$/}).click();
}

test("More keeps Knowledge base optional and persists sidebar pinning without navigating", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  const sidebar = page.locator(".lyse-sidebar");
  const more = sidebar.getByRole("button",{name:"More",exact:true});
  const wiki = sidebar.getByRole("button",{name:"Knowledge base",exact:true});
  const popup = page.getByRole("dialog",{name:"More",exact:true});
  await expect(wiki).toHaveCount(0);
  await more.click();
  await expect(popup.getByRole("button",{name:"Knowledge base",exact:true})).toBeVisible();
  await popup.getByRole("button",{name:"Pin Knowledge base to sidebar",exact:true}).click();
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("button",{name:"Unpin Knowledge base from sidebar",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(sidebar.getByRole("group",{name:"Pinned features",exact:true}).getByRole("button",{name:"Knowledge base",exact:true})).toBeVisible();
  await expect(sidebar.getByRole("separator")).toBeVisible();
  await expect(page.getByRole("heading",{name:/E2E Tester/})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("sidebar-more-pinned.png"),animations:"disabled"});
  await page.emulateMedia({colorScheme:"dark"});
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.evaluate(async(url)=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await page.setViewportSize({width:690,height:800});
  const chinesePopup = page.getByRole("dialog",{name:"更多",exact:true});
  await expect(chinesePopup.getByRole("button",{name:"从侧边栏取消固定 知识库",exact:true})).toBeVisible();
  const popupBounds = await chinesePopup.boundingBox();
  expect(popupBounds!.x + popupBounds!.width).toBeLessThanOrEqual(690);
  await page.screenshot({path:test.info().outputPath("sidebar-more-dark-zh.png"),clip:{x:0,y:35,width:330,height:450},animations:"disabled"});
  await page.evaluate(async(url)=>{await (await import(url)).changeLanguage("en");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await page.emulateMedia({colorScheme:"light"});
  await page.setViewportSize({width:1280,height:800});
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(more).toBeFocused();
  await wiki.click();
  await expect(page.getByRole("main",{name:"Knowledge base",exact:true})).toBeVisible();
  await expect(wiki).toHaveAttribute("aria-current","page");
  await page.reload();
  await expect(wiki).toBeVisible();
  await more.click();
  await popup.getByRole("button",{name:"Unpin Knowledge base from sidebar",exact:true}).click();
  await expect(wiki).toHaveCount(0);
  await expect(sidebar.getByRole("separator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(more).toBeVisible();
  await expect(wiki).toHaveCount(0);
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  await popup.getByRole("button",{name:"Knowledge base",exact:true}).click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole("main",{name:"Knowledge base",exact:true})).toBeVisible();
});

async function settings(page: import("@playwright/test").Page) {
  await openWiki(page);
  await page.getByRole("button", {name:"Knowledge base settings",exact:true}).click();
  const panel = page.getByRole("main", {name:"Knowledge base settings",exact:true});
  await expect(panel.getByRole("region",{name:"Scope and automatic organization",exact:true})).toBeVisible();
  if(await panel.getByRole("button", {name:"Enable automatic organization",exact:true}).isVisible()) {
    await panel.getByRole("checkbox",{name:"Work",exact:true}).check();
    await panel.getByRole("button",{name:"Enable automatic organization",exact:true}).click();
  }
  await panel.getByText("Advanced settings", {exact:true}).click();
  return panel;
}

async function openLibrary(page: import("@playwright/test").Page) {
  const dialog = await appSettings(page, "AI Assistant");
  await dialog.getByRole("button",{name:"Memory management",exact:true}).click();
  await page.getByRole("button",{name:"Notes and files",exact:true}).click();
}

async function appSettings(page: import("@playwright/test").Page, section = "Notes Sync") {
  await page.getByRole("button", {name:"E2",exact:true}).click();
  await page.getByRole("menuitem", {name:"Settings",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await dialog.getByRole("button",{name:section,exact:true}).click();
  return dialog;
}

async function updateWorkbench(page: import("@playwright/test").Page, patch: Partial<WorkbenchStatus>) {
  await page.evaluate(async (patch) => {
    const runtime = window as unknown as {
      desktopAPI: {workbench: {status: () => Promise<Record<string, unknown>>}};
      __LYNSE_E2E__: {emit: (name: string, payload: unknown) => void};
    };
    const current = await runtime.desktopAPI.workbench.status();
    runtime.__LYNSE_E2E__.emit("workbench-updated", {...current, ...patch, updatedAt: String(Date.now())});
  }, patch);
}

test("Markdown memory files preserve drafts, save, preview and create notes without AI consent", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await openWiki(page);
  await openLibrary(page);
  const library = page.getByRole("region", {name:"Lynclaw memory",exact:true});
  const files = library.getByRole("navigation", {name:"Memory files",exact:true});
  const document = library.getByRole("article", {name:"Memory document",exact:true});
  await expect(document.getByRole("heading", {name:"Long-term memory",exact:true}).first()).toBeVisible();
  await document.getByRole("button", {name:"Edit document",exact:true}).click();
  await document.getByRole("textbox", {name:"Markdown content",exact:true}).fill("# My preferences\n\n- **Reply in Chinese**\n- Keep project context");
  await files.getByRole("button", {name:/Memory overview/}).click();
  await files.getByRole("button", {name:/Long-term memory/}).click();
  await expect(document).toContainText("Reply in Chinese");
  await document.getByRole("button", {name:"Save document",exact:true}).click();
  await expect(document.getByRole("status")).toHaveText("Synced with Lynclaw");
  await expect(document.locator("strong")).toHaveText("Reply in Chinese");
  await library.getByRole("button", {name:"Create memory",exact:true}).click();
  const dialog = page.getByRole("dialog", {name:"Create memory",exact:true});
  await dialog.getByRole("textbox", {name:"Memory title",exact:true}).fill("Project agreements");
  await dialog.getByRole("button", {name:"Create memory",exact:true}).click();
  await expect(document.getByRole("heading", {name:"Project agreements",exact:true}).first()).toBeVisible();
  await document.getByRole("button", {name:"Edit document",exact:true}).click();
  await document.getByRole("textbox", {name:"Markdown content",exact:true}).fill("# Project agreements\n\nDraft to keep while browsing.");
  await page.getByRole("main", {name:"Memory management",exact:true}).getByRole("button", {name:"Back",exact:true}).click();
  await page.getByRole("button",{name:"E2",exact:true}).click();
  await page.getByRole("menuitem",{name:"Settings",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"AI Assistant",exact:true}).click();
  await expect(page.getByRole("dialog").getByRole("button",{name:"AI Assistant",exact:true})).toHaveAttribute("aria-current","true");
  await page.keyboard.press("Escape");
  await openLibrary(page);
  await expect(document.getByRole("textbox", {name:"Markdown content",exact:true})).toHaveValue(/Draft to keep/);
  await document.getByRole("button", {name:"Preview",exact:true}).click();
  await expect(document).toContainText("Draft to keep while browsing.");
  await files.getByRole("button", {name:/Memory overview/}).click();
  await expect(document).toContainText("Generated index");
  await expect(document.getByRole("button", {name:"Edit document",exact:true})).toHaveCount(0);
  await page.setViewportSize({width:690,height:900});
  expect(await library.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await files.getByRole("button", {name:/Project agreements/}).click();
  await page.screenshot({path:test.info().outputPath("markdown-memory-compact.png"),animations:"disabled"});
});

test("Markdown memory conflicts retain the draft until the saved file is explicitly loaded", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await openWiki(page);
  await openLibrary(page);
  const library = page.getByRole("region", {name:"Lynclaw memory",exact:true});
  const document = library.getByRole("article", {name:"Memory document",exact:true});
  await document.getByRole("button", {name:"Edit document",exact:true}).click();
  const editor = document.getByRole("textbox", {name:"Markdown content",exact:true});
  await editor.fill("# My unsaved correction");
  await page.evaluate(async () => {
    const runtime = window as unknown as {__TAURI_INTERNALS__:{invoke:(command:string,args:unknown)=>Promise<unknown>}};
    await runtime.__TAURI_INTERNALS__.invoke("e2e_memory_external_edit", {path:"MEMORY.md",markdown:"# Edited outside Lynse"});
  });
  await document.getByRole("button", {name:"Save document",exact:true}).click();
  await expect(document.getByRole("alert")).toContainText("Your draft has been kept");
  await expect(editor).toHaveValue("# My unsaved correction");
  await document.getByRole("button", {name:"Load saved version",exact:true}).click();
  const dialog = page.getByRole("dialog", {name:"Discard this draft?",exact:true});
  await dialog.getByRole("button", {name:"Cancel",exact:true}).click();
  await expect(editor).toHaveValue("# My unsaved correction");
  await document.getByRole("button", {name:"Load saved version",exact:true}).click();
  await dialog.getByRole("button", {name:"Load saved version",exact:true}).click();
  await expect(document.getByRole("heading", {name:"Edited outside Lynse",exact:true})).toBeVisible();
});

test("cloud memory labels offline edits as pending and retries on reconnect", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await page.evaluate(() => {
    const hook = (window as unknown as {__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void}}).__LYNSE_E2E__;
    let online = false;
    const doc = {path:"MEMORY.md",title:"Shared memory",kind:"note",editable:true,markdown:"# Shared memory",revision:"cloud:1",citations:[],syncState:"synced"};
    hook.setCommand("e2e_cloud_online", () => { online=true; });
    hook.setCommand("workbench_memory_files", (args) => {
      const request=args.request as {action:string;markdown:string};
      if(request.action === "list") {
        if(online && doc.syncState === "pending") { doc.syncState="synced";doc.revision="cloud:2"; }
        return [{path:doc.path,title:doc.title,kind:doc.kind,editable:true}];
      }
      if(request.action === "save") {doc.markdown=request.markdown;doc.revision="local:draft";doc.syncState="pending";}
      return structuredClone(doc);
    });
  });
  await openWiki(page);
  await openLibrary(page);
  const doc = page.getByRole("article", {name:"Memory document",exact:true});
  await doc.getByRole("button", {name:"Edit document",exact:true}).click();
  await doc.getByRole("textbox", {name:"Markdown content",exact:true}).fill("# Offline correction");
  await doc.getByRole("button", {name:"Save document",exact:true}).click();
  await expect(doc.getByRole("status")).toHaveText("Saved on this device · waiting to sync");
  await page.evaluate(async () => {
    const runtime = window as unknown as {__TAURI_INTERNALS__:{invoke:(command:string,args:unknown)=>Promise<unknown>}};
    await runtime.__TAURI_INTERNALS__.invoke("e2e_cloud_online", {});
    window.dispatchEvent(new Event("online"));
  });
  await expect(doc.getByRole("status")).toHaveText("Synced with Lynclaw");
  await expect(doc.getByRole("heading", {name:"Offline correction",exact:true})).toBeVisible();
});

test("default embeddings can be configured, changed and disabled without losing saved choices", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await page.evaluate(() => {
    const runtime = window as unknown as {
      desktopAPI: {workbench: {wiki: (request: Record<string, unknown>) => Promise<unknown>}};
      wikiModelRequests: Record<string, unknown>[];
    };
    runtime.wikiModelRequests = [];
    const original = runtime.desktopAPI.workbench.wiki;
    runtime.desktopAPI.workbench.wiki = (request) => {
      if (request.action === "models") runtime.wikiModelRequests.push(structuredClone(request));
      return original(request);
    };
  });
  let config = await settings(page);

  const modelPanel = config.locator("section").filter({has:page.getByRole("heading",{name:"Vector search (optional)",exact:true})}).last();
  const url = modelPanel.getByRole("textbox",{name:"API base URL",exact:true});
  const model = modelPanel.getByRole("textbox",{name:"Model name",exact:true});
  const key = modelPanel.getByLabel("API key",{exact:true});
  const save = modelPanel.getByRole("button",{name:"Save",exact:true});
  await expect(model).toHaveValue(DEFAULT_EMBEDDING_MODEL.model);
  await expect(url).toHaveValue(DEFAULT_EMBEDDING_MODEL.baseUrl);
  await expect(save).toBeDisabled();
  await modelPanel.scrollIntoViewIfNeeded();
  await page.screenshot({path:test.info().outputPath("wiki-default-embedding.png"),animations:"disabled"});
  await url.fill("http://remote.example.com/v1");
  await expect(modelPanel.getByRole("alert")).toContainText("HTTPS");
  await expect(save).toBeDisabled();
  await url.fill(" https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/ ");
  await key.fill(" synthetic-embedding-key ");
  await save.click();
  await expect(key).toHaveValue("");
  await expect(url).toHaveValue("https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  await expect.poll(() => page.evaluate(() => (window as unknown as {wikiModelRequests:Record<string, unknown>[]}).wikiModelRequests)).toEqual([
    {action:"models",models:{embedding:{baseUrl:"https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",model:DEFAULT_EMBEDDING_MODEL.model},revision:""},embeddingKey:"synthetic-embedding-key"},
  ]);
  await page.keyboard.press("Escape");
  config = await settings(page);
  await expect(url).toHaveValue("https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  await expect(key).toHaveValue("");
  await url.fill("http://localhost:11434/v1");
  await model.fill("local-embedding");
  await config.getByRole("button",{name:"Sync all meetings",exact:true}).click();
  await expect(url).toHaveValue("http://localhost:11434/v1");
  await expect(model).toHaveValue("local-embedding");
  await save.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {wikiModelRequests:Record<string, unknown>[]}).wikiModelRequests.at(-1))).toEqual({action:"models",models:{embedding:{baseUrl:"http://localhost:11434/v1",model:"local-embedding"},revision:""}});
  await modelPanel.getByRole("button",{name:"Restore default model",exact:true}).click();
  await expect(model).toHaveValue(DEFAULT_EMBEDDING_MODEL.model);
  await expect(url).toHaveValue(DEFAULT_EMBEDDING_MODEL.baseUrl);
  await expect(save).toBeDisabled();
  await url.fill("");
  await model.fill("");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {wikiModelRequests:Record<string, unknown>[]}).wikiModelRequests.at(-1))).toEqual({action:"models",models:{embedding:{baseUrl:"",model:""},revision:""}});
});

test("Wiki hides outside test mode and rebinds when the mode changes", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await openWiki(page);
  await page.locator(".lyse-sidebar").getByRole("button",{name:"More",exact:true}).click();
  await page.getByRole("dialog",{name:"More",exact:true}).getByRole("button",{name:"Pin Knowledge base to sidebar",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"More",exact:true}).getByRole("button",{name:"Knowledge base",exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  const memory = page.getByRole("main",{name:"Knowledge base",exact:true});
  await expect(memory.getByRole("heading",{name:"Knowledge base",exact:true}).getByText("Beta",{exact:true})).toBeVisible();

  await page.evaluate(async (url) => {
    const flags = await import(url);
    flags.configureBuildChannel("official");
    flags.setTestMode(false);
  }, `/@fs${resolve(__dirname, "../../packages/views/feature-flags.ts")}`);
  await expect(page.locator(".lyse-sidebar").getByRole("button",{name:"More",exact:true})).toHaveCount(0);
  await expect(page.locator(".lyse-sidebar").getByRole("button",{name:"Knowledge base",exact:true})).toHaveCount(0);
  await expect(memory).toHaveCount(0);
  await expect(page.getByRole("group",{name:"Knowledge graph canvas",exact:true})).toHaveCount(0);
  await updateWorkbench(page,{enabled:true,allowAi:true,initialComplete:true,phase:"ready"});
  await expect(page.getByRole("region",{name:"Meeting Wiki",exact:true})).toHaveCount(0);
  const config = await appSettings(page);
  await expect(config.getByRole("switch", {name:"Enable Wiki",exact:true})).toHaveCount(0);
  await expect(config.getByRole("button", {name:"Open knowledge base & Wiki",exact:true})).toHaveCount(0);
  await expect(config.locator("#vault-enable")).toBeVisible();
  await page.evaluate(async (url) => { (await import(url)).setTestMode(true); }, `/@fs${resolve(__dirname, "../../packages/views/feature-flags.ts")}`);
  await config.getByRole("button",{name:"Open knowledge base settings",exact:true}).click();
  await expect(page.getByRole("main",{name:"Knowledge base settings",exact:true}).getByRole("button", {name:"Enable automatic organization",exact:true})).toBeVisible();
  await expect(page.locator(".lyse-sidebar").getByRole("button",{name:"More",exact:true})).toBeVisible();
  await expect(page.locator(".lyse-sidebar").getByRole("button",{name:"Knowledge base",exact:true})).toBeVisible();
});

test("opening the configured vault folder uses the native command and recovers after failure", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  const config=await settings(page);

  await page.evaluate(()=>{
    const runtime=window as unknown as {__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void};__vaultOpenCalls?:Record<string,unknown>[]};
    runtime.__vaultOpenCalls=[];
    runtime.__LYNSE_E2E__.setCommand("vault_open_folder",args=>{runtime.__vaultOpenCalls!.push(args);if(runtime.__vaultOpenCalls!.length===1)throw new Error("Folder temporarily unavailable");return null;});
    runtime.__LYNSE_E2E__.setCommand("plugin:opener|open_path",()=>{throw new Error("Renderer must not open arbitrary paths");});
  });
  const open=config.getByRole("button",{name:"Open folder",exact:true});
  await open.click();
  await expect(open).toBeEnabled();
  await open.click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__vaultOpenCalls:unknown[]}).__vaultOpenCalls.length)).toBe(2);
  expect(await page.evaluate(()=>(window as unknown as {__vaultOpenCalls:unknown[]}).__vaultOpenCalls)).toEqual([{},{}]);
});

test("Gmail connects as a plugin in Connections; Wiki only selects its source and embedding model", async ({page,mockServer}) => {
  await page.addInitScript(() => localStorage.setItem("lynse_plugins_state", JSON.stringify({"lynse.gmail":{installedAt:1,enabled:true}})));
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  const config = await settings(page);

  await expect(config.getByText(/Text generation uses the model configured for Lynclaw/)).toBeVisible();
  await expect(config.getByRole("group",{name:"Embedding model (optional)",exact:true})).toBeVisible();
  await expect(config.getByRole("group",{name:"Text model",exact:true})).toHaveCount(0);
  await expect(config.getByRole("button",{name:/Connect Gmail|Check authorization/})).toHaveCount(0);
  const connections = await appSettings(page, "Connections Beta");
  const gmail = connections.getByRole("region",{name:"Gmail",exact:true});
  await gmail.getByRole("button",{name:"Connect",exact:true}).click();
  await expect.poll(() => mockServer.integrations.pendingOAuth.size).toBeGreaterThan(0);
  const [state] = [...mockServer.integrations.pendingOAuth.keys()];
  completeOAuth(mockServer.integrations,state!);
  await expect(gmail.getByText("Connected",{exact:true})).toBeVisible({timeout:20000});
  await expect(gmail.getByText("Sync",{exact:true})).toHaveCount(0);
  await page.keyboard.press("Escape");
  await settings(page);
  const source = config.getByRole("switch",{name:"Use connected Gmail in the knowledge base",exact:true});
  await expect(source).toBeEnabled();
  await source.click();
  await expect(source).toBeChecked();
  await page.screenshot({path:test.info().outputPath("wiki-model-and-source.png"),animations:"disabled"});
  await appSettings(page, "Connections Beta");
  await gmail.getByRole("button",{name:"Disconnect",exact:true}).click();
  await page.getByRole("dialog").last().getByRole("button",{name:"Disconnect",exact:true}).click();
  await expect(gmail.getByRole("button",{name:"Connect",exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  await settings(page);
  await expect(source).not.toBeChecked();
  await expect(source).toBeDisabled();
});


test("normal sync fills missing files and cloud refresh is an explicit action", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);await installWorkbench(page);
  const config=await settings(page);

  await page.evaluate(()=>{
    const runtime=window as unknown as {__syncRequests?:Record<string,unknown>[];__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void}};
    runtime.__syncRequests=[];
    runtime.__LYNSE_E2E__.setCommand("workbench_sync",args=>{runtime.__syncRequests!.push(args);return null;});
  });
  await expect(config).toContainText("Existing knowledge-base files are used first");
  await config.getByRole("button",{name:"Sync all meetings",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__syncRequests:Record<string,unknown>[]}).__syncRequests.length)).toBe(1);
  expect(await page.evaluate(()=>(window as unknown as {__syncRequests:Record<string,unknown>[]}).__syncRequests[0]!.refreshExisting)).not.toBe(true);
  await config.getByRole("button",{name:"Check cloud updates",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__syncRequests:Record<string,unknown>[]}).__syncRequests.length)).toBe(2);
  expect(await page.evaluate(()=>(window as unknown as {__syncRequests:Record<string,unknown>[]}).__syncRequests[1])).toEqual({retryFailed:true,refreshExisting:true});
});

test("Lynclaw memory clears drafts and documents when switching accounts",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installWorkbench(page);await openLibrary(page);
  const document=page.getByRole("article",{name:"Memory document",exact:true});
  await document.getByRole("button",{name:"Edit document",exact:true}).click();
  await document.getByRole("textbox",{name:"Markdown content",exact:true}).fill("Previous account private draft");
  await page.evaluate(async url=>{
    const runtime=window as unknown as {desktopAPI:{workbench:{status:()=>Promise<Record<string,unknown>>}};__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void}};
    const status={...await runtime.desktopAPI.workbench.status(),scope:"second-account",userId:"second-user",memories:[],entries:[]};
    runtime.__LYNSE_E2E__.setCommand("workbench_bind",()=>status);
    runtime.__LYNSE_E2E__.setCommand("workbench_status",()=>status);
    const document={path:"MEMORY.md",title:"Second account memory",kind:"note",editable:true,markdown:"# Second account only",revision:"1",citations:[]};
    runtime.__LYNSE_E2E__.setCommand("workbench_memory_files",args=>{
      if(args.scope!==status.scope)throw new Error("Account changed");
      return (args.request as {action:string}).action==="list"?[document]:document;
    });
    (await import(url)).getAuthStore().getState().setUser({id:"second-user",name:"Second user",email:"second@example.test"});
  },`/@fs${resolve(__dirname,"../../packages/core/auth/index.ts")}`);
  await page.getByRole("button",{name:"Notes and files",exact:true}).click();
  await expect(document.getByRole("heading",{name:"Second account only",exact:true})).toBeVisible();
  await expect(page.getByText("Previous account private draft",{exact:true})).toHaveCount(0);
  const drafts=await page.evaluate(async url=>(await import(url)).useMemoryDrafts.getState().drafts,`/@fs${resolve(__dirname,"../../packages/views/workbench/memory-drafts.ts")}`);
  expect(drafts).toEqual({});
});

test("Chinese Lynclaw memory and its AI settings entry remain reachable at narrow widths and zoom",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installWorkbench(page);await openLibrary(page);
  await page.evaluate(async url=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  const memory=page.getByRole("main",{name:"记忆管理",exact:true});
  for(const zoom of ["1","2"]){
    // Browser zoom reduces the CSS viewport; CSS zoom on the root instead
    // enlarges fixed dialogs without changing viewport units.
    await page.setViewportSize({width:zoom==="1"?680:640,height:zoom==="1"?900:450});
    expect(await memory.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await memory.getByRole("button",{name:"返回",exact:true}).click();
    await page.getByRole("button",{name:"E2",exact:true}).click();
    await page.getByRole("menuitem",{name:"设置",exact:true}).click();
    await page.getByRole("dialog",{name:"设置",exact:true}).getByRole("button",{name:"AI 助手",exact:true}).click();
    const settings=page.getByRole("dialog",{name:"设置",exact:true});
    const entry=settings.getByRole("button",{name:"记忆管理",exact:true});
    await expect(settings.getByRole("button",{name:"AI 助手",exact:true})).toHaveAttribute("aria-current","true");
    await entry.scrollIntoViewIfNeeded();await expect(entry).toBeInViewport();
    expect(await entry.evaluate(el=>{const bounds=el.getBoundingClientRect();return bounds.left>=0&&bounds.right<=window.innerWidth;})).toBe(true);
    await page.screenshot({path:test.info().outputPath(`lynclaw-memory-entry-zh-zoom-${zoom}.png`),animations:"disabled"});
    await entry.focus();await page.keyboard.press("Enter");await expect(memory).toBeVisible();
  }
});
