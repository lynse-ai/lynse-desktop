import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { WikiState, WikiTopic, WorkbenchStatus, WikiAutomationConfig } from "../../packages/views/workbench/types";

export async function installAutomaticWiki(page: Page, enabled = true, seed?: Partial<WikiState>) {
  await page.evaluate(async ({enabled, seed}) => {
    const runtime = window as unknown as { __LYNSE_E2E__: { setCommand: (name:string, handler:(args:Record<string,unknown>)=>unknown)=>void;emit:(name:string,value:unknown)=>void };
      wikiTest: {configure:Record<string,unknown>[];requests:Record<string,unknown>[];failNextRetry?:boolean;patch:(status:Partial<WorkbenchStatus>,wiki?:Partial<WikiState>)=>void} };
    const hook=runtime.__LYNSE_E2E__;
    const previous=await (window as unknown as {desktopAPI:{workbench:{status:()=>Promise<WorkbenchStatus>}}}).desktopAPI.workbench.status();
    const source={id:"meeting-1",kind:"meeting_summary",revision:"r1",quote:"灵光记项目完成原型，客户反馈仍需整理。"};
    const topics = ["灵光记项目","客户反馈","产品规划","团队协作","市场研究","技术架构"].map((title,index)=>({
      id:`topic-${index+1}`,title,purpose:"",notes:"",candidate:null,pinned:false,excluded:false,stale:false,error:"",inScope:true,topicKind:index===0?"project" as const:"topic" as const,sourceIds:[source.id],
      published:{id:`version-${index+1}`,markdown:`# ${title}\n\n## 当前情况\n\n灵光记项目已经完成原型，正在整理客户反馈。\n\n## 重要变化\n\n本周完成了第一轮原型评审。\n\n## 未解决问题\n\n客户反馈仍需整理。`,overview:"已完成产品原型，正在收集客户反馈，准备下一轮迭代。",review:"auto_validated",fingerprint:"fixture",reviewedAt:"",createdAt:"2026-10-23T03:00:00Z",citations:[source],changes:[{id:`change-${index+1}`,text:index===0?"产品原型完成，开始收集客户反馈。":"整理了新的会议内容。",createdAt:"2026-10-23T03:00:00Z",citations:[source]}]},
      history:[{id:`old-${index+1}`,markdown:"## 历史情况\n\n仍在准备原型。",review:"approved",fingerprint:"fixture",reviewedAt:"2026-10-20",createdAt:"2026-10-20T03:00:00Z",citations:[source]}]
    }));
    const status:WorkbenchStatus={scope:previous.scope,userId:"user-e2e",enabled,allowAi:enabled,initialComplete:enabled,wikiProgress:enabled?{stage:"complete",completed:6,total:6,failed:0,currentTitle:"",topicTitle:""}:null,phase:enabled?"ready":"disabled",updatedAt:"1",error:"",discovered:1,synced:1,awaitingTranscription:0,failed:0,conflicts:0,memories:[],automation:enabled?{folderIds:["folder-work"],includeUnfiled:false}:null,entries:[{id:source.id,title:"产品周会 · 10月23日",kind:"meeting",revision:"r1",excluded:false,status:"synced",error:""}]};
    const wiki:WikiState={topics:enabled?topics:[],models:{embedding:{baseUrl:"",model:""}},sources:{gmailEnabled:false,gmailAccountId:"",integrationsUrl:""},topicGraph:{automaticTracking:true,nodes:[],edges:topics.slice(1).map((topic,index)=>({id:`edge-${index}`,source:"wiki:topic-1",target:`wiki:${topic.id}`,kind:"shared_source"})),tracking:{processing:false,total:6,completed:6,failed:0,error:""}},graph:{automaticTracking:true,nodes:[{id:"person-1",kind:"entity",subtype:"person",title:"小林",description:"参与了本周产品讨论。",status:"unknown",citations:[source],updates:[]}],edges:[],tracking:{processing:false,total:1,completed:1,failed:0,error:""}},...seed};
    let serial=1;
    function publish() {status.updatedAt=String(++serial);hook.emit("workbench-updated",structuredClone(status));}
    runtime.wikiTest={configure:[],requests:[],patch:(patch,changes)=>{Object.assign(status,patch);if(changes)Object.assign(wiki,changes);publish();}};
    let policy={enrolled:enabled,range_version:1,grant_version:1,processing_version:1,folder_ids:enabled?["folder-work"]:[],include_unfiled:false,excluded_source_ids:[],memory_consent:false,local_text_consent:false,chat_consent:false,email_consent:false,notifications_consent:false,extraction_paused:true,projections_enabled:false,timezone:"Asia/Shanghai"};
    hook.setCommand("workbench_knowledge_policy",args=>{
      const request=args.request as {action:string;policy?:Partial<typeof policy>};
      if(request.action==="read")return {capabilities:{available:true,user_id:"user-e2e",protocol_version:4,features:{shared_scope:true,memory_management:true},projections:true,todo_four_states:false,policy:structuredClone(policy)},pending:false};
      policy={...policy,...request.policy,range_version:policy.range_version+1,grant_version:policy.grant_version+1,processing_version:policy.processing_version+1};
      return {policy:structuredClone(policy),pending:false};
    });
    hook.setCommand("vault_config_get",()=>({enabled:true,path:"/tmp/wiki-automatic"}));
    hook.setCommand("workbench_bind",()=>structuredClone(status)); hook.setCommand("workbench_status",()=>structuredClone(status));
    hook.setCommand("workbench_configure",args=>{runtime.wikiTest.configure.push(structuredClone(args));status.enabled=!!args.enabled;status.allowAi=!!args.allowAi;
      if(args.automation)status.automation=args.automation as WikiAutomationConfig;
      status.initialComplete=status.enabled;status.phase=status.enabled?"ready":"disabled";status.wikiProgress=status.enabled?{stage:"complete",completed:6,total:6,failed:0,currentTitle:"",topicTitle:""}:null;
      if(status.enabled)wiki.topics=status.automation?.folderIds.includes("folder-work")?topics:[];
      publish();return structuredClone(status);});
    hook.setCommand("workbench_wiki",args=>{const request=args.request as Record<string,unknown>;runtime.wikiTest.requests.push(structuredClone(request));
      if(request.action==="correction"){const topic=wiki.topics.find(topic=>topic.id===request.id);if(topic)topic.notes=String(request.notes);publish();}
      if(request.action==="retry"){
        if(runtime.wikiTest.failNextRetry){runtime.wikiTest.failNextRetry=false;throw new Error("Synthetic retry rejected");}
        wiki.topics.filter(topic=>!request.id||topic.id===request.id).forEach(topic=>{topic.error="";topic.failure=null;topic.stale=false;
          if(!topic.published)topic.published={...structuredClone(topics[0]!.published),id:`retry-${topic.id}`,markdown:`# ${topic.title}\n\nRetry completed.`};
        });
      }
      if(request.action==="topic_link") {
        const topic=wiki.topics.find(topic=>topic.id===request.id);
        if(topic?.collection) {
          const existing=topic.collection.links.find(link=>link.targetId===request.targetId);
          if(existing){existing.state=request.state as "included"|"excluded";existing.manual=true;}
          else topic.collection.links.push({targetId:String(request.targetId),state:request.state as "included"|"excluded",manual:true,reason:"",citations:[],events:[],fingerprint:"",error:""});
          publish();
        }
      }
      if(request.action==="topic"){
        wiki.createdTopicId=null;
        if(!request.id && request.mode==="collection") {
          const created:WikiTopic={id:`manual-${serial}`,title:String(request.title),purpose:String(request.purpose),notes:"",candidate:null,published:null,pinned:false,excluded:false,stale:false,error:"",inScope:true,collection:{links:[],status:"pending",completed:0,total:wiki.topics.length}};
          wiki.topics.push(created);wiki.createdTopicId=created.id;
        }
        const topic=wiki.topics.find(topic=>topic.id===request.id);
        if(topic){wiki.createdTopicId=topic.id;Object.assign(topic,{title:request.title,purpose:request.purpose,notes:request.notes??topic.notes});
          if(typeof request.excluded==="boolean"){topic.excluded=request.excluded;topic.error="";topic.failure=null;}
          if(typeof request.pinned==="boolean")topic.pinned=request.pinned;
        }
      }
      if(request.action==="retry"||request.action==="topic"){
        const active=wiki.topics.filter(topic=>!topic.excluded);const failed=active.filter(topic=>!!topic.error).length;
        status.error=failed?`Wiki processing failed for ${failed} topics; open Wiki to review and retry`:"";
        status.wikiProgress={stage:"complete",completed:active.length-failed,total:active.length,failed,currentTitle:"",topicTitle:""};publish();
      }
      return structuredClone(wiki);});
    hook.setCommand("workbench_read",()=>({document:{id:source.id,title:status.entries[0]!.title,kind:"meeting",revision:"r1",transcript:"TRANSCRIPT_ONLY",outline:"",segments:[],conclusions:[{id:"summary-1",templateName:"会议总结",conclusionText:source.quote}],todos:[],aiContextEnabled:true},markdown:"# 会议\n\nTRANSCRIPT_ONLY",artifacts:{summaries:[],todoSuggestions:[]}}));
    publish();
  },{enabled,seed});
  await page.evaluate(async url=>{await (await import(url)).refreshWorkbench();},`/@fs${resolve(__dirname,"../../packages/views/workbench/api.ts")}`);
}
export async function openWiki(page:Page) {
  await page.locator(".lyse-sidebar").getByRole("button",{name:/^(More|更多)$/,exact:true}).click();
  await page.getByRole("dialog",{name:/^(More|更多)$/,exact:true}).getByRole("button",{name:/^(Knowledge base|知识库)$/,exact:true}).click();
}
