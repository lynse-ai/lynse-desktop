import { describe, expect, it } from "vitest";
import { browsingGraph, browsableTopics, topicChanges, topicDetails } from "./wiki-browse";
import { useWikiBrowser } from "./wiki-browser-state";
import type { WikiTopic, KnowledgeGraph } from "./types";
const topic = (id: string, patch: Partial<WikiTopic> = {}): WikiTopic => ({ id, title: "同名项目", purpose: "", notes: "人工补充", candidate:null, pinned: false, excluded: false, stale: false, error: "", published: { id:"v1",markdown:"正文",citations:[{id:"meeting",kind:"meeting_summary",revision:"r1",quote:"证据"}],review:"auto_validated",fingerprint:"fixture",reviewedAt:"",createdAt:"2026-10-23", changes:[{id:"change",text:"发生变化",createdAt:"2026-10-23",citations:[]}] }, ...patch });
describe("Wiki browsing", () => {
  it("keeps stable same-name topics separate and hides drafts, excluded and out-of-range topics", () => {
    const topics = [topic("a"),topic("b"),topic("out",{inScope:false}),topic("excluded",{excluded:true}),topic("draft",{published:null})];
    expect(browsableTopics(topics).map(topic => topic.id)).toEqual(["a","b"]);
    const graph = browsingGraph(topics, {edges:[{id:"valid",source:"wiki:a",target:"wiki:b",kind:"shared_source"},{id:"invalid",source:"wiki:a",target:"wiki:out",kind:"related"}]} as KnowledgeGraph);
    expect(graph.nodes).toHaveLength(2); expect(graph.edges.map(edge=>edge.id)).toEqual(["valid"]);
  });
  it("shows unique changes only from confirmed or automatically validated history", () => {
    const current=topic("a"); current.history=[{...current.published!,id:"v0"},{...current.published!,id:"draft",review:"",changes:[{id:"bad",text:"未确认",createdAt:"2026-10-24",citations:[]}]}];
    expect(topicChanges(current).map(change=>change.id)).toEqual(["change"]);
  });
  it("discloses details from shared sources without treating co-occurrence as a business relation", () => {
    const graph={nodes:[{id:"person",kind:"entity",subtype:"person",citations:topic("a").published!.citations},{id:"outside",kind:"event",subtype:"task",citations:[{id:"other"}]}]} as KnowledgeGraph;
    expect(topicDetails(topic("a"),graph).map(node=>node.id)).toEqual(["person"]);
  });
  it("restores selection and camera within an account and clears them across account changes", () => {
    const state=useWikiBrowser.getState(); state.setScope("one"); state.update({selectedId:"a",search:"预算",previewOpen:true,camera:{scale:1.4,x:30,y:15,yaw:0,pitch:0}});
    state.setScope("one"); expect(useWikiBrowser.getState().browse.selectedId).toBe("a");
    expect(useWikiBrowser.getState().browse.previewOpen).toBe(true);
    state.setScope("two"); expect(useWikiBrowser.getState().browse).toEqual({selectedId:null,search:"",previewOpen:false});
  });
});

describe("Manual topic timeline", () => {
  it("shows an unpublished manual topic in the directory and waits for publication in the graph", () => {
    const manual=topic("manual",{published:null,collection:{links:[],status:"pending",completed:0,total:0}});
    expect(browsableTopics([manual])).toHaveLength(1);
    expect(browsingGraph([manual]).nodes).toHaveLength(0);
  });
  it("sorts event dates newest first, groups undated items last, and combines repeated evidence", async () => {
    const {collectionTimeline}=await import("./wiki-browse");
    const manual=topic("manual",{collection:{status:"ready",completed:2,total:2,links:[
      {targetId:"a",state:"included",manual:false,reason:"",citations:[],fingerprint:"",error:"",events:[
        {id:"older",text:"Proposed, still unapproved",date:"2026-10-01",dateBasis:"event",citations:[]},
        {id:"unknown",text:"Date missing",date:"",dateBasis:"unknown",citations:[]},
        {id:"new",text:"Progress",date:"2026-10-25",dateBasis:"record",citations:topic("a").published!.citations}]},
      {targetId:"b",state:"included",manual:true,reason:"",citations:[],fingerprint:"",error:"",events:[{id:"same",text:"Progress",date:"2026-10-25",dateBasis:"record",citations:[{...topic("b").published!.citations[0]!,id:"another"}]}]},
      {targetId:"excluded",state:"excluded",manual:true,reason:"",citations:[],fingerprint:"",error:"",events:[{id:"hidden",text:"Excluded",date:"2026-10-26",dateBasis:"event",citations:[]}]}
    ]}});
    const events=collectionTimeline(manual);
    expect(events.map(event=>event.id)).toEqual(["new","older","unknown"]);
    expect(events[0]?.citations).toHaveLength(2);
    expect(events[0]?.dateBasis).toBe("record");
    expect(events[1]?.text).toContain("unapproved");
  });
});
