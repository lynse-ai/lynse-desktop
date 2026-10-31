import { readFileSync } from "node:fs";
import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";
import { installAutomaticWiki,openWiki } from "../fixtures/wiki-automatic";
import type { WikiState,WorkbenchReadResult } from "../../packages/views/workbench/types";

// The runner uses real local HTTP validation and Rust storage, with synthetic identity/model.
test("local Lynclaw catalog and compiler produce a readable native Wiki with summary evidence",async({page,mockServer})=>{
  const artifact=process.env.LYNSE_WIKI_LOCAL_RESULT;
  test.skip(!artifact,"Run pnpm test:graph:local for loopback service, native validation and renderer");
  const result=JSON.parse(readFileSync(artifact!,"utf8")) as WikiState & {record:WorkbenchReadResult};
  await openWorkspace(page,mockServer.url);await installAutomaticWiki(page,true,result);
  await page.evaluate(record=>{
    const runtime=window as unknown as {__LYNSE_E2E__:{setCommand:(name:string,handler:()=>unknown)=>void};wikiTest:{patch:(status:Record<string,unknown>)=>void}};
    runtime.__LYNSE_E2E__.setCommand("workbench_read",()=>record);
    runtime.wikiTest.patch({entries:[{id:record.document.id,title:record.document.title,kind:"meeting",revision:record.document.revision,status:"synced",excluded:false,error:""}]});
  },result.record);
  await openWiki(page);
  await expect(page.getByText("Processing usage",{exact:true})).toHaveCount(0);
  await page.getByRole("group",{name:"Knowledge graph canvas",exact:true}).getByRole("button",{name:"A项目",exact:true}).click();
  await page.getByRole("button",{name:"Read full topic",exact:true}).click();
  await expect(page.getByRole("heading",{name:"未解决问题",exact:true})).toBeVisible();
  await expect(page.getByText("AI organized · sources verified",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:result.record.document.title,exact:true}).click();
  const source=page.getByRole("dialog",{name:"Source meetings",exact:true});
  await expect(source).toContainText("zhang@example.com");await expect(source).toContainText("Quoted from a meeting summary");
  await expect(source).not.toContainText("TRANSCRIPT_ONLY");await expect(source.locator("audio")).toHaveCount(0);
  await page.screenshot({path:test.info().outputPath("wiki-local-http-evidence.png"),animations:"disabled"});
});
