import { resolve } from "node:path";
import { completeOAuth } from "../fixtures/integrations-mock";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

// Native durability and pagination are exercised by Rust tests. This fixture
// checks the real renderer's consent, incomplete-sync and review interactions.
async function installWorkbench(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const hook = (window as unknown as { __LYNSE_E2E__: {setCommand: (name: string, handler: (args: Record<string, unknown>) => unknown) => void; emit: (name: string, payload: unknown) => void} }).__LYNSE_E2E__;
    const reference = {id:"meeting-1995",kind:"meeting",revision:"r1",quote:"Friday is only a proposal.",startMs:12000};
    const status = {scope:"synthetic-account",userId:"user-e2e",enabled:false,allowAi:false,initialComplete:false,phase:"disabled",updatedAt:"1",error:"",discovered:2,synced:1,awaitingTranscription:0,failed:1,conflicts:0,
      entries:[{id:"meeting-1995",kind:"meeting",title:"Project Alpha · 1995",revision:"r1",status:"synced",excluded:false,error:""},{id:"meeting-2026",kind:"meeting",title:"Project Alpha · 2026",revision:"r2",status:"failed",excluded:false,error:"Network unavailable"}],
      memories:[{id:"memory-1",sourceId:"meeting-1995",sourceTitle:"Project Alpha",kind:"proposal",text:"Friday remains a proposal",citations:[reference]}]};
    const record = {document:{id:"meeting-1995",kind:"meeting",title:"Project Alpha · 1995",revision:"r1",transcript:reference.quote,outline:"Review the deadline",segments:[{id:"s1",text:reference.quote,startMs:12000,speakerName:"Sam"}],conclusions:[{id:"v1",templateName:"Original summary",conclusionText:"No final date was agreed."},{id:"v2",templateName:"Updated summary",conclusionText:"The team still needs to confirm."}],todos:[],aiContextEnabled:true},markdown:"# Project Alpha",artifacts:{summaries:[],todoSuggestions:[{id:"suggestion-1",title:"Confirm the launch date",citations:[reference],accepted:false}]}};
    const vault={enabled:false,path:"/tmp/lynse-e2e-vault"};
    const wiki={topics:[] as {id:string;title:string;purpose:string;notes:string;pinned:boolean;excluded:boolean;stale:boolean;error:string;candidate:{id:string;markdown:string;citations:typeof reference[]}|null;published:{id:string;markdown:string;citations:typeof reference[]}|null}[],models:{embedding:{baseUrl:"",model:""},revision:""},sources:{gmailEnabled:false,gmailAccountId:"",integrationsUrl:""}};
    hook.setCommand("vault_config_get",()=>structuredClone(vault));
    hook.setCommand("vault_default_path",()=>"/tmp/lynse-e2e-vault");
    hook.setCommand("vault_config_save",(args)=>{Object.assign(vault,args.config);if(!vault.enabled){status.enabled=false;status.initialComplete=false;status.phase="disabled";publish();}return structuredClone(vault);});
    hook.setCommand("workbench_wiki",(args)=>{const request=args.request as Record<string,unknown>;
      if(request.action==="sources")Object.assign(wiki.sources, request.sources);
      if(request.action==="models")Object.assign(wiki.models, request.models);
      if(request.action==="topic"){const item=wiki.topics.find(t=>t.id===request.id);if(item)Object.assign(item,request);else wiki.topics.push({id:"topic-1",title:String(request.title),purpose:String(request.purpose),notes:"",pinned:false,excluded:false,stale:false,error:"",published:null,candidate:status.initialComplete?{id:"candidate-1",markdown:"## Candidate\n\nFriday remains a proposal.",citations:[reference]}:null});}
      if(request.action==="review"){if(!status.initialComplete||!status.allowAi)throw new Error("Sync incomplete");const topic=wiki.topics[0]!;if(request.approve)topic.published={...topic.candidate!,markdown:String(request.markdown??topic.candidate?.markdown)};topic.candidate=null;}
      if(request.action!=="state")publish();
      return structuredClone(wiki);
    });
    let serial=1;
    const publish=()=>{status.updatedAt=String(++serial);hook.emit("workbench-updated",structuredClone(status));};
    hook.setCommand("workbench_status",()=>structuredClone(status));
    hook.setCommand("workbench_configure",(args)=>{status.enabled=!!args.enabled;if(status.enabled)vault.enabled=true;status.allowAi=!!args.allowAi;status.phase=status.enabled?"incomplete":"disabled";publish();return structuredClone(status);});
    hook.setCommand("workbench_search",()=>({items:[{id:"meeting-1995",title:"Project Alpha · 1995",kind:"meeting",excerpt:reference.quote,source:reference}],initialComplete:status.initialComplete}));
    hook.setCommand("workbench_read",()=>record);
    hook.setCommand("workbench_confirm_todos",()=>{record.artifacts.todoSuggestions[0]!.accepted=true;publish();return [{id:"stable-confirmed-task"}];});
    hook.setCommand("workbench_sync",()=>{status.initialComplete=true;status.failed=0;status.synced=2;status.phase="ready";publish();});
    hook.setCommand("workbench_review",()=>({summary:"## Questions\n\nConfirm the launch date.",memoryItems:[{id:"brief-1",text:"Friday remains a proposal",kind:"proposal",citations:[reference]}],todoSuggestions:[],citations:[reference],insufficientEvidence:false}));
    hook.setCommand("workbench_clear",()=>{status.enabled=false;status.allowAi=false;status.memories=[];status.phase="disabled";publish();});
    publish();
  });
}

