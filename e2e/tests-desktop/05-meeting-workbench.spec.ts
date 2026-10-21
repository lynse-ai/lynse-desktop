import { resolve } from "node:path";
import { completeOAuth } from "../fixtures/integrations-mock";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { DEFAULT_EMBEDDING_MODEL } from "../../packages/views/workbench/embedding-model";
import type { KnowledgeGraph, WorkbenchStatus, MemoryDocument } from "../../packages/views/workbench/types";

// Native durability and pagination are exercised by Rust tests. This fixture
// checks the real renderer's consent, incomplete-sync and review interactions.
async function installWorkbench(page: import("@playwright/test").Page) {
  await page.evaluate((defaultEmbedding) => {
    const hook = (window as unknown as { __LYNSE_E2E__: {setCommand: (name: string, handler: (args: Record<string, unknown>) => unknown) => void; emit: (name: string, payload: unknown) => void} }).__LYNSE_E2E__;
    const reference = {id:"meeting-1995",kind:"meeting",revision:"r1",quote:"Friday is only a proposal.",startMs:12000};
    const status = {scope:"synthetic-account",userId:"user-e2e",enabled:false,allowAi:false,initialComplete:false,phase:"disabled",updatedAt:"1",error:"",discovered:2,synced:1,awaitingTranscription:0,failed:1,conflicts:0,
      entries:[{id:"meeting-1995",kind:"meeting",title:"Project Alpha · 1995",revision:"r1",status:"synced",excluded:false,error:""},{id:"meeting-2026",kind:"meeting",title:"Project Alpha · 2026",revision:"r2",status:"failed",excluded:false,error:"Network unavailable"}],
      memories:[{id:"memory-1",sourceId:"meeting-1995",sourceTitle:"Project Alpha",kind:"proposal",text:"Friday remains a proposal",citations:[reference]}]};
    const record = {document:{id:"meeting-1995",kind:"meeting",title:"Project Alpha · 1995",revision:"r1",transcript:reference.quote,outline:"Review the deadline",segments:[{id:"s1",text:reference.quote,startMs:12000,speakerName:"Sam"}],conclusions:[{id:"v1",templateName:"Original summary",conclusionText:"No final date was agreed."},{id:"v2",templateName:"Updated summary",conclusionText:"The team still needs to confirm."}],todos:[],aiContextEnabled:true},markdown:"# Project Alpha",artifacts:{summaries:[],todoSuggestions:[{id:"suggestion-1",title:"Confirm the launch date",citations:[reference],accepted:false}]}};
    const vault={enabled:false,path:"/tmp/lynse-e2e-vault"};
    const graph: KnowledgeGraph = { automaticTracking:true,tracking:{processing:false,completed:2,total:2,failed:0,error:""},nodes:[
      {id:"entity:alpha",kind:"project",title:"Project Alpha",description:"Launch date needs confirmation.",status:"blocked",citations:[reference],updates:[{description:"Launch date needs confirmation.",status:"blocked",observedAt:"2026-10-20",citations:[reference]},{description:"Initial development started.",status:"active",observedAt:"2026-10-01",citations:[reference]}]},
      {id:"entity:goal",kind:"goal",title:"Friday launch",description:"Friday remains a proposal.",status:"proposed",citations:[reference],updates:[{description:"Friday remains a proposal.",status:"proposed",observedAt:"2026-10-20",citations:[reference]}]},
      {id:"wiki:topic-1",kind:"wiki",title:"Launch plan",description:"Review the launch plan",status:"published",wikiId:"topic-1",citations:[reference],updates:[]},
      {id:"source:meeting-1995",kind:"source",title:"Project Alpha · 1995",description:reference.quote,status:"source",source:reference,citations:[reference],updates:[]}
    ],edges:[{id:"g1",source:"entity:alpha",target:"entity:goal",kind:"related"},{id:"g2",source:"entity:alpha",target:"source:meeting-1995",kind:"evidence"},{id:"g3",source:"wiki:topic-1",target:"source:meeting-1995",kind:"evidence"}]};
    const hidden = new Map<string,{node:KnowledgeGraph["nodes"][number];edges:KnowledgeGraph["edges"]}>();
    const wiki={graph,topics:[] as {id:string;title:string;purpose:string;notes:string;pinned:boolean;excluded:boolean;stale:boolean;error:string;candidate:{id:string;markdown:string;citations:typeof reference[]}|null;published:{id:string;markdown:string;citations:typeof reference[]}|null}[],models:{embedding:defaultEmbedding,revision:""},sources:{gmailEnabled:false,gmailAccountId:"",integrationsUrl:""}};
    hook.setCommand("vault_config_get",()=>structuredClone(vault));
    hook.setCommand("vault_default_path",()=>"/tmp/lynse-e2e-vault");
    hook.setCommand("vault_config_save",(args)=>{Object.assign(vault,args.config);if(!vault.enabled){status.enabled=false;status.initialComplete=false;status.phase="disabled";publish();}return structuredClone(vault);});
    hook.setCommand("workbench_wiki",(args)=>{const request=args.request as Record<string,unknown>;
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

    hook.setCommand("workbench_configure",(args)=>{status.enabled=!!args.enabled;if(status.enabled)vault.enabled=true;status.allowAi=!!args.allowAi;status.phase=status.enabled?"incomplete":"disabled";publish();return structuredClone(status);});
    hook.setCommand("workbench_search",()=>({items:[{id:"meeting-1995",title:"Project Alpha · 1995",kind:"meeting",excerpt:reference.quote,source:reference}],initialComplete:status.initialComplete}));
    hook.setCommand("workbench_read",()=>record);
    hook.setCommand("workbench_confirm_todos",()=>{record.artifacts.todoSuggestions[0]!.accepted=true;publish();return [{id:"stable-confirmed-task"}];});
    hook.setCommand("workbench_sync",()=>{status.initialComplete=true;status.failed=0;status.synced=2;status.phase="ready";publish();});
    hook.setCommand("workbench_review",()=>({summary:"## Questions\n\nConfirm the launch date.",memoryItems:[{id:"brief-1",text:"Friday remains a proposal",kind:"proposal",citations:[reference]}],todoSuggestions:[],citations:[reference],insufficientEvidence:false}));
    hook.setCommand("workbench_clear",()=>{status.enabled=false;status.allowAi=false;status.memories=[];status.phase="disabled";publish();});
    hook.setCommand("workbench_memory_edit",(args)=>{const item=status.memories.find(item=>item.id===args.id);if(item)Object.assign(item,{text:args.text,pinned:args.pinned,excluded:args.excluded});publish();});
    publish();
  }, DEFAULT_EMBEDDING_MODEL);
}

async function openWiki(page: import("@playwright/test").Page) {
  await page.locator(".lyse-sidebar").getByRole("button", {name:"More",exact:true}).click();
  await page.getByRole("dialog", {name:"More",exact:true}).getByRole("button", {name:"Wiki",exact:true}).click();
}

test("More keeps Wiki optional and persists sidebar pinning without navigating", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  const sidebar = page.locator(".lyse-sidebar");
  const more = sidebar.getByRole("button",{name:"More",exact:true});
  const wiki = sidebar.getByRole("button",{name:"Wiki",exact:true});
  const popup = page.getByRole("dialog",{name:"More",exact:true});
  await expect(wiki).toHaveCount(0);
  await more.click();
  await expect(popup.getByRole("button",{name:"Wiki",exact:true})).toBeVisible();
  await popup.getByRole("button",{name:"Pin Wiki to sidebar",exact:true}).click();
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("button",{name:"Unpin Wiki from sidebar",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(sidebar.getByRole("group",{name:"Pinned features",exact:true}).getByRole("button",{name:"Wiki",exact:true})).toBeVisible();
  await expect(sidebar.getByRole("separator")).toBeVisible();
  await expect(page.getByRole("heading",{name:/E2E Tester/})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("sidebar-more-pinned.png"),animations:"disabled"});
  await page.emulateMedia({colorScheme:"dark"});
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.evaluate(async(url)=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await page.setViewportSize({width:690,height:800});
  const chinesePopup = page.getByRole("dialog",{name:"更多",exact:true});
  await expect(chinesePopup.getByRole("button",{name:"从侧边栏取消固定 Wiki",exact:true})).toBeVisible();
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
  await expect(page.getByRole("main",{name:"Memory",exact:true})).toBeVisible();
  await expect(wiki).toHaveAttribute("aria-current","page");
  await page.reload();
  await expect(wiki).toBeVisible();
  await more.click();
  await popup.getByRole("button",{name:"Unpin Wiki from sidebar",exact:true}).click();
  await expect(wiki).toHaveCount(0);
  await expect(sidebar.getByRole("separator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(more).toBeVisible();
  await expect(wiki).toHaveCount(0);
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  await popup.getByRole("button",{name:"Wiki",exact:true}).click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole("main",{name:"Memory",exact:true})).toBeVisible();
});

async function settings(page: import("@playwright/test").Page) {
  await openWiki(page);
  await page.getByRole("tab", {name:"Memory settings",exact:true}).click();
  return page.getByRole("tabpanel", {name:"Memory settings",exact:true});
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
  await page.getByRole("tab", {name:"Memory library",exact:true}).click();
  const library = page.getByRole("tabpanel", {name:"Memory library",exact:true});
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
  await page.getByRole("tab", {name:"Wiki",exact:true}).click();
  await page.getByRole("tab", {name:"Memory library",exact:true}).click();
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
  await page.getByRole("tab", {name:"Memory library",exact:true}).click();
  const library = page.getByRole("tabpanel", {name:"Memory library",exact:true});
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
  await page.getByRole("tab", {name:"Memory library",exact:true}).click();
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

test("knowledge graph explores discoveries, history, sources and tracking controls", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await installWorkbench(page);
  await page.evaluate(async () => {
    const api = (window as unknown as { desktopAPI: { workbench: { configure:(enabled:boolean,allowAi:boolean)=>Promise<unknown>;sync:()=>Promise<void> } } }).desktopAPI.workbench;
    await api.configure(true,true);
    await api.sync();
  });
  await updateWorkbench(page, { enabled:true, allowAi:true, initialComplete:true, phase:"ready", wikiProgress:{stage:"complete",completed:1,total:1,currentTitle:"",topicTitle:"",failed:0} });
  await openWiki(page);
  const notes = page.getByRole("navigation", {name:"Wiki notes",exact:true});
  await notes.getByRole("button", {name:"Project Alpha",exact:true}).click();
  const panel = page.getByRole("tabpanel", {name:"Wiki",exact:true});
  const canvas = panel.getByRole("group", {name:"Knowledge graph canvas",exact:true});
  const details = panel.getByRole("region", {name:"Note content",exact:true});
  await expect(details.getByRole("heading", {name:"Project Alpha",exact:true})).toBeVisible();
  await expect(details.getByText("Initial development started.",{exact:true})).toBeVisible();
  await expect(details.getByText("Project · Blocked",{exact:true})).toBeVisible();
  await expect(canvas.getByRole("button", {name:"Goal: Friday launch",exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("knowledge-graph.png"),animations:"disabled"});
  await panel.getByRole("button", {name:"Zoom in",exact:true}).click();
  await panel.getByRole("button", {name:"Reset view",exact:true}).click();
  await canvas.getByRole("button", {name:"Goal: Friday launch",exact:true}).focus();
  await page.keyboard.press("Enter");
  await expect(details.getByRole("heading", {name:"Friday launch",exact:true})).toBeVisible();
  await expect(details.getByText("Goal · Proposed",{exact:true})).toBeVisible();
  await details.getByRole("button", {name:/Project Alpha · 1995/}).click();
  const source = details.getByRole("article",{name:"Meeting note",exact:true});
  await expect(source.getByRole("heading",{name:"Project Alpha · 1995",exact:true})).toBeVisible();
  await expect(source).toContainText("Friday is only a proposal.");
  await canvas.getByRole("button",{name:"Goal: Friday launch",exact:true}).click();
  await expect(source).toHaveCount(0);
  await panel.getByRole("textbox",{name:"Search graph names or updates",exact:true}).fill("unrelated");
  await expect(panel.getByText("No matching local sources.",{exact:true})).toBeVisible();
  await panel.getByRole("textbox",{name:"Search graph names or updates",exact:true}).fill("");
  await panel.getByRole("button",{name:"Goal 1",exact:true}).click();
  await expect(canvas.getByRole("button")).toHaveCount(1);
  await details.getByRole("button",{name:"Stop showing this discovery",exact:true}).click();
  await expect(canvas.getByRole("button")).toHaveCount(0);
  await page.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(canvas.getByRole("button",{name:"Goal: Friday launch",exact:true})).toBeVisible();
  await canvas.getByRole("button",{name:"Goal: Friday launch",exact:true}).click();
  await details.getByRole("button",{name:"Stop showing this discovery",exact:true}).click();
  await expect(canvas.getByRole("button")).toHaveCount(0);
  await panel.getByText("Automatically discover & track",{exact:true}).first().click();
  const tracking = panel.getByRole("switch",{name:"Automatically discover & track",exact:true});
  await tracking.click();
  await expect(tracking).not.toBeChecked();
  await panel.getByRole("button",{name:"All 3",exact:true}).click();
  await expect(canvas.getByRole("button",{name:"Project: Project Alpha",exact:true})).toBeVisible();
  await tracking.click();
  await expect(tracking).toBeChecked();
  await canvas.getByRole("button",{name:"Wiki page: Launch plan",exact:true}).click();
  await details.getByRole("button",{name:"View Wiki page",exact:true}).click();
  await expect(page.getByRole("tab",{name:"Wiki",exact:true})).toHaveAttribute("aria-selected","true");
  await page.getByRole("tab",{name:"Wiki",exact:true}).click();
  await page.setViewportSize({width:690,height:900});
  await expect(canvas).toBeVisible();
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("knowledge-graph-compact.png"),animations:"disabled"});
});

test("failed discovery pauses with a retry and preserves usable graph nodes", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await page.evaluate(async () => {
    const runtime=window as unknown as {desktopAPI:{workbench:{configure:(enabled:boolean,allowAi:boolean)=>Promise<unknown>;sync:()=>Promise<void>;status:()=>Promise<WorkbenchStatus>;wiki:(request:Record<string,unknown>)=>Promise<import("../../packages/views/workbench/types").WikiState>}};__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void}};
    await runtime.desktopAPI.workbench.configure(true,true);
    await runtime.desktopAPI.workbench.sync();
    const status=await runtime.desktopAPI.workbench.status();
    runtime.__LYNSE_E2E__.setCommand("workbench_bind",()=>structuredClone(status));
    const value=await runtime.desktopAPI.workbench.wiki({action:"state"});
    value.graph!.tracking={processing:false,paused:true,completed:1,total:5,failed:3,error:"Discovery names do not match source evidence"};
    runtime.__LYNSE_E2E__.setCommand("workbench_wiki",args=>{const request=args.request as Record<string,unknown>;if(request.action==="tracking_retry")value.graph!.tracking={...value.graph!.tracking,paused:false,failed:0,error:"",processing:true};return structuredClone(value);});
  });
  await openWiki(page);
  await page.getByRole("tab",{name:"Wiki",exact:true}).click();
  const panel=page.getByRole("tabpanel",{name:"Wiki",exact:true});
  await expect(panel.getByRole("alert")).toHaveText("3 sections need a retry. Other findings are available.");
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByRole("button",{name:"Project: Project Alpha",exact:true})).toBeVisible();
  await panel.getByText("View reason",{exact:true}).click();
  await expect(panel.getByText("The discovered names could not be verified in the cited text. These findings were not saved. Retry the failed sections; existing findings will be kept.",{exact:true})).toBeVisible();
  await page.evaluate(async(url)=>{await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await panel.getByText("查看原因",{exact:true}).click();
  await expect(panel.getByText("模型返回的名称无法在所引原文中核实，这些发现未被保存。请重试失败资料，已有发现会保留。",{exact:true})).toBeVisible();
  await expect(panel.getByText("Discovery names do not match source evidence",{exact:true})).toHaveCount(0);
  await page.evaluate(async(url)=>{await (await import(url)).changeLanguage("en");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await panel.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveText("Discovering · 1 / 5 text sections processed");
});

test("Memory sidebar manages Wiki, memories, settings and the settings shortcut", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  const config = await settings(page);
  await config.getByRole("switch",{name:"Enable Wiki",exact:true}).click();
  const main = page.getByRole("main",{name:"Memory",exact:true});
  await expect(main.getByRole("heading",{name:"Memory",exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Memory library",exact:true}).click();
  const library = page.getByRole("tabpanel",{name:"Memory library",exact:true});
  await library.getByRole("tab",{name:"Legacy meeting memories",exact:true}).click();
  await expect(library.getByText("Friday remains a proposal",{exact:true})).toBeVisible();
  await library.getByRole("button",{name:"Edit",exact:true}).click();
  await library.getByRole("textbox",{name:"Edit",exact:true}).fill("Friday still needs confirmation");
  await library.getByRole("button",{name:"Save",exact:true}).click();
  await expect(library.getByText("Friday still needs confirmation",{exact:true})).toBeVisible();
  await library.getByRole("button",{name:"Pin",exact:true}).click();
  await expect(library.getByRole("button",{name:"Unpin",exact:true})).toBeVisible();
  await library.getByRole("button",{name:"Exclude",exact:true}).click();
  await expect(library.getByText("Friday still needs confirmation",{exact:true})).toHaveCount(0);
  await library.getByRole("switch",{name:"Show excluded memories",exact:true}).click();
  await expect(library.getByText("Friday still needs confirmation",{exact:true})).toBeVisible();
  await library.getByRole("button",{name:"Include in AI",exact:true}).click();
  await expect(library.getByRole("button",{name:"Exclude",exact:true})).toBeVisible();
  await library.getByRole("textbox",{name:"Search memory titles or file names",exact:true}).fill("unrelated");
  await expect(library.getByText("No matching local sources.",{exact:true})).toBeVisible();
  await library.getByRole("textbox",{name:"Search memory titles or file names",exact:true}).fill("");
  await page.screenshot({path:test.info().outputPath("memory-library.png"),animations:"disabled"});
  await page.getByRole("tab",{name:"Wiki",exact:true}).click();
  await expect(page.getByRole("tabpanel",{name:"Wiki",exact:true}).getByRole("heading",{name:"Projects & topics",exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("memory-wiki.png"),animations:"disabled"});
  const dialog = await appSettings(page);
  await expect(dialog.getByRole("switch",{name:"Enable Wiki",exact:true})).toHaveCount(0);
  await dialog.getByRole("button",{name:"Manage Wiki & memory",exact:true}).click();
  await expect(config.getByRole("switch",{name:"Enable Wiki",exact:true})).toBeChecked();
});

test("home shows live Wiki stage progress and skips unavailable meetings", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  const base = {enabled:true,allowAi:true,initialComplete:true,discovered:210,synced:159,awaitingTranscription:50,failed:1,conflicts:0};
  const progress = {stage:"analyzing" as const,completed:20,total:80,currentTitle:"Project Alpha meeting",topicTitle:"Launch",failed:0};
  await updateWorkbench(page,{...base,phase:"processing",wikiProgress:progress});
  const card = page.getByRole("region",{name:"Meeting Wiki",exact:true});
  await expect(card).toBeInViewport();
  await expect(card.getByText("Analyzing meeting text",{exact:true})).toBeVisible();
  await expect(card.getByText("20 / 80 text sections analyzed",{exact:true})).toBeVisible();
  await expect(card.getByRole("progressbar",{name:"Wiki progress"})).toHaveAttribute("aria-valuenow","25");
  await expect(card.getByText(/50 awaiting transcription · 1 failed to sync/)).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await updateWorkbench(page,{...base,phase:"processing",wikiProgress:{...progress,completed:40}});
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow","50");
  await page.screenshot({path:test.info().outputPath("wiki-home-analyzing.png"),animations:"disabled"});
  await page.setViewportSize({width:690,height:450});
  await expect(card.getByRole("progressbar")).toBeInViewport();
  await page.screenshot({path:test.info().outputPath("wiki-home-compact.png"),animations:"disabled"});
  await page.setViewportSize({width:1280,height:800});
  await updateWorkbench(page,{...base,phase:"processing",wikiProgress:{...progress,stage:"compiling",completed:1,total:4,currentTitle:""}});
  await expect(card.getByText("Generating Wiki pages",{exact:true})).toBeVisible();
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow","25");
  await updateWorkbench(page,{...base,phase:"processing",wikiProgress:{...progress,stage:"embedding",completed:60,topicTitle:""}});
  await expect(card.getByText("Building the search index",{exact:true})).toBeVisible();
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow","75");
  await card.getByRole("button",{name:"View Wiki",exact:true}).click();
  await expect(page.getByRole("main",{name:"Memory",exact:true})).toBeVisible();
  await expect(page.getByRole("tab",{name:"Wiki",exact:true})).toHaveAttribute("aria-selected","true");
  await page.getByRole("button",{name:"Home",exact:true}).click();
  await updateWorkbench(page,{...base,phase:"ready",wikiProgress:{...progress,stage:"complete",completed:2,total:2,currentTitle:"",topicTitle:""}});
  await expect(card).toHaveCount(0);
  await updateWorkbench(page,{...base,phase:"processing",wikiProgress:{...progress,completed:1}});
  await expect(card.getByRole("progressbar")).toBeVisible();
});

test("home distinguishes syncing, permission waits, configuration and processing errors", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  const base = {enabled:true,allowAi:true,discovered:210,synced:159,awaitingTranscription:50,failed:1,conflicts:0};
  const card = page.getByRole("region",{name:"Meeting Wiki",exact:true});
  await updateWorkbench(page,{...base,initialComplete:false,phase:"syncing"});
  await expect(card.getByText("159 / 159 available meetings synced",{exact:true})).toBeVisible();
  await updateWorkbench(page,{...base,initialComplete:false,phase:"discovering"});
  await expect(card.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  await updateWorkbench(page,{...base,initialComplete:true,allowAi:false,phase:"ready"});
  await expect(card.getByText("Waiting for AI processing permission",{exact:true})).toBeVisible();
  await updateWorkbench(page,{...base,initialComplete:true,phase:"waiting_configuration"});
  await expect(card.getByText(/waiting for Wiki text model configuration/)).toBeVisible();
  await updateWorkbench(page,{...base,initialComplete:true,phase:"ready",wikiProgress:{stage:"complete",completed:0,total:0,currentTitle:"",topicTitle:"",failed:0}});
  await expect(card).toHaveCount(0);
  await updateWorkbench(page,{...base,initialComplete:true,phase:"ready",wikiProgress:{stage:"complete",completed:1,total:2,currentTitle:"",topicTitle:"",failed:1}});
  await expect(card.getByText("Wiki processing needs attention",{exact:true})).toBeVisible();
  await updateWorkbench(page,{...base,initialComplete:true,phase:"failed",error:"Model service unavailable"});
  await expect(card.getByText("Wiki processing needs attention",{exact:true})).toBeVisible();
  await expect(card.getByRole("alert")).toContainText("Model service unavailable");
  await updateWorkbench(page,{...base,enabled:false,phase:"disabled"});
  await expect(card).toHaveCount(0);
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
  await config.getByRole("switch",{name:"Enable Wiki",exact:true}).click();
  await config.getByText("Wiki models",{exact:true}).click();
  const modelPanel = config.locator("details").filter({hasText:"Wiki models"});
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
  await config.getByText("Wiki models",{exact:true}).click();
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

test("consent, incomplete-sync gate, offline source reading and confirmed suggestions",async({page,mockServer})=>{
  await page.route("**/*",(route)=>["localhost","127.0.0.1"].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  const config=await settings(page);
  const enable=config.getByRole("switch",{name:"Enable Wiki",exact:true});
  await expect(enable).not.toBeChecked();await enable.click();
  await expect(config.getByRole("switch",{name:"Allow AI processing of eligible text",exact:true})).not.toBeChecked();
  await config.getByRole("switch",{name:"Allow AI processing of eligible text",exact:true}).click();
  await config.getByRole("button",{name:"Open knowledge base & Wiki",exact:true}).click();
  const reader=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"Meeting Wiki",exact:true})});
  await reader.getByRole("textbox",{name:"Search a project, topic or meeting"}).fill("Alpha");
  await expect(reader.getByRole("button",{name:"Prepare meeting brief",exact:true})).toBeDisabled();
  await reader.getByRole("button",{name:"Project Alpha · 1995",exact:true}).click();
  await expect(reader.getByText("Friday is only a proposal.",{exact:false})).toBeVisible();
  await expect(reader.getByText("No final date was agreed.",{exact:true})).toBeVisible();
  await expect(reader.getByText("The team still needs to confirm.",{exact:true})).toBeVisible();
  await page.context().setOffline(true);
  await reader.getByRole("button",{name:"Add task",exact:true}).click();
  await expect(reader.getByRole("button",{name:"Added",exact:true})).toBeDisabled();
  await page.screenshot({path:test.info().outputPath("workbench-offline.png"),animations:"disabled"});
  await page.keyboard.press("Escape");
  await config.getByRole("button",{name:"Sync all meetings",exact:true}).click();
  await config.getByRole("button",{name:"Open knowledge base & Wiki",exact:true}).click();
  await reader.getByRole("textbox",{name:"Search a project, topic or meeting"}).fill("Alpha");
  await reader.getByRole("button",{name:"Prepare meeting brief",exact:true}).click();
  await expect(reader.getByRole("heading",{name:"Questions",exact:true})).toBeVisible();
  await expect(reader.getByText("Friday remains a proposal",{exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("workbench-brief.png"),animations:"disabled"});
});


test("Wiki and local sync switches follow native returned state",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installWorkbench(page);const config=await settings(page);
  const wiki=config.getByRole("switch",{name:"Enable Wiki",exact:true});
  const sync=config.getByRole("switch").first();
  await expect(sync).not.toBeChecked();await wiki.click();await expect(sync).toBeChecked();await expect(wiki).toBeChecked();
  await wiki.click();await expect(wiki).not.toBeChecked();await expect(sync).toBeChecked();
  await wiki.click();await sync.click();await expect(wiki).not.toBeChecked();await expect(sync).not.toBeChecked();
  await sync.click();await expect(sync).toBeChecked();await expect(wiki).not.toBeChecked();
  await page.screenshot({path:test.info().outputPath("wiki-vault-settings.png"),animations:"disabled"});
});

test("topics produce a reviewable candidate and publish only after full sync",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installWorkbench(page);const config=await settings(page);
  await config.getByRole("switch",{name:"Enable Wiki",exact:true}).click();
  await config.getByRole("switch",{name:"Allow AI processing of eligible text",exact:true}).click();
  await config.getByRole("button",{name:"Sync all meetings",exact:true}).click();
  await config.getByRole("button",{name:"Open knowledge base & Wiki",exact:true}).click();
  const reader=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"Meeting Wiki",exact:true})});
  await reader.getByRole("textbox",{name:"Project or topic name",exact:true}).fill("Project Alpha");
  await reader.getByRole("textbox",{name:"Purpose and key questions",exact:true}).fill("Which launch decisions remain open?");
  await reader.getByRole("button",{name:"Create topic",exact:true}).click();
  await expect(reader.getByText("Candidate · awaiting review",{exact:true})).toBeVisible();
  await reader.getByRole("textbox",{name:"Page content",exact:true}).fill("## Reviewed decision\n\nNo launch date was agreed.");
  await reader.getByRole("button",{name:"Approve and publish",exact:true}).click();
  await expect(reader.getByText("Published",{exact:true})).toBeVisible();
  await expect(reader.getByRole("heading",{name:"Reviewed decision",exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("wiki-reviewed-page.png"),animations:"disabled"});
});

test("folder configuration failure does not show Wiki enabled",async({page,mockServer})=>{
  await openWorkspace(page,mockServer.url);await installWorkbench(page);
  await page.evaluate(()=>{(window as unknown as {__LYNSE_E2E__:{setCommand:(name:string,handler:()=>unknown)=>void}}).__LYNSE_E2E__.setCommand("workbench_configure",()=>{throw new Error("Folder is not writable");});});
  const config=await settings(page);await config.getByRole("switch",{name:"Enable Wiki",exact:true}).click();
  await expect(config.getByRole("switch",{name:"Enable Wiki",exact:true})).not.toBeChecked();await expect(config.locator("#vault-enable")).not.toBeChecked();
  await expect(config.getByRole("alert")).toContainText("Folder is not writable");
});


test("Wiki hides outside test mode and rebinds when the mode changes", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await openWiki(page);
  await page.locator(".lyse-sidebar").getByRole("button",{name:"More",exact:true}).click();
  await page.getByRole("dialog",{name:"More",exact:true}).getByRole("button",{name:"Pin Wiki to sidebar",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"More",exact:true}).getByRole("button",{name:"Wiki",exact:true}).getByText("Beta",{exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  const memory = page.getByRole("main",{name:"Memory",exact:true});
  await expect(memory.getByRole("heading",{name:"Memory",exact:true}).getByText("Beta",{exact:true})).toBeVisible();
  await expect(memory.getByRole("tab",{name:"Wiki",exact:true}).getByText("Beta",{exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Wiki",exact:true}).click();
  await page.evaluate(async (url) => {
    const flags = await import(url);
    flags.configureBuildChannel("official");
    flags.setTestMode(false);
  }, `/@fs${resolve(__dirname, "../../packages/views/feature-flags.ts")}`);
  await expect(page.locator(".lyse-sidebar").getByRole("button",{name:"More",exact:true})).toHaveCount(0);
  await expect(page.locator(".lyse-sidebar").getByRole("button",{name:"Wiki",exact:true})).toHaveCount(0);
  await expect(memory).toHaveCount(0);
  await expect(page.getByRole("group",{name:"Knowledge graph canvas",exact:true})).toHaveCount(0);
  await updateWorkbench(page,{enabled:true,allowAi:true,initialComplete:true,phase:"ready"});
  await expect(page.getByRole("region",{name:"Meeting Wiki",exact:true})).toHaveCount(0);
  const config = await appSettings(page);
  await expect(config.getByRole("switch", {name:"Enable Wiki",exact:true})).toHaveCount(0);
  await expect(config.getByRole("button", {name:"Open knowledge base & Wiki",exact:true})).toHaveCount(0);
  await expect(config.locator("#vault-enable")).toBeVisible();
  await page.evaluate(async (url) => { (await import(url)).setTestMode(true); }, `/@fs${resolve(__dirname, "../../packages/views/feature-flags.ts")}`);
  await config.getByRole("button",{name:"Manage Wiki & memory",exact:true}).click();
  await expect(page.getByRole("tabpanel",{name:"Memory settings",exact:true}).getByRole("switch", {name:"Enable Wiki",exact:true})).toBeVisible();
  await expect(page.locator(".lyse-sidebar").getByRole("button",{name:"More",exact:true})).toBeVisible();
  await expect(page.locator(".lyse-sidebar").getByRole("button",{name:"Wiki",exact:true})).toBeVisible();
});

test("opening the configured vault folder uses the native command and recovers after failure", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  const config=await settings(page);
  await config.getByRole("switch",{name:"Enable Wiki",exact:true}).click();
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

test("failed topics stay visible with a targeted retry alongside the graph", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await page.evaluate(async()=>{
    const runtime=window as unknown as {desktopAPI:{workbench:{configure:(enabled:boolean,allowAi:boolean)=>Promise<unknown>;sync:()=>Promise<void>;status:()=>Promise<WorkbenchStatus>;wiki:(request:Record<string,unknown>)=>Promise<import("../../packages/views/workbench/types").WikiState>}};__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void;emit:(name:string,payload:unknown)=>void};__topicRetries?:string[]};
    const api=runtime.desktopAPI.workbench;await api.configure(true,true);await api.sync();
    const value=await api.wiki({action:"state"});const status=await api.status();
    const ref={id:"meeting-1995",kind:"meeting",revision:"r1",quote:"Friday is only a proposal."};
    const common={title:"Project Alpha",purpose:"Project status",notes:"",pinned:false,excluded:false,stale:false,candidate:null};
    value.topics=[{...common,id:"published-topic",title:"Project Beta",error:"",published:{id:"published-page",markdown:"# Project Alpha\n\n"+"Published meeting details.\n\n".repeat(700),citations:[ref],fingerprint:"f",createdAt:"",reviewedAt:"",review:"approved"}},{...common,id:"failed-topic",error:"Lynclaw synthesis failed (HTTP 422): Every claim needs source citations",published:null}];
    status.error="Wiki processing failed for 1 topics; open Wiki to review and retry";status.wikiProgress={stage:"complete",completed:1,total:2,currentTitle:"",topicTitle:"",failed:1};
    runtime.__topicRetries=[];
    runtime.__LYNSE_E2E__.setCommand("workbench_wiki",args=>{const request=args.request as Record<string,unknown>;if(request.action==="retry"){runtime.__topicRetries!.push(String(request.id));value.topics.find(t=>t.id===request.id)!.error="";status.error="";status.wikiProgress={...status.wikiProgress!,stage:"preparing",failed:0};status.updatedAt=String(Date.now());runtime.__LYNSE_E2E__.emit("workbench-updated",status);}return structuredClone(value);});
    runtime.__LYNSE_E2E__.emit("workbench-updated",{...status,updatedAt:String(Date.now())});
  });
  await openWiki(page);
  const panel=page.getByRole("tabpanel",{name:"Wiki",exact:true});
  const attention=page.getByRole("region",{name:"Wiki needs attention",exact:true});
  await expect(attention.getByRole("heading",{name:"Project Alpha",exact:true})).toBeInViewport();
  await expect(attention).toContainText("citations");
  await expect(panel.locator('[id^="wiki-topic-"]').first()).toHaveAttribute("id","wiki-topic-failed-topic");
  await expect(panel.locator("#wiki-topic-failed-topic").getByText("Generation failed",{exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Wiki",exact:true}).click();
  await expect(attention.getByRole("heading",{name:"Project Alpha",exact:true})).toBeVisible();
  await attention.getByRole("button",{name:"View topic",exact:true}).click();
  await expect(page.getByRole("tab",{name:"Wiki",exact:true})).toHaveAttribute("aria-selected","true");
  await expect(panel.locator("#wiki-topic-failed-topic")).toBeFocused();
  await attention.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(attention).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {__topicRetries:string[]}).__topicRetries)).toEqual(["failed-topic"]);
  await panel.getByRole("navigation",{name:"Wiki notes",exact:true}).getByRole("button",{name:/Project Beta/}).click();
  await expect(panel.locator("#wiki-topic-published-topic")).toContainText("Published meeting details.");
  await page.screenshot({path:test.info().outputPath("wiki-failed-topic-retry.png"),animations:"disabled"});
});

test("graph data stays visible while frequent native progress updates refresh details", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await openWiki(page);
  await page.getByRole("tab",{name:"Wiki",exact:true}).click();
  await expect(page.getByRole("button",{name:"Project: Project Alpha",exact:true})).toBeVisible();
  const result=await page.evaluate(async()=>{
    const runtime=window as unknown as {desktopAPI:{workbench:{status:()=>Promise<WorkbenchStatus>;wiki:(request:Record<string,unknown>)=>Promise<import("../../packages/views/workbench/types").WikiState>}};__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void;emit:(name:string,payload:unknown)=>void}};
    const value=await runtime.desktopAPI.workbench.wiki({action:"state"});const status=await runtime.desktopAPI.workbench.status();
    let reads=0;let lostData=false;const pending:Promise<unknown>[]=[];
    runtime.__LYNSE_E2E__.setCommand("workbench_wiki",()=>{reads++;const request=new Promise(resolve=>setTimeout(()=>resolve(structuredClone(value)),180));pending.push(request);return request;});
    const observer=new MutationObserver(()=>{if(!document.querySelector('[aria-label="Project: Project Alpha"]'))lostData=true;});observer.observe(document.body,{childList:true,subtree:true});
    for(let i=0;i<8;i++){runtime.__LYNSE_E2E__.emit("workbench-updated",{...status,updatedAt:`refresh-${i}`});await new Promise(resolve=>setTimeout(resolve,80));}
    await Promise.all(pending);await new Promise(resolve=>setTimeout(resolve,50));observer.disconnect();return {reads,lostData};
  });
  expect(result.lostData).toBe(false);
  expect(result.reads).toBeLessThanOrEqual(5);
  await expect(page.getByRole("button",{name:"Project: Project Alpha",exact:true})).toBeVisible();
});

test("Gmail connects as a plugin in Connections; Wiki only selects its source and embedding model", async ({page,mockServer}) => {
  await page.addInitScript(() => localStorage.setItem("lynse_plugins_state", JSON.stringify({"lynse.gmail":{installedAt:1,enabled:true}})));
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  const config = await settings(page);
  await config.getByRole("switch", {name:"Enable Wiki",exact:true}).click();
  await config.getByText("Wiki models",{exact:true}).click();
  await expect(config.getByText(/Lynclaw/).first()).toBeVisible();
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
  const source = config.getByRole("switch",{name:"Use connected Gmail in Wiki",exact:true});
  await expect(source).toBeEnabled();
  await source.click();
  await expect(source).toBeChecked();
  await config.getByText("Wiki models",{exact:true}).click();
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


test("Wiki combines its note sidebar, reader and linked graph across window sizes", async ({page,mockServer}) => {
  await page.setViewportSize({width:1680,height:1050});
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await page.evaluate(async()=>{
    const runtime=window as unknown as {desktopAPI:{workbench:{configure:(enabled:boolean,allowAi:boolean)=>Promise<unknown>;sync:()=>Promise<void>;status:()=>Promise<WorkbenchStatus>;wiki:(request:Record<string,unknown>)=>Promise<import("../../packages/views/workbench/types").WikiState>}};__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void}};
    const api=runtime.desktopAPI.workbench;await api.configure(true,true);await api.sync();
    const value=await api.wiki({action:"state"});const status=await api.status();
    const ref=value.graph!.nodes.find(node=>node.kind==="source")!.source!;
    const page={id:"reviewed-page",markdown:"# 灵光记\n\n## 当前进展\n\n已经确认的项目进展与会议依据。",citations:[ref],fingerprint:"f",createdAt:"",reviewedAt:"",review:"approved"};
    value.topics=[{id:"canonical-topic",mergedIds:["old-duplicate"],title:"灵光记",purpose:"追踪项目状态",notes:"",pinned:false,excluded:false,stale:false,error:"",candidate:null,published:page}];
    value.graph!.nodes.find(node=>node.kind==="wiki")!.wikiId="old-duplicate";
    value.graph!.nodes.find(node=>node.kind==="wiki")!.title="灵光记";value.graph!.nodes.find(node=>node.kind==="wiki")!.id="wiki:canonical-topic";for(const edge of value.graph!.edges){if(edge.source==="wiki:topic-1")edge.source="wiki:canonical-topic";if(edge.target==="wiki:topic-1")edge.target="wiki:canonical-topic";}
    value.graph!.nodes.find(node=>node.kind==="project")!.title="A very long named project with several milestones and responsibilities ".repeat(3);
    runtime.__LYNSE_E2E__.setCommand("workbench_wiki",()=>structuredClone(value));runtime.__LYNSE_E2E__.setCommand("workbench_bind",()=>structuredClone(status));
  });
  await openWiki(page);
  const panel=page.getByRole("tabpanel",{name:"Wiki",exact:true});
  const sidebar=panel.getByRole("navigation",{name:"Wiki notes",exact:true});
  const reader=panel.getByRole("region",{name:"Note content",exact:true});
  const graph=panel.getByRole("complementary",{name:"Knowledge graph panel",exact:true});
  await expect(page.getByRole("tab",{name:"Knowledge graph",exact:true})).toHaveCount(0);
  await expect(sidebar.getByRole("button",{name:"灵光记 Published",exact:true})).toHaveCount(1);
  await expect(reader.getByRole("heading",{name:"当前进展",exact:true})).toBeVisible();
  const initial=await reader.boundingBox();const graphBox=await graph.boundingBox();
  expect(initial!.x+initial!.width).toBeLessThanOrEqual(graphBox!.x+1);
  const resize=panel.getByRole("separator",{name:"Resize note and graph panels",exact:true});
  await resize.focus();await page.keyboard.press("ArrowRight");
  expect((await reader.boundingBox())!.width).toBeGreaterThan(initial!.width);
  await graph.getByRole("button",{name:"Wiki page: 灵光记",exact:true}).click();
  await expect(reader.locator("#wiki-topic-canonical-topic")).toBeVisible();
  await graph.getByRole("button",{name:"Source: Project Alpha · 1995",exact:true}).click();
  await expect(reader.getByRole("article",{name:"Meeting note",exact:true})).toContainText("Friday is only a proposal.");
  await expect(page.getByRole("dialog",{name:"Meeting Wiki",exact:true})).toHaveCount(0);
  await sidebar.getByRole("button",{name:"灵光记 Published",exact:true}).click();
  await expect(reader.getByRole("heading",{name:"当前进展",exact:true})).toBeVisible();
  await sidebar.getByRole("textbox",{name:"Search topics or notes",exact:true}).fill("灵光记");
  await expect(sidebar.getByRole("button")).toHaveCount(1);
  await sidebar.getByRole("textbox",{name:"Search topics or notes",exact:true}).fill("");
  await page.screenshot({path:test.info().outputPath("wiki-linked-workspace.png"),animations:"disabled"});
  for(const width of [1280,960,690,560]){
    await page.setViewportSize({width,height:1000});
    await expect(reader).toBeVisible();await expect(graph).toBeVisible();
    expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  }
  await page.setViewportSize({width:1680,height:1050});
  await page.evaluate(()=>{document.documentElement.style.zoom="2";});
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.evaluate(()=>{document.documentElement.style.zoom="";document.documentElement.dir="rtl";});
  await expect.poll(async()=> (await reader.boundingBox())!.x > (await graph.boundingBox())!.x).toBe(true);
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.evaluate(async(url)=>{document.documentElement.dir="ltr";await (await import(url)).changeLanguage("zh-Hans");},`/@fs${resolve(__dirname,"../../packages/core/i18n/react.ts")}`);
  await expect(panel.getByRole("navigation",{name:"Wiki 笔记",exact:true})).toBeVisible();
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:test.info().outputPath("wiki-linked-workspace-zh.png"),animations:"disabled"});
});

test("particle graph rotates with a hand cursor, bounds visible data and rests after interaction", async ({page,mockServer}) => {
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  await openWorkspace(page,mockServer.url);
  await installWorkbench(page);
  await page.evaluate(async()=>{
    const runtime=window as unknown as {desktopAPI:{workbench:{configure:(enabled:boolean,allowAi:boolean)=>Promise<unknown>;sync:()=>Promise<void>;wiki:(request:Record<string,unknown>)=>Promise<import("../../packages/views/workbench/types").WikiState>}};__LYNSE_E2E__:{setCommand:(name:string,handler:(args:Record<string,unknown>)=>unknown)=>void}};
    const api=runtime.desktopAPI.workbench;await api.configure(true,true);await api.sync();
    const state=await api.wiki({action:"state"});
    const base=state.graph!.nodes[0]!;
    state.graph!.nodes=Array.from({length:140},(_,i)=>({...base,id:`particle-${i}`,title:`Particle ${String(i).padStart(3,"0")}`,kind:"topic",status:"active",updates:[]}));
    state.graph!.edges=state.graph!.nodes.flatMap((node,i)=>[1,4,11].map(offset=>({id:`${i}:${offset}`,source:node.id,target:`particle-${(i+offset)%140}`,kind:"related"})));
    runtime.__LYNSE_E2E__.setCommand("workbench_wiki",()=>structuredClone(state));
  });
  await openWiki(page);
  const graph=page.getByRole("group",{name:"Knowledge graph canvas",exact:true});
  await graph.scrollIntoViewIfNeeded();
  await expect(graph.getByRole("button")).toHaveCount(90);
  await expect(page.locator("[data-graph-browse] button")).toHaveCount(0);
  expect(await graph.locator("line").count()).toBeLessThanOrEqual(540);
  await expect(graph.locator("text")).toHaveCount(0);
  await expect(graph).toHaveCSS("cursor","grab");
  const node=graph.getByRole("button",{name:"Topic: Particle 000",exact:true});
  const initial=await node.getAttribute("transform");
  const box=(await graph.boundingBox())!;
  await page.mouse.move(box.x+8,box.y+box.height-16);
  await page.mouse.down();
  await expect(graph).toHaveCSS("cursor","grabbing");
  await page.mouse.move(box.x+108,box.y+box.height-66,{steps:10});
  await page.mouse.up();
  await expect(graph).toHaveCSS("cursor","grab");
  await expect(node).not.toHaveAttribute("transform",initial!);
  await expect(node).toHaveAttribute("aria-pressed","false");
  const resting=await graph.evaluate(async element=>{
    let changes=0;
    const observer=new MutationObserver(records=>{changes+=records.length;});
    observer.observe(element,{subtree:true,attributes:true,attributeFilter:["transform","x1","y1","x2","y2"]});
    await new Promise(resolve=>setTimeout(resolve,350));observer.disconnect();return changes;
  });
  expect(resting).toBe(0);
  await graph.focus();
  const rotated=await node.getAttribute("transform");
  await page.keyboard.press("ArrowRight");
  await expect(node).not.toHaveAttribute("transform",rotated!);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();
  await expect(node).toHaveAttribute("transform",initial!);
  const zoomed=await node.getAttribute("transform");
  await graph.hover({position:{x:8,y:box.height-16}});
  await page.mouse.wheel(0,-80);
  await expect(node).not.toHaveAttribute("transform",zoomed!);
  await page.getByRole("button",{name:"Reset view",exact:true}).click();
  await node.click();
  await expect(node).toHaveAttribute("aria-pressed","true");
  await expect(page.getByRole("region",{name:"Note content",exact:true}).getByRole("heading",{name:"Particle 000",exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("particle-knowledge-graph.png"),animations:"disabled"});
  await page.getByText("Browse all 140 matching nodes",{exact:true}).click();
  await expect(page.locator("[data-graph-browse] button")).toHaveCount(140);
  await page.locator("[data-graph-browse]").getByRole("button",{name:/Particle 139/}).click();
  await expect(graph.getByRole("button",{name:"Topic: Particle 139",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(graph.getByRole("button")).toHaveCount(90);
  await expect(page.getByRole("region",{name:"Note content",exact:true}).getByRole("heading",{name:"Particle 139",exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test("normal sync fills missing files and cloud refresh is an explicit action", async ({page,mockServer}) => {
  await openWorkspace(page,mockServer.url);await installWorkbench(page);
  const config=await settings(page);
  await config.getByRole("switch",{name:"Enable Wiki",exact:true}).click();
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
