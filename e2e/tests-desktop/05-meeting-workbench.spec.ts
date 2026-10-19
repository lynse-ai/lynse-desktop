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
    let serial=1;
    const publish=()=>{status.updatedAt=String(++serial);hook.emit("workbench-updated",status);};
    hook.setCommand("workbench_status",()=>status);
    hook.setCommand("workbench_configure",(args)=>{status.enabled=!!args.enabled;status.allowAi=!!args.allowAi;status.phase=status.enabled?"incomplete":"disabled";publish();return status;});
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
  const enable=config.getByRole("switch",{name:"Build memory from my knowledge base",exact:true});
  await expect(enable).not.toBeChecked();await enable.click();
  await expect(config.getByRole("switch",{name:"Allow AI processing of eligible text",exact:true})).not.toBeChecked();
  await config.getByRole("switch",{name:"Allow AI processing of eligible text",exact:true}).click();
  await config.getByRole("button",{name:"Open knowledge base & memory",exact:true}).click();
  const reader=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"Meeting memory",exact:true})});
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
  await config.getByRole("button",{name:"Open knowledge base & memory",exact:true}).click();
  await reader.getByRole("textbox",{name:"Search a project, topic or meeting"}).fill("Alpha");
  await reader.getByRole("button",{name:"Prepare meeting brief",exact:true}).click();
  await expect(reader.getByRole("heading",{name:"Questions",exact:true})).toBeVisible();
  await expect(reader.getByText("Friday remains a proposal",{exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("workbench-brief.png"),animations:"disabled"});
});