async function settings(page: import("@playwright/test").Page) {
  await page.getByRole("button", {name:"E2",exact:true}).click();
  await page.getByRole("menuitem", {name:"Settings",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await dialog.getByRole("button",{name:"Notes Sync",exact:true}).click();
  return dialog;
}

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
  await page.evaluate(async (url) => {
    const flags = await import(url);
    flags.configureBuildChannel("official");
    flags.setTestMode(false);
  }, `/@fs${resolve(__dirname, "../../packages/views/feature-flags.ts")}`);
  const config = await settings(page);
  await expect(config.getByRole("switch", {name:"Enable Wiki",exact:true})).toHaveCount(0);
  await expect(config.getByRole("button", {name:"Open knowledge base & Wiki",exact:true})).toHaveCount(0);
  await expect(config.locator("#vault-enable")).toBeVisible();
  await page.evaluate(async (url) => { (await import(url)).setTestMode(true); }, `/@fs${resolve(__dirname, "../../packages/views/feature-flags.ts")}`);
  await expect(config.getByRole("switch", {name:"Enable Wiki",exact:true})).toBeVisible();
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
  await config.getByRole("button",{name:/^Connections/}).click();
  const gmail = config.getByRole("region",{name:"Gmail",exact:true});
  await gmail.getByRole("button",{name:"Connect",exact:true}).click();
  await expect.poll(() => mockServer.integrations.pendingOAuth.size).toBeGreaterThan(0);
  const [state] = [...mockServer.integrations.pendingOAuth.keys()];
  completeOAuth(mockServer.integrations,state!);
  await expect(gmail.getByText("Connected",{exact:true})).toBeVisible({timeout:20000});
  await expect(gmail.getByText("Sync",{exact:true})).toHaveCount(0);
  await config.getByRole("button",{name:"Notes Sync",exact:true}).click();
  const source = config.getByRole("switch",{name:"Use connected Gmail in Wiki",exact:true});
  await expect(source).toBeEnabled();
  await source.click();
  await expect(source).toBeChecked();
  await config.getByText("Wiki models",{exact:true}).click();
  await page.screenshot({path:test.info().outputPath("wiki-model-and-source.png"),animations:"disabled"});
  await config.getByRole("button",{name:/^Connections/}).click();
  await gmail.getByRole("button",{name:"Disconnect",exact:true}).click();
  await page.getByRole("dialog").last().getByRole("button",{name:"Disconnect",exact:true}).click();
  await expect(gmail.getByRole("button",{name:"Connect",exact:true})).toBeVisible();
  await config.getByRole("button",{name:"Notes Sync",exact:true}).click();
  await expect(source).not.toBeChecked();
  await expect(source).toBeDisabled();
});
